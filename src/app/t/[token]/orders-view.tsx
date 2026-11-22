"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { subscribeAuthed } from "@/lib/supabase/realtime";
import { friendlyError } from "@/lib/errors";
import { ORDER_STATUS_LABELS } from "@/lib/menu";

type Order = {
  id: string;
  order_number: string;
  status: string;
  subtotal: number;
  rejection_reason: string | null;
  clarification_question: string | null;
  clarification_answer: string | null;
  created_at: string;
  order_items: {
    id: string;
    item_name_snapshot: string;
    variation_name_snapshot: string | null;
    quantity: number;
    line_total: number;
    status: string;
    order_item_add_ons: { name_snapshot: string }[];
  }[];
};

const STEPS = ["Sent", "Confirmed", "Preparing", "Ready", "Served"];
const STEP_OF: Record<string, number> = {
  pending_confirmation: 0,
  confirmed: 1,
  sent_to_kitchen: 1,
  on_hold: 0,
  preparing: 2,
  partially_ready: 2,
  ready: 3,
  partially_served: 3,
  served: 4,
  completed: 4,
};

/** Loads the session's orders and keeps them live (FR-030). */
export function useSessionOrders(sessionId: string) {
  const [orders, setOrders] = useState<Order[] | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("orders")
      .select(
        "id, order_number, status, subtotal, rejection_reason, clarification_question, clarification_answer, created_at, order_items(id, item_name_snapshot, variation_name_snapshot, quantity, line_total, status, order_item_add_ons(name_snapshot))",
      )
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false });
    setOrders((data ?? []) as unknown as Order[]);
  }, [sessionId]);

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 50);
    };
    const unsubscribe = subscribeAuthed(supabase, `guest-orders:${sessionId}`, (ch) =>
      ch
        .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `session_id=eq.${sessionId}` }, refresh)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "order_items" }, refresh)
        .subscribe((status) => {
          if (status === "SUBSCRIBED") refresh(); // includes the first load and every reconnect
        }),
    );
    refresh(); // don't wait for the socket for the first load
    // Safety net when Realtime is unavailable (e.g. a phone that slept).
    const poll = setInterval(refresh, 20000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [sessionId, load]);

  return { orders, reload: load };
}

export function OrdersView({
  orders,
  reload,
  money,
  onOrderMore,
}: {
  orders: Order[] | null;
  reload: () => void;
  money: Intl.NumberFormat;
  onOrderMore: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  async function answer(id: string) {
    const text = (answers[id] ?? "").trim();
    if (!text) return;
    setBusy(id);
    setError(null);
    const { error } = await createClient().rpc("answer_order_clarification", { p_order_id: id, p_answer: text });
    if (error) setError(friendlyError(error));
    else setAnswers((a) => ({ ...a, [id]: "" }));
    setBusy(null);
    reload();
  }

  async function cancel(id: string) {
    if (!window.confirm("Cancel this order?")) return;
    setBusy(id);
    setError(null);
    const { error } = await createClient().rpc("cancel_pending_order", { p_order_id: id });
    if (error) setError(friendlyError(error));
    setBusy(null);
    reload();
  }

  if (orders === null) return <p className="py-8 text-center text-ink-soft">Loading your orders…</p>;
  if (orders.length === 0) {
    return (
      <div className="py-10 text-center">
        <p className="text-ink-soft">You haven&apos;t ordered yet.</p>
        <button onClick={onOrderMore} className="mt-3 text-brand underline">
          Browse the menu
        </button>
      </div>
    );
  }

  const live = orders.filter((o) => !["rejected", "cancelled"].includes(o.status));
  const total = live.reduce((s, o) => s + Number(o.subtotal), 0);

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {orders.map((o) => {
        const ended = o.status === "rejected" || o.status === "cancelled";
        const step = STEP_OF[o.status] ?? 0;
        return (
          <article key={o.id} className={`rounded-xl border border-line bg-surface p-4 ${ended ? "opacity-70" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{ORDER_STATUS_LABELS[o.status] ?? o.status}</p>
              <p className="font-mono text-xs text-ink-soft">{o.order_number}</p>
            </div>

            {!ended ? (
              <ol className="mt-3 grid grid-cols-5 gap-1" aria-label="Progress">
                {STEPS.map((s, i) => (
                  <li key={s} className="text-center">
                    <span className={`block h-1.5 rounded-full ${i <= step ? "bg-brand" : "bg-muted"}`} />
                    <span className={`mt-1 block text-[10px] ${i <= step ? "text-ink" : "text-ink-soft"}`}>{s}</span>
                  </li>
                ))}
              </ol>
            ) : (
              o.rejection_reason && <p className="mt-1 text-sm text-ink-soft">{o.rejection_reason}</p>
            )}

            {o.status === "on_hold" && o.clarification_question && (
              <form
                className="mt-3 rounded-lg bg-sky-50 p-3 text-sky-950 dark:bg-sky-950 dark:text-sky-100"
                onSubmit={(e) => {
                  e.preventDefault();
                  answer(o.id);
                }}
              >
                <p className="text-sm font-medium">Your waiter asks: “{o.clarification_question}”</p>
                <div className="mt-2 flex gap-2">
                  <input
                    value={answers[o.id] ?? ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [o.id]: e.target.value }))}
                    maxLength={500}
                    required
                    placeholder="Your answer"
                    aria-label="Your answer"
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                  />
                  <button disabled={busy === o.id} className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
                    Reply
                  </button>
                </div>
              </form>
            )}

            <ul className="mt-3 space-y-1 text-sm">
              {o.order_items.map((i) => (
                <li key={i.id} className="flex gap-2">
                  <span className="tabular-nums text-ink-soft">{i.quantity}×</span>
                  <span className="flex-1">
                    {i.item_name_snapshot}
                    {i.variation_name_snapshot && ` (${i.variation_name_snapshot})`}
                    {i.order_item_add_ons.length > 0 && (
                      <span className="text-ink-soft"> · {i.order_item_add_ons.map((a) => a.name_snapshot).join(", ")}</span>
                    )}
                    {!ended && ["ready", "served"].includes(i.status) && (
                      <span className="ml-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">{i.status === "ready" ? "Ready" : "Served"}</span>
                    )}
                  </span>
                  <span className="tabular-nums text-ink-soft">{money.format(Number(i.line_total))}</span>
                </li>
              ))}
            </ul>

            {(o.status === "pending_confirmation" || o.status === "on_hold") && (
              <button
                onClick={() => cancel(o.id)}
                disabled={busy === o.id}
                className="mt-3 text-sm text-ink-soft underline disabled:opacity-50"
              >
                {busy === o.id ? "Cancelling…" : "Cancel order"}
              </button>
            )}
          </article>
        );
      })}

      <div className="flex items-center justify-between rounded-xl bg-muted px-4 py-3 text-sm">
        <span>Ordered so far (before tax)</span>
        <span className="font-semibold tabular-nums">{money.format(total)}</span>
      </div>
    </div>
  );
}

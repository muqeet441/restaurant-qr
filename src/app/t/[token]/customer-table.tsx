"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { cartTotals, imageUrl, type CartLine, type MenuItem } from "@/lib/menu";
import type { JoinResult } from "@/lib/types";
import { btnPrimary } from "@/components/ui";
import { loadMenu, type MenuData } from "./load-menu";
import { ItemSheet } from "./item-sheet";
import { CartSheet } from "./cart-sheet";
import { OrdersView, useSessionOrders } from "./orders-view";
import { BillCard } from "./bill-card";
import { ServicePanel } from "./service-panel";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "waiting"; info: JoinResult }
  | { kind: "ended"; info: JoinResult }
  | { kind: "joined"; info: JoinResult & { session: NonNullable<JoinResult["session"]> } };

const WAIT_POLL_MS = 8000;

export function CustomerTable({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const join = useCallback(async () => {
    const supabase = createClient();
    // Customers never register: each device gets an anonymous Supabase user.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        setState({ kind: "error", message: "Could not start your visit. Please try again." });
        return;
      }
    }
    const { data, error } = await supabase.rpc("join_table_session", { p_qr_token: token });
    if (error) {
      setState({ kind: "error", message: friendlyError(error) });
      return;
    }
    const info = data as JoinResult;
    if (info.status === "joined" && info.session) {
      setState({ kind: "joined", info: info as JoinResult & { session: NonNullable<JoinResult["session"]> } });
    } else {
      setState({ kind: "waiting", info });
    }
  }, [token]);

  useEffect(() => {
    const first = setTimeout(join, 0);
    return () => clearTimeout(first);
  }, [join]);

  useEffect(() => {
    if (state.kind !== "waiting") return;
    const id = setInterval(join, WAIT_POLL_MS);
    return () => clearInterval(id);
  }, [state.kind, join]);

  if (state.kind === "loading") return <Shell><p className="text-ink-soft">Finding your table…</p></Shell>;
  if (state.kind === "error") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Something isn&apos;t right</h1>
        <p className="mt-2 text-ink-soft">{state.message}</p>
      </Shell>
    );
  }
  if (state.kind === "waiting" || state.kind === "ended") {
    return (
      <Shell>
        <Header info={state.info} />
        <div className="rounded-xl border border-line bg-surface p-5">
          {state.kind === "waiting" ? (
            <>
              <p className="font-medium">Welcome! A member of staff will seat you shortly.</p>
              <p className="mt-1 text-sm text-ink-soft">The menu opens here automatically once your table is ready.</p>
            </>
          ) : (
            <>
              <p className="font-medium">Thanks for visiting!</p>
              <p className="mt-1 text-sm text-ink-soft">This table&apos;s visit has ended. Scan the code again if you&apos;re still here.</p>
            </>
          )}
        </div>
      </Shell>
    );
  }
  return <TableApp info={state.info} onEnded={() => setState({ kind: "ended", info: state.info })} />;
}

// ---------------------------------------------------------------------------

type Stored = { lines: CartLine[]; note: string; key: string };
const newKey = () => crypto.randomUUID();

function readCart(sessionId: string): Stored {
  try {
    const raw = localStorage.getItem(`tableqr:cart:${sessionId}`);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    // storage unavailable, start empty
  }
  return { lines: [], note: "", key: newKey() };
}

type SheetState = { type: "item"; itemId: string; editKey?: string } | { type: "cart" } | null;

function TableApp({
  info,
  onEnded,
}: {
  info: JoinResult & { session: NonNullable<JoinResult["session"]> };
  onEnded: () => void;
}) {
  const sessionId = info.session.id;
  const money = useMemo(
    () => new Intl.NumberFormat(undefined, { style: "currency", currency: info.restaurant.currency }),
    [info.restaurant.currency],
  );
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [tab, setTab] = useState<"menu" | "orders">("menu");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [cart, setCartState] = useState<Stored>({ lines: [], note: "", key: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { orders, reload } = useSessionOrders(sessionId);

  // Cart survives reloads on this device (an unsent draft).
  useEffect(() => {
    const t = setTimeout(() => setCartState(readCart(sessionId)), 0);
    return () => clearTimeout(t);
  }, [sessionId]);

  const setCart = useCallback(
    (update: (c: Stored) => Omit<Stored, "key">) => {
      setCartState((c) => {
        // Any change to the cart gets a new idempotency key; retrying an
        // unchanged cart reuses the old one, so a lost response can't double-order.
        const next = { ...update(c), key: newKey() };
        try {
          localStorage.setItem(`tableqr:cart:${sessionId}`, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      setSubmitError(null);
    },
    [sessionId],
  );

  const fetchMenu = useCallback(async () => {
    try {
      setMenu(await loadMenu(createClient(), info.restaurant.id));
      setMenuError(null);
    } catch {
      setMenuError("We couldn't load the menu. Check your connection and try again.");
    }
  }, [info.restaurant.id]);

  useEffect(() => {
    const t = setTimeout(fetchMenu, 0);
    // Pick up availability changes during the visit.
    const id = setInterval(fetchMenu, 60000);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [fetchMenu]);

  // Detect the end of the visit: once closed, RLS hides the session row.
  useEffect(() => {
    const supabase = createClient();
    const check = async () => {
      const { data, error } = await supabase.from("table_sessions").select("id").eq("id", sessionId).maybeSingle();
      if (!error && !data) onEnded();
    };
    const id = setInterval(check, 30000);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, onEnded]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function submit() {
    if (!menu || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const items = cart.lines.map((l) => ({
      menu_item_id: l.menu_item_id,
      variation_id: l.variation_id,
      quantity: l.quantity,
      add_on_ids: l.add_on_ids,
      special_instructions: l.special_instructions || null,
    }));
    const { data, error } = await createClient().rpc("submit_order", {
      p_session_id: sessionId,
      p_items: items,
      p_idempotency_key: cart.key,
      p_note: cart.note || null,
    });
    setSubmitting(false);

    if (error) {
      if (error.message.includes("session_closed") || error.message.includes("forbidden")) {
        onEnded();
        return;
      }
      setSubmitError(friendlyError(error));
      if (/item_|variation|add_on/.test(error.message)) fetchMenu(); // refresh availability
      return;
    }
    const result = data as { order_number: string };
    setCart(() => ({ lines: [], note: "" }));
    setSheet(null);
    setTab("orders");
    setToast(`Order ${result.order_number} sent. Your waiter will confirm it shortly.`);
    reload();
  }

  const totals = menu ? cartTotals(cart.lines, menu.items, menu.taxes, menu.charges) : null;
  const count = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const activeOrders = (orders ?? []).filter((o) => !["rejected", "cancelled", "served", "completed"].includes(o.status)).length;
  const sheetItem = sheet?.type === "item" ? menu?.items.get(sheet.itemId) : undefined;
  const editing = sheet?.type === "item" && sheet.editKey ? cart.lines.find((l) => l.key === sheet.editKey) : undefined;

  return (
    <div className="mx-auto min-h-screen max-w-lg pb-28">
      <div className="flex items-start gap-3 px-4 pt-6">
        <div className="min-w-0 flex-1">
          <Header info={info} />
        </div>
        <ServicePanel sessionId={sessionId} />
      </div>

      <div className="sticky top-0 z-30 border-b border-line bg-bg/95 px-4 backdrop-blur">
        <div className="flex gap-6" role="tablist">
          {(["menu", "orders"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`border-b-2 py-3 text-sm font-medium ${tab === t ? "border-brand text-ink" : "border-transparent text-ink-soft"}`}
            >
              {t === "menu" ? "Menu" : "My orders"}
              {t === "orders" && activeOrders > 0 && (
                <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-[10px] text-white">{activeOrders}</span>
              )}
            </button>
          ))}
        </div>
        {tab === "menu" && menu && menu.categories.length > 1 && (
          <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-3" aria-label="Categories">
            {menu.categories.map((c) => (
              <a key={c.id} href={`#cat-${c.id}`} className="whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1 text-xs">
                {c.name}
              </a>
            ))}
          </nav>
        )}
      </div>

      <div className="px-4 pt-4">
        {tab === "orders" ? (
          <div className="space-y-4">
            <OrdersView orders={orders} reload={reload} money={money} onOrderMore={() => setTab("menu")} />
            <BillCard
              sessionId={sessionId}
              money={money}
              hasOrders={(orders ?? []).some((o) => !["rejected", "cancelled", "pending_confirmation", "on_hold"].includes(o.status))}
            />
          </div>
        ) : menuError ? (
          <div className="py-8 text-center">
            <p className="text-ink-soft">{menuError}</p>
            <button onClick={fetchMenu} className="mt-3 text-brand underline">
              Try again
            </button>
          </div>
        ) : !menu ? (
          <p className="py-8 text-center text-ink-soft">Loading the menu…</p>
        ) : menu.categories.length === 0 ? (
          <p className="py-8 text-center text-ink-soft">The menu is being prepared.</p>
        ) : (
          <div className="space-y-8">
            {menu.categories.map((c) => (
              <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-28">
                <h2 className="text-lg font-semibold">{c.name}</h2>
                {c.description && <p className="text-sm text-ink-soft">{c.description}</p>}
                <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                  {c.items.map((i) => (
                    <li key={i.id}>
                      <ItemRow item={i} money={money} onOpen={() => setSheet({ type: "item", itemId: i.id })} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      {count > 0 && totals && !sheet && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg p-4">
          <button onClick={() => setSheet({ type: "cart" })} className={`${btnPrimary} w-full justify-between !py-3.5 text-base shadow-lg`}>
            <span className="rounded-md bg-white/20 px-2 py-0.5 text-sm tabular-nums">{count}</span>
            <span>View order</span>
            <span className="tabular-nums">{money.format(totals.subtotal)}</span>
          </button>
        </div>
      )}

      {toast && (
        <div role="status" className="fixed inset-x-0 top-4 z-50 mx-auto w-[calc(100%-2rem)] max-w-md rounded-xl bg-ink px-4 py-3 text-sm text-bg shadow-lg">
          {toast}
        </div>
      )}

      {sheet?.type === "item" && sheetItem && (
        <ItemSheet
          key={sheet.editKey ?? sheet.itemId}
          item={sheetItem}
          editing={editing}
          money={money}
          onClose={() => setSheet(editing ? { type: "cart" } : null)}
          onSave={(line) => {
            setCart((c) => ({
              ...c,
              lines: editing
                ? c.lines.map((l) => (l.key === editing.key ? { ...line, key: l.key } : l))
                : [...c.lines, { ...line, key: newKey() }],
            }));
            setSheet(editing ? { type: "cart" } : null);
            if (!editing) setToast(`${sheetItem.name} added`);
          }}
        />
      )}

      {sheet?.type === "cart" && menu && (
        <CartSheet
          lines={cart.lines}
          menu={menu}
          money={money}
          note={cart.note}
          error={submitError}
          submitting={submitting}
          onNote={(note) => setCart((c) => ({ ...c, note }))}
          onQuantity={(key, quantity) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity } : l)) }))}
          onRemove={(key) => setCart((c) => ({ ...c, lines: c.lines.filter((l) => l.key !== key) }))}
          onEdit={(key) => {
            const line = cart.lines.find((l) => l.key === key);
            if (line) setSheet({ type: "item", itemId: line.menu_item_id, editKey: key });
          }}
          onSubmit={submit}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

function ItemRow({ item, money, onOpen }: { item: MenuItem; money: Intl.NumberFormat; onOpen: () => void }) {
  const photo = imageUrl(item.image_path);
  const deltas = item.variations.map((v) => Number(v.price_delta));
  const from = item.base_price + (deltas.length ? Math.min(...deltas) : 0);
  return (
    <button onClick={onOpen} className={`flex w-full gap-4 p-4 text-left hover:bg-muted/50 ${item.is_available ? "" : "opacity-60"}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.name}</p>
        {item.description && <p className="mt-0.5 line-clamp-2 text-sm text-ink-soft">{item.description}</p>}
        <p className="mt-1.5 text-sm font-medium tabular-nums">
          {deltas.length > 1 && "from "}
          {money.format(Math.max(from, 0))}
          {!item.is_available && <span className="ml-2 text-xs font-normal text-ink-soft">Unavailable</span>}
        </p>
      </div>
      {photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="" loading="lazy" className="size-20 shrink-0 rounded-lg object-cover" />
      )}
    </button>
  );
}

function Header({ info }: { info: JoinResult }) {
  return (
    <header className="mb-4">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand">{info.restaurant.name}</p>
      <h1 className="mt-1 text-2xl font-semibold">Table {info.table.table_number}</h1>
      {info.restaurant.description && <p className="mt-1 text-sm text-ink-soft">{info.restaurant.description}</p>}
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto min-h-screen max-w-lg px-4 py-8">{children}</main>;
}

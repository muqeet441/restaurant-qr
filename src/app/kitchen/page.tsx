import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { Elapsed } from "@/components/elapsed";
import { NotificationBell } from "@/components/notification-bell";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { btnSecondary, btnSmall, input } from "@/components/ui";
import { acceptTicket, markReady, messageWaiter, reportUnavailable, startTicket } from "./actions";

export const metadata: Metadata = { title: "Kitchen" };
export const dynamic = "force-dynamic";

type TicketItem = {
  id: string;
  status: string;
  order_items: {
    item_name_snapshot: string;
    variation_name_snapshot: string | null;
    quantity: number;
    special_instructions: string | null;
    order_item_add_ons: { name_snapshot: string }[];
    menu_items: { prep_instructions: string | null } | null;
  };
};
type Ticket = {
  id: string;
  status: string;
  station_id: string | null;
  created_at: string;
  started_at: string | null;
  ready_at: string | null;
  orders: {
    order_number: string;
    customer_note: string | null;
    created_at: string;
    restaurant_tables: { table_number: string } | null;
  };
  kitchen_ticket_items: TicketItem[];
};

const READY_WINDOW_MIN = 15;
const bigBtn = "inline-flex flex-1 items-center justify-center rounded-lg px-4 py-3 text-base font-semibold transition disabled:opacity-50";

export default async function KitchenPage({ searchParams }: { searchParams: Promise<{ station?: string }> }) {
  const { station } = await searchParams;
  const ctx = await requireStaff(["admin", "manager", "kitchen"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;

  const since = new Date(Date.now() - READY_WINDOW_MIN * 60000).toISOString();
  const [{ data: stations }, { data: mine }, { data: rows }] = await Promise.all([
    supabase.from("kitchen_stations").select("id, name").eq("restaurant_id", rid).eq("is_active", true).order("sort_order"),
    ctx.employee
      ? supabase.from("employee_station_assignments").select("station_id").eq("employee_id", ctx.employee.id)
      : Promise.resolve({ data: [] as { station_id: string }[] }),
    supabase
      .from("kitchen_tickets")
      .select(
        "id, status, station_id, created_at, started_at, ready_at, orders(order_number, customer_note, created_at, restaurant_tables(table_number)), kitchen_ticket_items(id, status, order_items(item_name_snapshot, variation_name_snapshot, quantity, special_instructions, order_item_add_ons(name_snapshot), menu_items(prep_instructions)))",
      )
      .eq("restaurant_id", rid)
      .or(`status.in.(new,accepted,preparing,partially_ready),and(status.eq.ready,ready_at.gte.${since})`)
      .order("created_at"),
  ]);

  // RLS already limits tickets to the cook's stations; the filter narrows further.
  const myStations = (mine ?? []).map((m) => m.station_id);
  const visibleStations = (stations ?? []).filter((s) => myStations.length === 0 || myStations.includes(s.id));
  const filter = station && (station === "none" || visibleStations.some((s) => s.id === station)) ? station : "all";
  const tickets = ((rows ?? []) as unknown as Ticket[]).filter((t) =>
    filter === "all" ? true : filter === "none" ? t.station_id === null : t.station_id === filter,
  );
  const stationName = new Map((stations ?? []).map((s) => [s.id, s.name]));

  const columns = [
    { title: "New", list: tickets.filter((t) => t.status === "new" || t.status === "accepted") },
    { title: "Cooking", list: tickets.filter((t) => t.status === "preparing" || t.status === "partially_ready") },
    { title: `Ready (last ${READY_WINDOW_MIN} min)`, list: tickets.filter((t) => t.status === "ready").reverse() },
  ];

  return (
    <main className="min-h-screen px-4 py-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-2 text-2xl font-semibold">Kitchen</h1>
        <nav className="flex flex-1 gap-2 overflow-x-auto" aria-label="Station">
          {[{ id: "all", name: myStations.length ? "My stations" : "All stations" }, ...visibleStations].map((s) => (
            <Link
              key={s.id}
              href={s.id === "all" ? "/kitchen" : `/kitchen?station=${s.id}`}
              className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium ${
                filter === s.id ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink-soft"
              }`}
            >
              {s.name}
            </Link>
          ))}
        </nav>
        <RealtimeRefresh
          channel={`kitchen:${rid}`}
          watch={[{ table: "kitchen_tickets", filter: `restaurant_id=eq.${rid}` }, { table: "kitchen_ticket_items" }]}
        />
        <NotificationBell userId={ctx.userId} />
        <Link href="/staff" className="text-sm text-ink-soft underline">
          Home
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {columns.map((col) => (
          <section key={col.title} className="rounded-2xl bg-muted/60 p-3">
            <h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold uppercase tracking-wide text-ink-soft">
              {col.title}
              <span className="rounded-full bg-surface px-2 tabular-nums">{col.list.length}</span>
            </h2>
            <div className="space-y-3">
              {col.list.length === 0 && <p className="px-1 py-6 text-center text-sm text-ink-soft">—</p>}
              {col.list.map((t) => {
                const items = t.kitchen_ticket_items.filter((i) => i.status !== "cancelled");
                const cancelled = t.kitchen_ticket_items.filter((i) => i.status === "cancelled");
                const cooking = t.status === "preparing" || t.status === "partially_ready";
                return (
                  <article key={t.id} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
                    <header className="flex items-baseline gap-3">
                      <p className="text-xl font-bold">Table {t.orders.restaurant_tables?.table_number ?? "?"}</p>
                      <p className="font-mono text-xs text-ink-soft">{t.orders.order_number.slice(-4)}</p>
                      <p className="ml-auto text-sm">
                        {t.status === "ready" ? "Ready" : <Elapsed since={t.created_at} warn={10} late={20} />}
                      </p>
                    </header>
                    <p className="text-xs text-ink-soft">
                      {t.station_id ? stationName.get(t.station_id) ?? "Station" : "No station"}
                      {t.status === "accepted" && " · accepted"}
                    </p>
                    {t.orders.customer_note && <p className="mt-2 rounded-md bg-muted px-2 py-1 text-sm">Note: {t.orders.customer_note}</p>}

                    <ul className="mt-3 space-y-2">
                      {items.map((i) => {
                        const oi = i.order_items;
                        const done = i.status === "ready" || i.status === "served";
                        return (
                          <li key={i.id} className={`flex items-start gap-3 ${done ? "opacity-50" : ""}`}>
                            <span className="min-w-0 flex-1 text-base">
                              <span className={`font-semibold ${done ? "line-through" : ""}`}>
                                {oi.quantity}× {oi.item_name_snapshot}
                              </span>
                              {oi.variation_name_snapshot && <span className="font-medium"> · {oi.variation_name_snapshot}</span>}
                              {oi.order_item_add_ons.length > 0 && (
                                <span className="block text-sm">+ {oi.order_item_add_ons.map((a) => a.name_snapshot).join(", ")}</span>
                              )}
                              {oi.special_instructions && (
                                <span className="block text-sm font-medium text-amber-700 dark:text-amber-400">“{oi.special_instructions}”</span>
                              )}
                              {oi.menu_items?.prep_instructions && <span className="block text-xs text-ink-soft">{oi.menu_items.prep_instructions}</span>}
                            </span>
                            {cooking && !done && (
                              <ActionForm action={markReady} submitLabel="Ready" submitClassName={`${btnSecondary} !px-3 !py-2`} inline>
                                <input type="hidden" name="ticket_id" value={t.id} />
                                <input type="hidden" name="ticket_item_ids" value={i.id} />
                              </ActionForm>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {cancelled.length > 0 && (
                      <p className="mt-2 text-sm font-semibold text-red-600 dark:text-red-400">
                        Cancelled: {cancelled.map((i) => `${i.order_items.quantity}× ${i.order_items.item_name_snapshot}`).join(", ")}
                      </p>
                    )}

                    {t.status !== "ready" && (
                      <div className="mt-4 flex gap-2">
                        {t.status === "new" && (
                          <ActionForm action={acceptTicket} submitLabel="Accept" submitClassName={`${bigBtn} border border-line bg-surface`} inline>
                            <input type="hidden" name="ticket_id" value={t.id} />
                          </ActionForm>
                        )}
                        {(t.status === "new" || t.status === "accepted") && (
                          <ActionForm action={startTicket} submitLabel="Start cooking" submitClassName={`${bigBtn} bg-brand text-white`} inline>
                            <input type="hidden" name="ticket_id" value={t.id} />
                          </ActionForm>
                        )}
                        {cooking && (
                          <ActionForm action={markReady} submitLabel="All ready" submitClassName={`${bigBtn} bg-emerald-600 text-white`} inline>
                            <input type="hidden" name="ticket_id" value={t.id} />
                          </ActionForm>
                        )}
                      </div>
                    )}

                    {t.status !== "ready" && (
                      <details className="mt-3 border-t border-line pt-2">
                        <summary className="cursor-pointer text-sm text-ink-soft">Problem?</summary>
                        <div className="mt-2 space-y-3">
                          <ActionForm action={messageWaiter} submitLabel="Message waiter" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess className="space-y-2">
                            <input type="hidden" name="ticket_id" value={t.id} />
                            <input name="message" required maxLength={500} placeholder="Question for the waiter" className={input} />
                          </ActionForm>
                          <ActionForm
                            action={reportUnavailable}
                            submitLabel="Report out of stock"
                            submitClassName={`${btnSecondary} ${btnSmall}`}
                            confirm="Take this item off the menu and tell the waiter?"
                            className="space-y-2"
                          >
                            <select name="ticket_item_id" className={input} aria-label="Item">
                              {items.map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.order_items.item_name_snapshot}
                                </option>
                              ))}
                            </select>
                            <input name="note" maxLength={200} placeholder="Note (optional)" className={input} />
                          </ActionForm>
                        </div>
                      </details>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

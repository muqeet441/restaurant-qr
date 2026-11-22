import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasAnyRole, requireStaff } from "@/lib/staff";
import { ORDER_STATUS_LABELS } from "@/lib/menu";
import { ActionForm } from "@/components/action-form";
import { Elapsed } from "@/components/elapsed";
import { NotificationBell } from "@/components/notification-bell";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Card, btnDanger, btnPrimary, btnSecondary, btnSmall, input } from "@/components/ui";
import { askCustomer, cancelItem, confirmOrder, handleRequest, rejectOrder, reviewCancellation, serveItems } from "./actions";

const REQUEST_LABEL: Record<string, string> = {
  call_waiter: "🙋 Wants the waiter",
  water: "💧 Water",
  bill: "🧾 Bill",
  assistance: "💬 Assistance",
  problem: "⚠️ Problem",
};

export const metadata: Metadata = { title: "Waiter" };
export const dynamic = "force-dynamic";

type Item = {
  id: string;
  item_name_snapshot: string;
  variation_name_snapshot: string | null;
  quantity: number;
  status: string;
  special_instructions: string | null;
  order_item_add_ons: { name_snapshot: string }[];
};
type Order = {
  id: string;
  order_number: string;
  status: string;
  table_id: string;
  customer_note: string | null;
  clarification_question: string | null;
  clarification_answer: string | null;
  created_at: string;
  confirmed_at: string | null;
  restaurant_tables: { table_number: string } | null;
  order_items: Item[];
};

const ACTIVE = ["pending_confirmation", "on_hold", "confirmed", "sent_to_kitchen", "preparing", "partially_ready", "ready", "partially_served"];

const ITEM_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  confirmed: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  preparing: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  ready: "bg-emerald-600 text-white",
  served: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  cancelled: "bg-slate-200 text-slate-500 line-through dark:bg-slate-800",
};

function ItemLine({ item, pendingCancel }: { item: Item; pendingCancel: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="font-medium">
        {item.quantity}× {item.item_name_snapshot}
      </span>
      {item.variation_name_snapshot && <span className="text-ink-soft"> ({item.variation_name_snapshot})</span>}
      {item.order_item_add_ons.length > 0 && (
        <span className="block text-xs text-ink-soft">+ {item.order_item_add_ons.map((a) => a.name_snapshot).join(", ")}</span>
      )}
      {item.special_instructions && <span className="block text-xs italic text-ink-soft">“{item.special_instructions}”</span>}
      {pendingCancel && <span className="block text-xs font-medium text-amber-700 dark:text-amber-400">Cancellation awaiting manager</span>}
    </span>
  );
}

export default async function WaiterPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const ctx = await requireStaff(["admin", "manager", "waiter"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const isManager = hasAnyRole(ctx, ["admin", "manager"]);

  const [{ data: orderRows }, { data: assignments }, { data: requests }, { data: serviceRows }] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "id, order_number, status, table_id, customer_note, clarification_question, clarification_answer, created_at, confirmed_at, restaurant_tables(table_number), order_items(id, item_name_snapshot, variation_name_snapshot, quantity, status, special_instructions, order_item_add_ons(name_snapshot))",
      )
      .eq("restaurant_id", rid)
      .in("status", ACTIVE)
      .order("created_at"),
    supabase.from("employee_table_assignments").select("table_id, employee_id").is("unassigned_at", null),
    supabase
      .from("order_cancellation_requests")
      .select("id, order_id, order_item_id, reason, created_at, order_items(item_name_snapshot, quantity), orders!inner(order_number, restaurant_id, restaurant_tables(table_number))")
      .eq("status", "pending")
      .eq("orders.restaurant_id", rid)
      .order("created_at"),
    supabase
      .from("customer_service_requests")
      .select("id, type, status, note, table_id, created_at, accepted_by, restaurant_tables(table_number)")
      .eq("restaurant_id", rid)
      .in("status", ["open", "accepted"])
      .order("created_at"),
  ]);

  const myTables = new Set((assignments ?? []).filter((a) => a.employee_id === ctx.employee?.id).map((a) => a.table_id));
  const mode = view === "all" || view === "mine" ? view : myTables.size > 0 ? "mine" : "all";
  const all = (orderRows ?? []) as unknown as Order[];
  const orders = mode === "mine" ? all.filter((o) => myTables.has(o.table_id)) : all;
  const pendingCancelItems = new Set((requests ?? []).map((r) => r.order_item_id));
  const service = ((serviceRows ?? []) as unknown as {
    id: string;
    type: string;
    status: string;
    note: string | null;
    table_id: string;
    created_at: string;
    restaurant_tables: { table_number: string } | null;
  }[]).filter((r) => mode === "all" || myTables.has(r.table_id));

  const needsYou = orders.filter((o) => o.status === "pending_confirmation" || o.status === "on_hold");
  const toServe = orders.filter((o) => o.order_items.some((i) => i.status === "ready"));
  const inKitchen = orders.filter((o) => !needsYou.includes(o) && !toServe.includes(o));

  const tableName = (o: Order) => `Table ${o.restaurant_tables?.table_number ?? "?"}`;

  function OrderCard({ o }: { o: Order }) {
    const ready = o.order_items.filter((i) => i.status === "ready");
    const cancellable = o.order_items.filter((i) => ["confirmed", "preparing", "ready"].includes(i.status));
    const pending = o.status === "pending_confirmation" || o.status === "on_hold";
    return (
      <Card className={o.status === "pending_confirmation" ? "border-amber-400 dark:border-amber-700" : ""}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-lg font-semibold">{tableName(o)}</h3>
          <span className="font-mono text-xs text-ink-soft">{o.order_number}</span>
          <span className="text-xs text-ink-soft">{ORDER_STATUS_LABELS[o.status] ?? o.status}</span>
          <span className="ml-auto text-xs">
            <Elapsed since={o.created_at} warn={5} late={10} />
          </span>
        </div>

        {o.customer_note && <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm">Note: {o.customer_note}</p>}
        {o.status === "on_hold" && (
          <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200">
            Waiting for the customer: “{o.clarification_question}”
          </p>
        )}
        {o.status === "pending_confirmation" && o.clarification_answer && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            Customer replied: “{o.clarification_answer}”
          </p>
        )}

        <ul className="mt-3 space-y-2 text-sm">
          {o.order_items.map((i) => (
            <li key={i.id} className="flex items-start gap-2">
              <ItemLine item={i} pendingCancel={pendingCancelItems.has(i.id)} />
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${ITEM_TONE[i.status] ?? ""}`}>{i.status}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap gap-2">
          {o.status === "pending_confirmation" && (
            <ActionForm action={confirmOrder} submitLabel="Confirm & send to kitchen" submitClassName={btnPrimary} inline>
              <input type="hidden" name="order_id" value={o.id} />
            </ActionForm>
          )}
          {ready.length > 0 && (
            <ActionForm action={serveItems} submitLabel={`Served (${ready.length})`} submitClassName="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700" inline>
              {ready.map((i) => (
                <input key={i.id} type="hidden" name="item_ids" value={i.id} />
              ))}
            </ActionForm>
          )}
        </div>

        {(pending || cancellable.length > 0 || (ready.length > 1)) && (
          <details className="mt-3 border-t border-line pt-3">
            <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">More actions</summary>
            <div className="mt-3 space-y-4">
              {pending && (
                <>
                  <ActionForm action={askCustomer} submitLabel="Ask customer" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess className="space-y-2">
                    <input type="hidden" name="order_id" value={o.id} />
                    <input name="question" required maxLength={500} placeholder="Question for the customer" className={input} />
                  </ActionForm>
                  <ActionForm action={rejectOrder} submitLabel="Reject order" submitClassName={`${btnDanger} ${btnSmall}`} confirm="Reject this order? The customer will see your reason." className="space-y-2">
                    <input type="hidden" name="order_id" value={o.id} />
                    <input name="reason" required maxLength={500} placeholder="Reason (shown to the customer)" className={input} />
                  </ActionForm>
                </>
              )}
              {ready.length > 1 && (
                <ActionForm action={serveItems} submitLabel="Serve selected" submitClassName={`${btnSecondary} ${btnSmall}`} className="space-y-2">
                  <p className="text-sm font-medium">Serve some of the ready items</p>
                  {ready.map((i) => (
                    <label key={i.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="item_ids" value={i.id} /> {i.quantity}× {i.item_name_snapshot}
                    </label>
                  ))}
                </ActionForm>
              )}
              {cancellable.length > 0 && (
                <ActionForm action={cancelItem} submitLabel={isManager ? "Cancel item" : "Cancel / request cancellation"} submitClassName={`${btnDanger} ${btnSmall}`} className="space-y-2">
                  <p className="text-sm font-medium">Cancel an item</p>
                  <p className="text-xs text-ink-soft">Items the kitchen has started need a manager&apos;s approval.</p>
                  <select name="item_id" className={input} aria-label="Item to cancel">
                    {cancellable.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.quantity}× {i.item_name_snapshot} ({i.status})
                      </option>
                    ))}
                  </select>
                  <input name="reason" required maxLength={500} placeholder="Reason" className={input} />
                </ActionForm>
              )}
            </div>
          </details>
        )}
      </Card>
    );
  }

  function Section({ title, list, empty }: { title: string; list: Order[]; empty: string }) {
    return (
      <section>
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          {title}
          <span className="rounded-full bg-muted px-2 text-xs tabular-nums text-ink-soft">{list.length}</span>
        </h2>
        <div className="space-y-3">
          {list.length === 0 ? <p className="text-sm text-ink-soft">{empty}</p> : list.map((o) => <OrderCard key={o.id} o={o} />)}
        </div>
      </section>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold">Waiter</h1>
          <p className="text-sm text-ink-soft">{ctx.restaurant.name}</p>
        </div>
        <RealtimeRefresh
          channel={`waiter:${rid}`}
          watch={[
            { table: "orders", filter: `restaurant_id=eq.${rid}` },
            { table: "order_items" },
            { table: "order_cancellation_requests" },
            { table: "customer_service_requests", filter: `restaurant_id=eq.${rid}` },
          ]}
        />
        <nav className="flex rounded-lg border border-line bg-surface p-0.5 text-sm" aria-label="Which tables">
          {(["mine", "all"] as const).map((m) => (
            <Link key={m} href={`/waiter?view=${m}`} className={`rounded-md px-3 py-1.5 ${mode === m ? "bg-brand text-white" : "text-ink-soft"}`}>
              {m === "mine" ? `My tables (${myTables.size})` : "All tables"}
            </Link>
          ))}
        </nav>
        <NotificationBell userId={ctx.userId} />
        <Link href="/floor" className={`${btnSecondary} ${btnSmall}`}>
          Floor
        </Link>
        <Link href="/staff" className="text-sm text-ink-soft underline">
          Home
        </Link>
      </div>

      {mode === "mine" && myTables.size === 0 && (
        <p className="mb-4 rounded-lg bg-muted px-4 py-3 text-sm">No tables are assigned to you. A manager can assign them under Admin → Tables.</p>
      )}

      {service.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 font-semibold">Customer requests</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {service.map((r) => (
              <Card key={r.id} className={r.status === "open" ? "border-brand" : ""}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-semibold">Table {r.restaurant_tables?.table_number}</p>
                  <span className="text-xs">
                    <Elapsed since={r.created_at} warn={3} late={6} />
                  </span>
                </div>
                <p className="mt-1 text-sm">{REQUEST_LABEL[r.type] ?? r.type}</p>
                {r.note && <p className="mt-1 text-sm italic text-ink-soft">“{r.note}”</p>}
                <div className="mt-3 flex gap-2">
                  {r.status === "open" && (
                    <ActionForm action={handleRequest} submitLabel="On my way" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                      <input type="hidden" name="request_id" value={r.id} />
                      <input type="hidden" name="step" value="accept" />
                    </ActionForm>
                  )}
                  <ActionForm action={handleRequest} submitLabel="Done" submitClassName={`${btnPrimary} ${btnSmall}`} inline>
                    <input type="hidden" name="request_id" value={r.id} />
                    <input type="hidden" name="step" value="complete" />
                  </ActionForm>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {isManager && (requests ?? []).length > 0 && (
        <Card className="mb-6 border-amber-400 dark:border-amber-700">
          <h2 className="mb-3 font-semibold">Cancellations waiting for approval</h2>
          <ul className="space-y-3">
            {(requests ?? []).map((r) => {
              const item = r.order_items as unknown as { item_name_snapshot: string; quantity: number } | null;
              const order = r.orders as unknown as { order_number: string; restaurant_tables: { table_number: string } | null };
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="flex-1">
                    <strong>Table {order.restaurant_tables?.table_number}</strong> · {item ? `${item.quantity}× ${item.item_name_snapshot}` : "Whole order"} — “{r.reason}”
                  </span>
                  <ActionForm action={reviewCancellation} submitLabel="Approve" submitClassName={`${btnDanger} ${btnSmall}`} inline>
                    <input type="hidden" name="request_id" value={r.id} />
                    <input type="hidden" name="approve" value="true" />
                  </ActionForm>
                  <ActionForm action={reviewCancellation} submitLabel="Deny" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                    <input type="hidden" name="request_id" value={r.id} />
                    <input type="hidden" name="approve" value="false" />
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Needs you" list={needsYou} empty="No orders waiting for confirmation." />
        <Section title="Ready to serve" list={toServe} empty="Nothing ready yet." />
        <Section title="In the kitchen" list={inKitchen} empty="Nothing cooking." />
      </div>
    </main>
  );
}

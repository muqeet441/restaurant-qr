import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ORDER_STATUS_LABELS } from "@/lib/menu";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  subtotal: number;
  customer_note: string | null;
  rejection_reason: string | null;
  created_at: string;
  restaurant_tables: { table_number: string } | null;
  order_items: {
    id: string;
    item_name_snapshot: string;
    variation_name_snapshot: string | null;
    quantity: number;
    line_total: number;
    special_instructions: string | null;
    order_item_add_ons: { name_snapshot: string }[];
  }[];
};

const TONE: Record<string, string> = {
  pending_confirmation: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });
  const time = new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short", timeZone: ctx.restaurant.timezone });

  const { data, count } = await supabase
    .from("orders")
    .select(
      "id, order_number, status, subtotal, customer_note, rejection_reason, created_at, restaurant_tables(table_number), order_items(id, item_name_snapshot, variation_name_snapshot, quantity, line_total, special_instructions, order_item_add_ons(name_snapshot))",
      { count: "exact" },
    )
    .eq("restaurant_id", rid)
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const orders = (data ?? []) as unknown as OrderRow[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order, newest first. Waiters confirm orders from their dashboard (Phase 3)."
        actions={
          <RealtimeRefresh channel={`admin-orders:${rid}`} watch={[{ table: "orders", filter: `restaurant_id=eq.${rid}` }]} />
        }
      />

      {orders.length === 0 && <p className="text-sm text-ink-soft">No orders yet.</p>}

      <div className="space-y-3">
        {orders.map((o) => (
          <Card key={o.id}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <p className="font-semibold">Table {o.restaurant_tables?.table_number ?? "?"}</p>
              <p className="font-mono text-xs text-ink-soft">{o.order_number}</p>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[o.status] ?? "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"}`}>
                {ORDER_STATUS_LABELS[o.status] ?? o.status}
              </span>
              <p className="ml-auto text-sm tabular-nums">{money.format(Number(o.subtotal))}</p>
              <p className="w-full text-xs text-ink-soft sm:w-auto">{time.format(new Date(o.created_at))}</p>
            </div>
            <ul className="mt-3 space-y-1 text-sm">
              {o.order_items.map((i) => (
                <li key={i.id} className="flex gap-2">
                  <span className="tabular-nums text-ink-soft">{i.quantity}×</span>
                  <span className="flex-1">
                    {i.item_name_snapshot}
                    {i.variation_name_snapshot ? ` (${i.variation_name_snapshot})` : ""}
                    {i.order_item_add_ons.length > 0 && (
                      <span className="text-ink-soft"> · {i.order_item_add_ons.map((a) => a.name_snapshot).join(", ")}</span>
                    )}
                    {i.special_instructions && <span className="block text-xs italic text-ink-soft">“{i.special_instructions}”</span>}
                  </span>
                  <span className="tabular-nums text-ink-soft">{money.format(Number(i.line_total))}</span>
                </li>
              ))}
            </ul>
            {o.customer_note && <p className="mt-2 text-xs text-ink-soft">Note: {o.customer_note}</p>}
            {o.rejection_reason && <p className="mt-2 text-xs text-ink-soft">Reason: {o.rejection_reason}</p>}
          </Card>
        ))}
      </div>

      {pages > 1 && (
        <nav className="mt-6 flex items-center gap-3 text-sm" aria-label="Pagination">
          {page > 1 && <Link href={`/admin/orders?page=${page - 1}`} className="underline">Newer</Link>}
          <span className="text-ink-soft">
            Page {page} of {pages}
          </span>
          {page < pages && <Link href={`/admin/orders?page=${page + 1}`} className="underline">Older</Link>}
        </nav>
      )}
    </>
  );
}

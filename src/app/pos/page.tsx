import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasAnyRole, requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { Elapsed } from "@/components/elapsed";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Card, PageHeader, btnDanger, btnPrimary, btnSecondary, btnSmall } from "@/components/ui";
import { openBill, reviewRefund } from "./actions";
import { INVOICE_LABELS } from "./labels";

export const metadata: Metadata = { title: "POS" };
export const dynamic = "force-dynamic";

type Session = {
  id: string;
  status: string;
  opened_at: string;
  bill_requested_at: string | null;
  guest_count: number | null;
  restaurant_tables: { table_number: string } | null;
  invoices: { id: string; status: string; total: number; amount_paid: number; finalized_at: string | null }[];
  orders: { status: string; subtotal: number }[];
};

export default async function PosHome() {
  const ctx = await requireStaff(["admin", "manager", "cashier"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const isManager = hasAnyRole(ctx, ["admin", "manager"]);
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });

  const [{ data: rows }, { data: myRegister }, { data: refunds }] = await Promise.all([
    supabase
      .from("table_sessions")
      .select("id, status, opened_at, bill_requested_at, guest_count, restaurant_tables(table_number), invoices(id, status, total, amount_paid, finalized_at), orders(status, subtotal)")
      .eq("restaurant_id", rid)
      .neq("status", "closed")
      .order("opened_at"),
    supabase
      .from("cash_register_sessions")
      .select("id, opened_at, cash_registers(name)")
      .eq("opened_by", ctx.userId)
      .is("closed_at", null)
      .maybeSingle(),
    isManager
      ? supabase
          .from("refunds")
          .select("id, amount, reason, created_at, invoices!inner(invoice_number, restaurant_id)")
          .eq("status", "pending")
          .eq("invoices.restaurant_id", rid)
      : Promise.resolve({ data: [] }),
  ]);

  const sessions = ((rows ?? []) as unknown as Session[]).map((s) => {
    const invoice = s.invoices.find((i) => i.status !== "void") ?? null;
    const billable = s.orders.filter((o) => !["pending_confirmation", "on_hold", "rejected", "cancelled"].includes(o.status));
    return { ...s, invoice, ordered: billable.reduce((n, o) => n + Number(o.subtotal), 0), waiting: s.orders.some((o) => o.status === "pending_confirmation" || o.status === "on_hold") };
  });
  // Bill requests first, then by how long the table has been seated.
  sessions.sort((a, b) => Number(!!b.bill_requested_at) - Number(!!a.bill_requested_at) || a.opened_at.localeCompare(b.opened_at));

  return (
    <>
      <PageHeader
        title="Tables & bills"
        description="Every seated table. Open one to prepare its bill and take payment."
        actions={
          <RealtimeRefresh
            channel={`pos:${rid}`}
            watch={[
              { table: "table_sessions", filter: `restaurant_id=eq.${rid}` },
              { table: "orders", filter: `restaurant_id=eq.${rid}` },
              { table: "invoices", filter: `restaurant_id=eq.${rid}` },
              { table: "refunds" },
            ]}
          />
        }
      />

      {!myRegister && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span className="flex-1">Your cash register isn&apos;t open, so you can only take card and other non-cash payments.</span>
          <Link href="/pos/register" className={`${btnSecondary} ${btnSmall}`}>
            Open register
          </Link>
        </div>
      )}

      {isManager && (refunds ?? []).length > 0 && (
        <Card className="mb-6 border-amber-400 dark:border-amber-700">
          <h2 className="mb-3 font-semibold">Refunds waiting for approval</h2>
          <ul className="space-y-2">
            {(refunds ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="flex-1">
                  {(r.invoices as unknown as { invoice_number: string }).invoice_number} · <strong>{money.format(Number(r.amount))}</strong> — “{r.reason}”
                </span>
                <ActionForm action={reviewRefund} submitLabel="Approve" submitClassName={`${btnDanger} ${btnSmall}`} inline>
                  <input type="hidden" name="refund_id" value={r.id} />
                  <input type="hidden" name="approve" value="true" />
                </ActionForm>
                <ActionForm action={reviewRefund} submitLabel="Deny" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                  <input type="hidden" name="refund_id" value={r.id} />
                  <input type="hidden" name="approve" value="false" />
                </ActionForm>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {sessions.length === 0 && <p className="text-sm text-ink-soft">No seated tables.</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sessions.map((s) => {
          const inv = s.invoice;
          const outstanding = inv ? Number(inv.total) - Number(inv.amount_paid) : null;
          return (
            <Card key={s.id} className={`flex flex-col gap-3 ${s.bill_requested_at ? "border-brand" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xl font-semibold">Table {s.restaurant_tables?.table_number}</p>
                  <p className="text-xs text-ink-soft">
                    Seated <Elapsed since={s.opened_at} warn={90} late={150} /> ago
                  </p>
                </div>
                {s.bill_requested_at && <span className="rounded-full bg-brand px-2.5 py-0.5 text-xs font-medium text-white">Bill requested</span>}
              </div>
              <dl className="text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-soft">Ordered (before tax)</dt>
                  <dd className="tabular-nums">{money.format(s.ordered)}</dd>
                </div>
                {inv && (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-ink-soft">Bill</dt>
                      <dd className="tabular-nums">{money.format(Number(inv.total))}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-ink-soft">{INVOICE_LABELS[inv.status] ?? inv.status}</dt>
                      <dd className="font-medium tabular-nums">{outstanding! > 0 ? `${money.format(outstanding!)} due` : "Settled"}</dd>
                    </div>
                  </>
                )}
              </dl>
              {s.waiting && <p className="text-xs text-amber-700 dark:text-amber-400">An order is still waiting for the waiter.</p>}
              <form action={openBill} className="mt-auto">
                <input type="hidden" name="session_id" value={s.id} />
                <button className={`${inv ? btnSecondary : btnPrimary} w-full`}>{inv ? "Open bill" : "Prepare bill"}</button>
              </form>
            </Card>
          );
        })}
      </div>
    </>
  );
}

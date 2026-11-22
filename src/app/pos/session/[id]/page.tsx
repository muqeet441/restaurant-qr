import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasAnyRole, requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Badge, Card, btnDanger, btnPrimary, btnSecondary, btnSmall, input } from "@/components/ui";
import { addCoupon, addDiscount, closeTable, finalizeBill, prepareBill, refund, removeDiscount, voidBill } from "../../actions";
import { INVOICE_LABELS, METHOD_LABELS } from "../../labels";
import { PaymentPanel } from "./payment-panel";

export const metadata: Metadata = { title: "Bill" };
export const dynamic = "force-dynamic";

type Invoice = {
  id: string;
  invoice_number: string;
  status: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  service_charge_total: number;
  total: number;
  amount_paid: number;
  amount_refunded: number;
  finalized_at: string | null;
  receipt_token: string;
  tax_breakdown: { name: string; rate: number; inclusive: boolean; amount: number }[];
  charge_breakdown: { name: string; amount: number }[];
};

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaff(["admin", "manager", "cashier"]);
  const supabase = await createClient();
  const isManager = hasAnyRole(ctx, ["admin", "manager"]);
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });
  const time = new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: ctx.restaurant.timezone });

  const { data: session } = await supabase
    .from("table_sessions")
    .select("id, status, opened_at, bill_requested_at, restaurant_tables(table_number)")
    .eq("id", id)
    .eq("restaurant_id", ctx.restaurant.id)
    .maybeSingle();
  if (!session) notFound();

  const { data: invRow } = await supabase.from("invoices").select("*").eq("session_id", id).neq("status", "void").maybeSingle();
  const invoice = invRow as Invoice | null;

  const [{ data: items }, { data: discounts }, { data: payments }, { data: refunds }, { data: allocations }, { data: waiting }, { data: register }] =
    await Promise.all([
      invoice ? supabase.from("invoice_items").select("id, description, quantity, unit_price, line_total").eq("invoice_id", invoice.id).order("description") : Promise.resolve({ data: [] }),
      invoice ? supabase.from("discount_applications").select("id, reason, amount, kind, value, discount_id").eq("invoice_id", invoice.id).order("created_at") : Promise.resolve({ data: [] }),
      invoice ? supabase.from("payments").select("id, amount, method, status, reference, payer_label, change_given, failure_reason, created_at").eq("invoice_id", invoice.id).order("created_at") : Promise.resolve({ data: [] }),
      invoice ? supabase.from("refunds").select("id, payment_id, amount, status, reason").eq("invoice_id", invoice.id) : Promise.resolve({ data: [] }),
      invoice ? supabase.from("payment_allocations").select("invoice_item_id, payments!inner(status, invoice_id)").eq("payments.invoice_id", invoice.id) : Promise.resolve({ data: [] }),
      supabase.from("orders").select("id", { count: "exact", head: false }).eq("session_id", id).in("status", ["pending_confirmation", "on_hold"]),
      supabase.from("cash_register_sessions").select("id").eq("opened_by", ctx.userId).is("closed_at", null).maybeSingle(),
    ]);

  const paidItems = new Set(
    ((allocations ?? []) as unknown as { invoice_item_id: string; payments: { status: string } }[])
      .filter((a) => a.payments.status === "succeeded")
      .map((a) => a.invoice_item_id),
  );
  const outstanding = invoice ? Math.round((Number(invoice.total) - Number(invoice.amount_paid)) * 100) / 100 : 0;
  const draft = invoice && !invoice.finalized_at;
  const settled = invoice && invoice.finalized_at && outstanding <= 0;
  const table = (session.restaurant_tables as unknown as { table_number: string } | null)?.table_number;
  const refundedByPayment = new Map<string, number>();
  for (const r of refunds ?? []) {
    if (r.status !== "denied") refundedByPayment.set(r.payment_id, (refundedByPayment.get(r.payment_id) ?? 0) + Number(r.amount));
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link href="/pos" className="text-sm text-ink-soft underline">
          ← All tables
        </Link>
        <h1 className="text-2xl font-semibold">Table {table}</h1>
        {invoice && <Badge>{INVOICE_LABELS[invoice.status] ?? invoice.status}</Badge>}
        {invoice && <span className="font-mono text-xs text-ink-soft">{invoice.invoice_number}</span>}
        <span className="ml-auto">
          <RealtimeRefresh
            channel={`bill:${id}`}
            watch={[
              { table: "orders", filter: `session_id=eq.${id}` },
              { table: "invoices", filter: `session_id=eq.${id}` },
              { table: "payments" },
              { table: "refunds" },
            ]}
          />
        </span>
      </div>

      {(waiting ?? []).length > 0 && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {(waiting ?? []).length} order(s) still waiting for the waiter. They&apos;re not on the bill and must be handled before it can be finalized.
        </p>
      )}

      {!invoice ? (
        <Card>
          <p className="mb-3 text-sm">No bill yet for this table.</p>
          <ActionForm action={prepareBill} submitLabel="Prepare bill">
            <input type="hidden" name="session_id" value={id} />
          </ActionForm>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
          {/* Bill */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Bill</h2>
              {draft && (
                <ActionForm action={prepareBill} submitLabel="Refresh from orders" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                  <input type="hidden" name="session_id" value={id} />
                </ActionForm>
              )}
            </div>
            <ul className="divide-y divide-line text-sm">
              {(items ?? []).map((l) => (
                <li key={l.id} className="flex gap-3 py-2">
                  <span className="tabular-nums text-ink-soft">{l.quantity}×</span>
                  <span className="flex-1">
                    {l.description}
                    {paidItems.has(l.id) && <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">paid</span>}
                  </span>
                  <span className="tabular-nums">{money.format(Number(l.line_total))}</span>
                </li>
              ))}
              {(items ?? []).length === 0 && <li className="py-3 text-ink-soft">Nothing billable yet. Orders appear once the waiter confirms them.</li>}
            </ul>

            <dl className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
              <Row label="Subtotal" value={money.format(Number(invoice.subtotal))} />
              {(discounts ?? []).map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 text-emerald-700 dark:text-emerald-400">
                  <dt className="flex items-center gap-2">
                    {d.reason}
                    {d.kind === "percentage" && ` (${Number(d.value)}%)`}
                    {draft && (
                      <ActionForm action={removeDiscount} submitLabel="×" submitClassName="text-ink-soft hover:text-ink" inline>
                        <input type="hidden" name="application_id" value={d.id} />
                      </ActionForm>
                    )}
                  </dt>
                  <dd className="tabular-nums">−{money.format(Number(d.amount))}</dd>
                </div>
              ))}
              {invoice.tax_breakdown.map((t) => (
                <Row key={t.name} label={`${t.name} ${Number(t.rate)}%${t.inclusive ? " (included)" : ""}`} value={money.format(Number(t.amount))} soft />
              ))}
              {invoice.charge_breakdown.map((c) => (
                <Row key={c.name} label={c.name} value={money.format(Number(c.amount))} soft />
              ))}
              <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{money.format(Number(invoice.total))}</dd>
              </div>
              {Number(invoice.amount_paid) > 0 && <Row label="Paid" value={money.format(Number(invoice.amount_paid))} soft />}
              {Number(invoice.amount_refunded) > 0 && <Row label="Refunded" value={money.format(Number(invoice.amount_refunded))} soft />}
              {invoice.finalized_at && (
                <div className="flex justify-between font-semibold">
                  <dt>Outstanding</dt>
                  <dd className="tabular-nums">{money.format(Math.max(outstanding, 0))}</dd>
                </div>
              )}
            </dl>

            {draft && (
              <div className="mt-5 space-y-4 border-t border-line pt-4">
                <ActionForm action={addDiscount} submitLabel="Add discount" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess className="space-y-2">
                  <input type="hidden" name="invoice_id" value={invoice.id} />
                  <p className="text-sm font-medium">Discount</p>
                  <div className="flex gap-2">
                    <select name="kind" className={`${input} !w-28`} aria-label="Discount type">
                      <option value="percentage">%</option>
                      <option value="fixed_amount">{ctx.restaurant.currency}</option>
                    </select>
                    <input name="value" type="number" min={0.01} step="0.01" required placeholder="Value" className={`${input} !w-28`} aria-label="Discount value" />
                    <input name="reason" required maxLength={200} placeholder="Reason" className={input} aria-label="Reason" />
                  </div>
                </ActionForm>
                <ActionForm action={addCoupon} submitLabel="Apply coupon" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess inline>
                  <input type="hidden" name="invoice_id" value={invoice.id} />
                  <input name="code" required placeholder="Coupon code" className={`${input} !w-40 uppercase`} aria-label="Coupon code" />
                </ActionForm>
                <ActionForm action={finalizeBill} submitLabel="Finalize bill" submitClassName={btnPrimary} confirm="Finalize the bill? Discounts and new orders can't be added afterwards." inline>
                  <input type="hidden" name="invoice_id" value={invoice.id} />
                </ActionForm>
                <p className="text-xs text-ink-soft">The bill is finalized automatically when the first payment is taken.</p>
              </div>
            )}

            {invoice.finalized_at && (
              <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                <Link href={`/pos/receipt/${invoice.id}`} className={`${btnSecondary} ${btnSmall}`} target="_blank">
                  Print {settled ? "receipt" : "bill"}
                </Link>
                <Link href={`/r/${invoice.receipt_token}`} className={`${btnSecondary} ${btnSmall}`} target="_blank">
                  Digital receipt
                </Link>
              </div>
            )}

            {isManager && Number(invoice.amount_paid) - Number(invoice.amount_refunded) <= 0 && (
              <details className="mt-4 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm text-ink-soft">Void invoice</summary>
                <ActionForm action={voidBill} submitLabel="Void invoice" submitClassName={`${btnDanger} ${btnSmall}`} confirm="Void this invoice? The table goes back to ordering." className="mt-2 space-y-2">
                  <input type="hidden" name="invoice_id" value={invoice.id} />
                  <input name="reason" required maxLength={200} placeholder="Reason" className={input} />
                </ActionForm>
              </details>
            )}
          </Card>

          {/* Payments */}
          <div className="space-y-6">
            {outstanding > 0 && (items ?? []).length > 0 && (
              <Card>
                <h2 className="mb-4 font-semibold">Take payment · {money.format(outstanding)} due</h2>
                <PaymentPanel
                  invoiceId={invoice.id}
                  total={Number(invoice.total)}
                  subtotal={Number(invoice.subtotal)}
                  outstanding={outstanding}
                  currency={ctx.restaurant.currency}
                  registerOpen={!!register}
                  lines={(items ?? []).map((l) => ({ ...l, line_total: Number(l.line_total), paid: paidItems.has(l.id) }))}
                />
              </Card>
            )}

            {settled && session.status !== "closed" && (
              <Card className="border-emerald-400 dark:border-emerald-700">
                <h2 className="font-semibold">Paid in full</h2>
                <p className="mb-3 text-sm text-ink-soft">Close the table to release it for cleaning.</p>
                <ActionForm action={closeTable} submitLabel="Close table" submitClassName={btnPrimary}>
                  <input type="hidden" name="session_id" value={id} />
                </ActionForm>
              </Card>
            )}

            <Card>
              <h2 className="mb-3 font-semibold">Payments</h2>
              {(payments ?? []).length === 0 && <p className="text-sm text-ink-soft">None yet.</p>}
              <ul className="divide-y divide-line">
                {(payments ?? []).map((p) => {
                  const refundable = Number(p.amount) - (refundedByPayment.get(p.id) ?? 0);
                  return (
                    <li key={p.id} className={`py-3 text-sm ${p.status === "failed" ? "opacity-60" : ""}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{METHOD_LABELS[p.method] ?? p.method}</span>
                        {p.payer_label && <span className="text-ink-soft">· {p.payer_label}</span>}
                        {p.reference && <span className="font-mono text-xs text-ink-soft">{p.reference}</span>}
                        {p.status === "failed" && <Badge>Failed: {p.failure_reason}</Badge>}
                        <span className="ml-auto tabular-nums">{money.format(Number(p.amount))}</span>
                        <span className="w-14 text-right text-xs text-ink-soft">{time.format(new Date(p.created_at))}</span>
                      </div>
                      {(refunds ?? []).filter((r) => r.payment_id === p.id).map((r) => (
                        <p key={r.id} className="mt-1 text-xs text-ink-soft">
                          Refund {money.format(Number(r.amount))} · {r.status} — {r.reason}
                        </p>
                      ))}
                      {p.status === "succeeded" && refundable > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-ink-soft">Refund</summary>
                          <ActionForm action={refund} submitLabel={isManager ? "Refund" : "Request refund"} submitClassName={`${btnDanger} ${btnSmall}`} className="mt-2 space-y-2" resetOnSuccess>
                            <input type="hidden" name="payment_id" value={p.id} />
                            <div className="flex gap-2">
                              <input name="amount" type="number" min={0.01} step="0.01" max={refundable} defaultValue={refundable.toFixed(2)} required className={`${input} !w-28`} aria-label="Refund amount" />
                              <input name="reason" required maxLength={200} placeholder="Reason" className={input} aria-label="Refund reason" />
                            </div>
                            {!isManager && <p className="text-xs text-ink-soft">A manager must approve refunds.</p>}
                          </ActionForm>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>

            {!settled && session.status !== "closed" && isManager && (
              <details>
                <summary className="cursor-pointer text-sm text-ink-soft">Close the table without full payment</summary>
                <ActionForm action={closeTable} submitLabel="Close with exception" submitClassName={`${btnDanger} ${btnSmall}`} confirm="Close this table with an unpaid balance? This is recorded." className="mt-2 space-y-2">
                  <input type="hidden" name="session_id" value={id} />
                  <input name="reason" required maxLength={200} placeholder="Reason (recorded)" className={input} />
                </ActionForm>
              </details>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value, soft }: { label: string; value: string; soft?: boolean }) {
  return (
    <div className={`flex justify-between ${soft ? "text-ink-soft" : ""}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

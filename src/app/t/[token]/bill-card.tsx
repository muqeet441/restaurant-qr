"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { FeedbackForm } from "./feedback-form";

type Invoice = {
  id: string;
  status: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  service_charge_total: number;
  total: number;
  amount_paid: number;
  finalized_at: string | null;
  receipt_token: string | null;
};

/** "Request the bill", then the bill itself once the cashier prepares it. */
export function BillCard({ sessionId, money, hasOrders }: { sessionId: string; money: Intl.NumberFormat; hasOrders: boolean }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: inv }, { data: session }] = await Promise.all([
      supabase
        .from("invoices")
        .select("id, status, subtotal, discount_total, tax_total, service_charge_total, total, amount_paid, finalized_at, receipt_token")
        .eq("session_id", sessionId)
        .neq("status", "void")
        .maybeSingle(),
      supabase.from("table_sessions").select("bill_requested_at").eq("id", sessionId).maybeSingle(),
    ]);
    setInvoice((inv as Invoice | null) ?? null);
    setRequested(!!session?.bill_requested_at);
  }, [sessionId]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`guest-bill:${sessionId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "invoices", filter: `session_id=eq.${sessionId}` }, load)
      .subscribe((s) => s === "SUBSCRIBED" && load());
    const poll = setInterval(load, 30000);
    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [sessionId, load]);

  async function requestBill() {
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("request_bill", { p_session_id: sessionId });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else setRequested(true);
  }

  if (!hasOrders && !invoice) return null;
  const due = invoice ? Number(invoice.total) - Number(invoice.amount_paid) : 0;
  const paid = invoice?.finalized_at && due <= 0.0049;

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="font-semibold">Bill</h2>
      {invoice ? (
        <>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="Subtotal" value={money.format(Number(invoice.subtotal))} />
            {Number(invoice.discount_total) > 0 && <Row label="Discounts" value={`−${money.format(Number(invoice.discount_total))}`} />}
            {Number(invoice.tax_total) > 0 && <Row label="Tax" value={money.format(Number(invoice.tax_total))} />}
            {Number(invoice.service_charge_total) > 0 && <Row label="Service" value={money.format(Number(invoice.service_charge_total))} />}
            <div className="flex justify-between border-t border-line pt-1 font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{money.format(Number(invoice.total))}</dd>
            </div>
            {Number(invoice.amount_paid) > 0 && <Row label="Paid" value={money.format(Number(invoice.amount_paid))} />}
          </dl>
          {paid ? (
            <p className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Paid, thank you!{" "}
              {invoice.receipt_token && (
                <Link href={`/r/${invoice.receipt_token}`} className="underline">
                  View receipt
                </Link>
              )}
            </p>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">
              {invoice.finalized_at ? `${money.format(due)} to pay. Your waiter or the cashier will take payment.` : "Your bill is being prepared."}
            </p>
          )}
        </>
      ) : requested ? (
        <p className="mt-1 text-sm text-ink-soft">Bill requested. Someone will be with you shortly.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-soft">Finished? Ask for the bill and we&apos;ll bring it over.</p>
          <button onClick={requestBill} disabled={busy} className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Sending…" : "Request the bill"}
          </button>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {paid && (
        <div className="mt-4 border-t border-line pt-4">
          <FeedbackForm sessionId={sessionId} />
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-ink-soft">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { btnPrimary, input } from "@/components/ui";
import { takePayment, type PaymentState } from "../../actions";
import { METHOD_LABELS } from "../../labels";

type Line = { id: string; description: string; quantity: number; line_total: number; paid: boolean };
type Mode = "full" | "equal" | "items" | "custom";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function PaymentPanel({
  invoiceId,
  total,
  subtotal,
  outstanding,
  currency,
  lines,
  registerOpen,
}: {
  invoiceId: string;
  total: number;
  subtotal: number;
  outstanding: number;
  currency: string;
  lines: Line[];
  registerOpen: boolean;
}) {
  const money = useMemo(() => new Intl.NumberFormat("en", { style: "currency", currency }), [currency]);
  const [state, action, pending] = useActionState<PaymentState, FormData>(takePayment, null);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<Mode>("full");
  const [method, setMethod] = useState(registerOpen ? "cash" : "card");
  const [ways, setWays] = useState(2);
  const [custom, setCustom] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [tendered, setTendered] = useState("");

  // A fresh idempotency key per payment; a failed attempt keeps its key so a
  // retry after a timeout can't charge twice.
  useEffect(() => {
    const t = setTimeout(() => setKey(state?.key ?? crypto.randomUUID()), 0);
    return () => clearTimeout(t);
  }, [state]);
  useEffect(() => {
    if (!state?.ok) return;
    const t = setTimeout(() => {
      setPicked([]);
      setCustom("");
      setTendered("");
    }, 0);
    return () => clearTimeout(t);
  }, [state]);

  const unpaid = lines.filter((l) => !l.paid);
  const itemsAmount = useMemo(() => {
    if (picked.length === 0) return 0;
    if (picked.length === unpaid.length) return outstanding;
    const share = lines.filter((l) => picked.includes(l.id)).reduce((s, l) => s + Number(l.line_total), 0);
    return Math.min(round2((share * total) / (subtotal || 1)), outstanding);
  }, [picked, unpaid.length, lines, total, subtotal, outstanding]);

  const equalShare = round2(total / Math.max(ways, 1));
  // The last payer covers rounding pennies (10.00 / 3 → 3.33, 3.33, 3.34).
  const equalAmount = outstanding - equalShare < equalShare / 2 ? outstanding : equalShare;
  const amount =
    mode === "full"
      ? outstanding
      : mode === "equal"
        ? equalAmount
        : mode === "items"
          ? itemsAmount
          : Number(custom) || 0;
  const change = method === "cash" && tendered ? round2(Number(tendered) - amount) : null;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="key" value={key} />
      {mode !== "items" && <input type="hidden" name="amount" value={amount.toFixed(2)} />}

      <fieldset>
        <legend className="mb-2 text-sm font-medium">How is the table paying?</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ["full", "Everything"],
              ["equal", "Split equally"],
              ["items", "By items"],
              ["custom", "Custom amount"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <label key={m} className="flex cursor-pointer items-center justify-center rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/10">
              <input type="radio" name="mode" className="sr-only" checked={mode === m} onChange={() => setMode(m)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {mode === "equal" && (
        <label className="flex items-center gap-3 text-sm">
          Split between
          <input type="number" min={2} max={20} value={ways} onChange={(e) => setWays(Math.max(2, Number(e.target.value) || 2))} className={`${input} !w-20`} />
          people · {money.format(round2(total / Math.max(ways, 1)))} each
        </label>
      )}

      {mode === "items" && (
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm text-ink-soft">Tick what this person is paying for (their share of tax, service and discounts is included).</legend>
          {lines.map((l) => (
            <label key={l.id} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm ${l.paid ? "opacity-40" : "hover:bg-muted"}`}>
              <input
                type="checkbox"
                name="item_ids"
                value={l.id}
                disabled={l.paid}
                checked={picked.includes(l.id)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))}
              />
              <span className="flex-1">
                {l.quantity}× {l.description}
                {l.paid && " (paid)"}
              </span>
              <span className="tabular-nums text-ink-soft">{money.format(Number(l.line_total))}</span>
            </label>
          ))}
        </fieldset>
      )}

      {mode === "custom" && (
        <label className="block text-sm">
          Amount
          <input type="number" min={0.01} step="0.01" max={outstanding} value={custom} onChange={(e) => setCustom(e.target.value)} className={`${input} mt-1`} required />
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          Method
          <select name="method" value={method} onChange={(e) => setMethod(e.target.value)} className={`${input} mt-1`}>
            {Object.entries(METHOD_LABELS)
              .filter(([m]) => m !== "online_gateway")
              .map(([m, label]) => (
                <option key={m} value={m} disabled={m === "cash" && !registerOpen}>
                  {label}
                  {m === "cash" && !registerOpen ? " (open register first)" : ""}
                </option>
              ))}
          </select>
        </label>
        {method === "cash" ? (
          <label className="block text-sm">
            Cash received
            <input name="tendered" type="number" min={0} step="0.01" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder={amount.toFixed(2)} className={`${input} mt-1`} />
          </label>
        ) : (
          <label className="block text-sm">
            Reference
            <input name="reference" maxLength={120} placeholder="Terminal / transfer ref" className={`${input} mt-1`} />
          </label>
        )}
        <label className="block text-sm">
          Payer (optional)
          <input name="payer" maxLength={60} placeholder="e.g. Seat 2" className={`${input} mt-1`} />
        </label>
        {method !== "cash" && (
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" name="failed" /> Card declined / failed
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-muted px-4 py-3">
        <div className="flex-1">
          <p className="text-xs text-ink-soft">Charging</p>
          <p className="text-2xl font-semibold tabular-nums">{money.format(amount)}</p>
          {change !== null && change >= 0 && <p className="text-sm">Change: <strong className="tabular-nums">{money.format(change)}</strong></p>}
          {change !== null && change < 0 && <p className="text-sm text-red-600">Not enough cash</p>}
        </div>
        <button type="submit" disabled={pending || !key || amount <= 0 || (change !== null && change < 0)} className={`${btnPrimary} !px-6 !py-3 text-base`}>
          {pending ? "Recording…" : "Record payment"}
        </button>
      </div>

      {state?.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
      {state?.ok && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {state.ok}
          {state.change ? ` Give ${money.format(Number(state.change))} change.` : ""}
        </p>
      )}
    </form>
  );
}

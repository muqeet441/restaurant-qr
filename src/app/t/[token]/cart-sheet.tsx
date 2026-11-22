"use client";

import { cartTotals, unitPrice, type CartLine } from "@/lib/menu";
import { btnPrimary } from "@/components/ui";
import type { MenuData } from "./load-menu";
import { Sheet } from "./sheet";

export function describeLine(line: CartLine, menu: MenuData): string {
  const item = menu.items.get(line.menu_item_id);
  if (!item) return "";
  const parts = [
    item.variations.find((v) => v.id === line.variation_id)?.name,
    ...item.groups.flatMap((g) => g.add_ons).filter((a) => line.add_on_ids.includes(a.id)).map((a) => a.name),
  ].filter(Boolean);
  return parts.join(", ");
}

export function CartSheet({
  lines,
  menu,
  money,
  note,
  error,
  submitting,
  onNote,
  onQuantity,
  onRemove,
  onEdit,
  onSubmit,
  onClose,
}: {
  lines: CartLine[];
  menu: MenuData;
  money: Intl.NumberFormat;
  note: string;
  error: string | null;
  submitting: boolean;
  onNote: (v: string) => void;
  onQuantity: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  onEdit: (key: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const totals = cartTotals(lines, menu.items, menu.taxes, menu.charges);
  const unavailable = lines.filter((l) => !menu.items.get(l.menu_item_id)?.is_available);

  return (
    <Sheet
      open
      onClose={onClose}
      title="Your order"
      footer={
        lines.length > 0 && (
          <div className="space-y-3">
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <button
              type="button"
              className={`${btnPrimary} w-full !py-3 text-base`}
              disabled={submitting || unavailable.length > 0}
              onClick={onSubmit}
            >
              {submitting ? "Sending…" : `Send order · ${money.format(totals.total)}`}
            </button>
            <p className="text-center text-xs text-ink-soft">Your waiter will confirm the order before it goes to the kitchen.</p>
          </div>
        )
      }
    >
      {lines.length === 0 ? (
        <p className="py-8 text-center text-ink-soft">Your cart is empty.</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {lines.map((l) => {
              const item = menu.items.get(l.menu_item_id);
              if (!item) {
                return (
                  <li key={l.key} className="flex items-center justify-between py-3 text-sm">
                    <span className="text-ink-soft">An item is no longer on the menu.</span>
                    <button className="text-red-600 underline" onClick={() => onRemove(l.key)}>
                      Remove
                    </button>
                  </li>
                );
              }
              const details = describeLine(l, menu);
              return (
                <li key={l.key} className="py-3">
                  <div className="flex gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{item.name}</p>
                      {details && <p className="text-xs text-ink-soft">{details}</p>}
                      {l.special_instructions && <p className="text-xs italic text-ink-soft">“{l.special_instructions}”</p>}
                      {!item.is_available && <p className="text-xs font-medium text-red-600">No longer available, please remove</p>}
                    </div>
                    <p className="tabular-nums">{money.format(unitPrice(item, l) * l.quantity)}</p>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-sm">
                    <div className="flex items-center rounded-lg border border-line">
                      <button
                        className="px-2.5 py-1"
                        aria-label={`Fewer ${item.name}`}
                        onClick={() => (l.quantity <= 1 ? onRemove(l.key) : onQuantity(l.key, l.quantity - 1))}
                      >
                        −
                      </button>
                      <span className="w-6 text-center tabular-nums">{l.quantity}</span>
                      <button
                        className="px-2.5 py-1 disabled:opacity-40"
                        disabled={l.quantity >= 50}
                        aria-label={`More ${item.name}`}
                        onClick={() => onQuantity(l.key, l.quantity + 1)}
                      >
                        +
                      </button>
                    </div>
                    <button className="text-ink-soft underline" onClick={() => onEdit(l.key)}>
                      Edit
                    </button>
                    <button className="text-ink-soft underline" onClick={() => onRemove(l.key)}>
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <label className="mt-4 block">
            <span className="text-sm font-medium">Note for the waiter</span>
            <input
              value={note}
              maxLength={500}
              onChange={(e) => onNote(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </label>

          <dl className="mt-5 space-y-1 border-t border-line pt-4 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{money.format(totals.subtotal)}</dd>
            </div>
            {totals.taxes.map((t) => (
              <div key={t.name} className="flex justify-between text-ink-soft">
                <dt>
                  {t.name}
                  {t.inclusive ? " (included)" : ""}
                </dt>
                <dd className="tabular-nums">{money.format(t.amount)}</dd>
              </div>
            ))}
            {totals.charges.map((c) => (
              <div key={c.name} className="flex justify-between text-ink-soft">
                <dt>{c.name}</dt>
                <dd className="tabular-nums">{money.format(c.amount)}</dd>
              </div>
            ))}
            <div className="flex justify-between pt-1 font-semibold">
              <dt>Estimated total</dt>
              <dd className="tabular-nums">{money.format(totals.total)}</dd>
            </div>
            <p className="pt-1 text-xs text-ink-soft">Your final bill is prepared by the cashier and may include discounts.</p>
          </dl>
        </>
      )}
    </Sheet>
  );
}

"use client";

import { useState } from "react";
import { imageUrl, unitPrice, validateSelection, type CartLine, type MenuItem } from "@/lib/menu";
import { btnPrimary } from "@/components/ui";
import { Sheet } from "./sheet";

function defaultLine(item: MenuItem): Omit<CartLine, "key"> {
  const active = item.variations.filter((v) => v.is_active);
  return {
    menu_item_id: item.id,
    variation_id: (active.find((v) => v.is_default) ?? active[0])?.id ?? null,
    add_on_ids: [],
    quantity: 1,
    special_instructions: "",
  };
}

export function ItemSheet({
  item,
  editing,
  money,
  onSave,
  onClose,
}: {
  item: MenuItem;
  editing?: CartLine;
  money: Intl.NumberFormat;
  onSave: (line: Omit<CartLine, "key">) => void;
  onClose: () => void;
}) {
  const [line, setLine] = useState<Omit<CartLine, "key">>(editing ?? defaultLine(item));
  const [touched, setTouched] = useState(false);
  const problem = validateSelection(item, line);
  const price = unitPrice(item, line) * line.quantity;
  const photo = imageUrl(item.image_path);
  const variations = item.variations.filter((v) => v.is_active);

  const toggleAddOn = (groupId: string, addOnId: string) => {
    const group = item.groups.find((g) => g.id === groupId)!;
    const inGroup = new Set(group.add_ons.map((a) => a.id));
    setLine((l) => {
      const selected = l.add_on_ids.includes(addOnId);
      if (selected) return { ...l, add_on_ids: l.add_on_ids.filter((id) => id !== addOnId) };
      // Single-choice groups behave like radio buttons.
      const base = group.max_select === 1 ? l.add_on_ids.filter((id) => !inGroup.has(id)) : l.add_on_ids;
      return { ...l, add_on_ids: [...base, addOnId] };
    });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      footer={
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-line" role="group" aria-label="Quantity">
            <button
              type="button"
              className="px-3 py-2 text-lg disabled:opacity-40"
              disabled={line.quantity <= 1}
              onClick={() => setLine((l) => ({ ...l, quantity: l.quantity - 1 }))}
              aria-label="Fewer"
            >
              −
            </button>
            <span className="w-8 text-center tabular-nums" aria-live="polite">
              {line.quantity}
            </span>
            <button
              type="button"
              className="px-3 py-2 text-lg disabled:opacity-40"
              disabled={line.quantity >= 50}
              onClick={() => setLine((l) => ({ ...l, quantity: l.quantity + 1 }))}
              aria-label="More"
            >
              +
            </button>
          </div>
          <button
            type="button"
            className={`${btnPrimary} flex-1 !py-3`}
            disabled={!item.is_available}
            onClick={() => {
              setTouched(true);
              if (!problem) onSave(line);
            }}
          >
            {!item.is_available ? "Unavailable" : editing ? "Update" : "Add"} · {money.format(price)}
          </button>
        </div>
      }
    >
      {photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="" className="-mx-5 -mt-4 mb-4 aspect-[16/10] w-[calc(100%+2.5rem)] max-w-none object-cover" />
      )}
      {item.description && <p className="text-sm text-ink-soft">{item.description}</p>}
      {(item.allergens.length > 0 || item.dietary_tags.length > 0) && (
        <p className="mt-2 text-xs text-ink-soft">
          {item.dietary_tags.length > 0 && <span className="capitalize">{item.dietary_tags.join(" · ")}</span>}
          {item.dietary_tags.length > 0 && item.allergens.length > 0 && " — "}
          {item.allergens.length > 0 && <>Contains {item.allergens.join(", ")}</>}
        </p>
      )}

      {variations.length > 0 && (
        <fieldset className="mt-5">
          <legend className="mb-2 font-medium">
            Choose one <span className="text-xs font-normal text-ink-soft">· required</span>
          </legend>
          <div className="space-y-2">
            {variations.map((v) => (
              <label key={v.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2.5 has-[:checked]:border-brand">
                <input
                  type="radio"
                  name="variation"
                  checked={line.variation_id === v.id}
                  onChange={() => setLine((l) => ({ ...l, variation_id: v.id }))}
                />
                <span className="flex-1 text-sm">{v.name}</span>
                {Number(v.price_delta) !== 0 && (
                  <span className="text-sm tabular-nums text-ink-soft">
                    {Number(v.price_delta) > 0 ? "+" : "−"}
                    {money.format(Math.abs(Number(v.price_delta)))}
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {item.groups.map((g) => {
        const count = g.add_ons.filter((a) => line.add_on_ids.includes(a.id)).length;
        const full = g.max_select != null && count >= g.max_select && g.max_select !== 1;
        const rule =
          g.min_select > 0 && g.max_select === g.min_select
            ? `choose ${g.min_select} · required`
            : [g.min_select > 0 ? `at least ${g.min_select} · required` : "optional", g.max_select ? `up to ${g.max_select}` : null]
                .filter(Boolean)
                .join(", ");
        return (
          <fieldset key={g.id} className="mt-5">
            <legend className="mb-2 font-medium">
              {g.name} <span className="text-xs font-normal text-ink-soft">· {rule}</span>
            </legend>
            <div className="space-y-2">
              {g.add_ons.map((a) => {
                const checked = line.add_on_ids.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2.5 has-[:checked]:border-brand ${
                      full && !checked ? "opacity-50" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={full && !checked}
                      onChange={() => toggleAddOn(g.id, a.id)}
                    />
                    <span className="flex-1 text-sm">{a.name}</span>
                    {Number(a.price) > 0 && <span className="text-sm tabular-nums text-ink-soft">+{money.format(Number(a.price))}</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <label className="mt-5 block">
        <span className="font-medium">Special instructions</span>
        <textarea
          value={line.special_instructions}
          maxLength={500}
          rows={2}
          placeholder="e.g. no salt, sauce on the side"
          onChange={(e) => setLine((l) => ({ ...l, special_instructions: e.target.value }))}
          className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
        />
      </label>

      {touched && problem && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {problem}
        </p>
      )}
    </Sheet>
  );
}

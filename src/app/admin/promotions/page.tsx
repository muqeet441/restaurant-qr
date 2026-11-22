import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { addDays, toZonedParts } from "@/lib/time";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, btnDanger, btnSecondary, btnSmall, input } from "@/components/ui";
import { deletePromotion, savePromotion, togglePromotion } from "./actions";

export const metadata: Metadata = { title: "Promotions" };

type Promo = {
  id: string;
  name: string;
  code: string | null;
  type: "percentage" | "fixed_amount" | "bogo";
  value: number;
  scope: "order" | "item" | "category";
  target_item_id: string | null;
  target_category_id: string | null;
  min_order_amount: number | null;
  starts_at: string | null;
  ends_at: string | null;
  active_days: number[] | null;
  start_time: string | null;
  end_time: string | null;
  max_uses: number | null;
  used_count: number;
  is_active: boolean;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function PromotionsPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const tz = ctx.restaurant.timezone;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });

  const [{ data: rows }, { data: items }, { data: categories }] = await Promise.all([
    supabase.from("discounts").select("*").eq("restaurant_id", rid).order("is_active", { ascending: false }).order("name"),
    supabase.from("menu_items").select("id, name").eq("restaurant_id", rid).order("name"),
    supabase.from("menu_categories").select("id, name").eq("restaurant_id", rid).order("sort_order"),
  ]);
  const promos = (rows ?? []) as Promo[];
  const itemName = new Map((items ?? []).map((i) => [i.id, i.name]));
  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]));

  const describe = (p: Promo) => {
    const what = p.type === "bogo" ? "Buy one, get one free" : p.type === "percentage" ? `${Number(p.value)}% off` : `${money.format(Number(p.value))} off`;
    const on = p.scope === "order" ? "the bill" : p.scope === "item" ? itemName.get(p.target_item_id ?? "") ?? "an item" : `${categoryName.get(p.target_category_id ?? "") ?? "a category"}`;
    const rules = [
      p.min_order_amount ? `min. ${money.format(Number(p.min_order_amount))}` : null,
      p.active_days?.length ? p.active_days.map((d) => DAYS[d]).join(", ") : null,
      p.start_time && p.end_time ? `${p.start_time.slice(0, 5)}–${p.end_time.slice(0, 5)}` : null,
      p.starts_at ? `from ${toZonedParts(p.starts_at, tz).date}` : null,
      p.ends_at ? `until ${addDays(toZonedParts(p.ends_at, tz).date, -1)}` : null,
      p.max_uses ? `${p.used_count}/${p.max_uses} used` : p.code ? `${p.used_count} used` : null,
    ].filter(Boolean);
    return { headline: `${what} ${p.type === "fixed_amount" && p.scope !== "order" ? "each " : ""}on ${on}`, rules };
  };

  function PromoFields({ p }: { p?: Promo }) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name" hint="Shown on the bill.">
            <input name="name" required defaultValue={p?.name} placeholder="Happy hour" className={input} />
          </Field>
          <Field label="Coupon code" hint="Leave empty to apply automatically when valid.">
            <input name="code" defaultValue={p?.code ?? ""} placeholder="SUMMER10" className={`${input} uppercase`} />
          </Field>
          <Field label="Type">
            <select name="type" defaultValue={p?.type ?? "percentage"} className={input}>
              <option value="percentage">Percentage off</option>
              <option value="fixed_amount">Amount off</option>
              <option value="bogo">Buy one, get one free</option>
            </select>
          </Field>
          <Field label="Value" hint="% or amount. Ignored for BOGO.">
            <input name="value" type="number" min={0} step="0.01" defaultValue={p ? Number(p.value) : 10} className={input} />
          </Field>
          <Field label="Applies to">
            <select name="scope" defaultValue={p?.scope ?? "order"} className={input}>
              <option value="order">Whole bill</option>
              <option value="item">One item</option>
              <option value="category">A category</option>
            </select>
          </Field>
          <Field label="Item" hint="When applying to one item.">
            <select name="target_item_id" defaultValue={p?.target_item_id ?? ""} className={input}>
              <option value="">—</option>
              {(items ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" hint="When applying to a category.">
            <select name="target_category_id" defaultValue={p?.target_category_id ?? ""} className={input}>
              <option value="">—</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Minimum bill">
            <input name="min_order_amount" type="number" min={0} step="0.01" defaultValue={p?.min_order_amount ?? ""} className={input} />
          </Field>
          <Field label="First day">
            <input name="starts_on" type="date" defaultValue={p?.starts_at ? toZonedParts(p.starts_at, tz).date : ""} className={input} />
          </Field>
          <Field label="Last day">
            <input name="ends_on" type="date" defaultValue={p?.ends_at ? addDays(toZonedParts(p.ends_at, tz).date, -1) : ""} className={input} />
          </Field>
          <Field label="From (time)">
            <input name="start_time" type="time" defaultValue={p?.start_time?.slice(0, 5) ?? ""} className={input} />
          </Field>
          <Field label="To (time)">
            <input name="end_time" type="time" defaultValue={p?.end_time?.slice(0, 5) ?? ""} className={input} />
          </Field>
          <Field label="Max uses" hint="Coupons only. Blank = unlimited.">
            <input name="max_uses" type="number" min={1} defaultValue={p?.max_uses ?? ""} className={input} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Days (none ticked = every day)</legend>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="active_days" value={i} defaultChecked={p?.active_days?.includes(i)} /> {d}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Promotions"
        description="Coupons are entered by the cashier. Promotions without a code apply to bills automatically while they're valid."
      />

      <Card className="mb-6">
        <h2 className="mb-3 font-semibold">New promotion</h2>
        <ActionForm action={savePromotion} submitLabel="Create promotion" resetOnSuccess>
          <PromoFields />
        </ActionForm>
      </Card>

      <div className="space-y-3">
        {promos.length === 0 && <p className="text-sm text-ink-soft">No promotions yet.</p>}
        {promos.map((p) => {
          const d = describe(p);
          return (
            <Card key={p.id} className={p.is_active ? "" : "opacity-60"}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{p.name}</h2>
                {p.code ? <Badge>Code {p.code}</Badge> : <Badge>Automatic</Badge>}
                {!p.is_active && <Badge>Off</Badge>}
                <div className="ml-auto flex gap-2">
                  <ActionForm action={togglePromotion} submitLabel={p.is_active ? "Turn off" : "Turn on"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="value" value={String(!p.is_active)} />
                  </ActionForm>
                  {p.used_count === 0 && (
                    <ActionForm action={deletePromotion} submitLabel="Delete" submitClassName={`${btnDanger} ${btnSmall}`} confirm={`Delete ${p.name}?`} inline>
                      <input type="hidden" name="id" value={p.id} />
                    </ActionForm>
                  )}
                </div>
              </div>
              <p className="mt-1 text-sm">{d.headline}</p>
              {d.rules.length > 0 && <p className="text-xs text-ink-soft">{d.rules.join(" · ")}</p>}
              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Edit</summary>
                <ActionForm action={savePromotion} submitLabel="Save" submitClassName={`${btnSecondary} ${btnSmall}`} className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={p.id} />
                  <PromoFields p={p} />
                </ActionForm>
              </details>
            </Card>
          );
        })}
      </div>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { imageUrl, type Variation } from "@/lib/menu";
import { ActionForm } from "@/components/action-form";
import { ImageInput } from "@/components/image-input";
import { Badge, Card, Field, PageHeader, btnDanger, btnSecondary, btnSmall, input } from "@/components/ui";
import {
  addVariation,
  deleteItem,
  removeItemImage,
  setItemFlag,
  setItemGroups,
  updateItem,
  updateVariation,
  uploadItemImage,
} from "../actions";

export const metadata: Metadata = { title: "Edit item" };

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });

  const { data: item } = await supabase
    .from("menu_items")
    .select("*")
    .eq("id", id)
    .eq("restaurant_id", rid)
    .maybeSingle();
  if (!item) notFound();

  const [{ data: categories }, { data: stations }, { data: taxes }, { data: variations }, { data: groups }, { data: linked }, { data: images }] =
    await Promise.all([
      supabase.from("menu_categories").select("id, name").eq("restaurant_id", rid).order("sort_order"),
      supabase.from("kitchen_stations").select("id, name, is_active").eq("restaurant_id", rid).order("sort_order"),
      supabase.from("tax_configurations").select("id, name, rate_pct, is_default").eq("restaurant_id", rid).eq("is_active", true),
      supabase.from("item_variations").select("*").eq("item_id", id).order("sort_order"),
      supabase.from("add_on_groups").select("id, name, min_select, max_select, add_ons(name)").eq("restaurant_id", rid).order("name"),
      supabase.from("item_add_on_groups").select("group_id").eq("item_id", id),
      supabase.from("menu_item_images").select("path").eq("item_id", id).limit(1),
    ]);
  const linkedIds = new Set((linked ?? []).map((l) => l.group_id));
  const photo = imageUrl(images?.[0]?.path);
  const defaultTax = (taxes ?? []).find((t) => t.is_default);

  return (
    <>
      <PageHeader
        title={item.name}
        description={`${money.format(Number(item.base_price))}${item.is_available ? "" : " · currently unavailable"}${item.is_active ? "" : " · inactive"}`}
        actions={
          <Link href="/admin/menu" className={btnSecondary}>
            Back to menu
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <h2 className="mb-3 font-semibold">Details</h2>
          <ActionForm action={updateItem} submitLabel="Save item">
            <input type="hidden" name="id" value={item.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input name="name" required defaultValue={item.name} className={input} />
              </Field>
              <Field label="Base price" hint="Options and extras add to this.">
                <input name="base_price" type="number" min={0} step="0.01" required defaultValue={item.base_price} className={input} />
              </Field>
              <Field label="Category">
                <select name="category_id" defaultValue={item.category_id} className={input}>
                  {(categories ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Kitchen station" hint="Where this item's tickets go.">
                <select name="station_id" defaultValue={item.station_id ?? ""} className={input}>
                  <option value="">None</option>
                  {(stations ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tax">
                <select name="tax_configuration_id" defaultValue={item.tax_configuration_id ?? ""} className={input}>
                  <option value="">{defaultTax ? `Default (${defaultTax.name})` : "No tax"}</option>
                  {(taxes ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {Number(t.rate_pct)}%
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sort order" hint="Lower numbers appear first.">
                <input name="sort_order" type="number" min={0} max={9999} defaultValue={item.sort_order} className={input} />
              </Field>
            </div>
            <Field label="Description" hint="Shown to customers.">
              <textarea name="description" rows={2} defaultValue={item.description ?? ""} className={input} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Allergens" hint="Comma separated, e.g. gluten, dairy, nuts">
                <input name="allergens" defaultValue={(item.allergens ?? []).join(", ")} className={input} />
              </Field>
              <Field label="Dietary tags" hint="e.g. vegetarian, vegan, halal, spicy">
                <input name="dietary_tags" defaultValue={(item.dietary_tags ?? []).join(", ")} className={input} />
              </Field>
            </div>
            <Field label="Preparation notes for the kitchen" hint="Not shown to customers.">
              <textarea name="prep_instructions" rows={2} defaultValue={item.prep_instructions ?? ""} className={input} />
            </Field>
          </ActionForm>
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 font-semibold">Photo</h2>
            {photo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt={item.name} className="mb-3 aspect-[4/3] w-full rounded-lg object-cover" />
            )}
            <ActionForm action={uploadItemImage} submitLabel={photo ? "Replace photo" : "Upload photo"} submitClassName={`${btnSecondary} ${btnSmall}`}>
              <input type="hidden" name="id" value={item.id} />
              <ImageInput />
            </ActionForm>
            {photo && (
              <div className="mt-3">
                <ActionForm action={removeItemImage} submitLabel="Remove photo" submitClassName={`${btnDanger} ${btnSmall}`} inline>
                  <input type="hidden" name="id" value={item.id} />
                </ActionForm>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Visibility</h2>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={setItemFlag} submitLabel={item.is_available ? "Mark unavailable" : "Mark available"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="flag" value="is_available" />
                <input type="hidden" name="value" value={String(!item.is_available)} />
              </ActionForm>
              <ActionForm action={setItemFlag} submitLabel={item.is_active ? "Hide from menu" : "Show on menu"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="flag" value="is_active" />
                <input type="hidden" name="value" value={String(!item.is_active)} />
              </ActionForm>
              <ActionForm
                action={deleteItem}
                submitLabel="Delete item"
                submitClassName={`${btnDanger} ${btnSmall}`}
                confirm={`Delete ${item.name}? Items that were ordered can't be deleted; hide them instead.`}
                inline
              >
                <input type="hidden" name="id" value={item.id} />
              </ActionForm>
            </div>
            <p className="mt-3 text-xs text-ink-soft">
              <strong>Unavailable</strong>: still listed but can&apos;t be ordered (e.g. sold out today).
              <br />
              <strong>Hidden</strong>: not shown to customers at all.
            </p>
          </Card>
        </div>

        <Card>
          <h2 className="font-semibold">Options</h2>
          <p className="mb-3 text-xs text-ink-soft">
            Customers pick exactly one, e.g. sizes. The price change is added to the base price.
          </p>
          <ul className="mb-4 divide-y divide-line">
            {((variations ?? []) as Variation[]).map((v) => (
              <li key={v.id} className={`flex flex-wrap items-center gap-2 py-2 ${v.is_active ? "" : "opacity-60"}`}>
                <span className="text-sm font-medium">{v.name}</span>
                <span className="text-sm tabular-nums text-ink-soft">
                  {Number(v.price_delta) >= 0 ? "+" : "−"}
                  {money.format(Math.abs(Number(v.price_delta)))}
                </span>
                {v.is_default && <Badge>Default</Badge>}
                {!v.is_active && <Badge>Off</Badge>}
                <div className="ml-auto flex gap-1">
                  {!v.is_default && v.is_active && (
                    <ActionForm action={updateVariation} submitLabel="Make default" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="item_id" value={item.id} />
                      <input type="hidden" name="action" value="default" />
                    </ActionForm>
                  )}
                  <ActionForm action={updateVariation} submitLabel={v.is_active ? "Turn off" : "Turn on"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="item_id" value={item.id} />
                    <input type="hidden" name="action" value="toggle" />
                    <input type="hidden" name="value" value={String(!v.is_active)} />
                  </ActionForm>
                  <ActionForm action={updateVariation} submitLabel="Delete" submitClassName={`${btnDanger} ${btnSmall}`} confirm={`Delete ${v.name}?`} inline>
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="item_id" value={item.id} />
                    <input type="hidden" name="action" value="delete" />
                  </ActionForm>
                </div>
              </li>
            ))}
            {!variations?.length && <li className="py-2 text-sm text-ink-soft">No options. The item is sold as is.</li>}
          </ul>
          <ActionForm action={addVariation} submitLabel="Add option" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
            <input type="hidden" name="item_id" value={item.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input name="name" required placeholder="Large" className={input} />
              </Field>
              <Field label="Price change" hint="Use a negative number for cheaper options.">
                <input name="price_delta" type="number" step="0.01" defaultValue="0" required className={input} />
              </Field>
            </div>
          </ActionForm>
        </Card>

        <Card>
          <h2 className="font-semibold">Extras</h2>
          <p className="mb-3 text-xs text-ink-soft">
            Which extra groups customers can choose from for this item.{" "}
            <Link href="/admin/menu/add-ons" className="underline">
              Manage groups
            </Link>
          </p>
          {groups?.length ? (
            <ActionForm action={setItemGroups} submitLabel="Save extras" submitClassName={`${btnSecondary} ${btnSmall}`}>
              <input type="hidden" name="item_id" value={item.id} />
              <div className="space-y-2">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="group_ids" value={g.id} defaultChecked={linkedIds.has(g.id)} className="mt-1" />
                    <span>
                      <span className="font-medium">{g.name}</span>
                      <span className="block text-xs text-ink-soft">
                        {(g.add_ons as { name: string }[]).map((a) => a.name).join(", ") || "No extras yet"} · choose{" "}
                        {g.min_select}–{g.max_select ?? "any"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-ink-soft">
              No extra groups yet. <Link href="/admin/menu/add-ons" className="underline">Create one</Link>.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

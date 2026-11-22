import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { imageUrl } from "@/lib/menu";
import { ActionForm } from "@/components/action-form";
import { ImageInput } from "@/components/image-input";
import { Badge, Card, Field, PageHeader, btnDanger, btnSecondary, btnSmall, input } from "@/components/ui";
import {
  createCategory,
  createItem,
  deleteCategory,
  moveCategory,
  setItemFlag,
  toggleCategory,
  updateCategory,
  uploadCategoryImage,
} from "./actions";

export const metadata: Metadata = { title: "Menu" };

type Category = {
  id: string;
  name: string;
  description: string | null;
  image_path: string | null;
  sort_order: number;
  is_active: boolean;
};
type Item = {
  id: string;
  category_id: string;
  name: string;
  base_price: number;
  is_available: boolean;
  is_active: boolean;
  station_id: string | null;
  sort_order: number;
};

export default async function MenuPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });

  const [{ data: cats }, { data: items }, { data: stations }, { data: images }] = await Promise.all([
    supabase.from("menu_categories").select("*").eq("restaurant_id", rid).order("sort_order").order("name"),
    supabase.from("menu_items").select("*").eq("restaurant_id", rid).order("sort_order").order("name"),
    supabase.from("kitchen_stations").select("id, name").eq("restaurant_id", rid),
    supabase.from("menu_item_images").select("item_id, path"),
  ]);
  const categories = (cats ?? []) as Category[];
  const allItems = (items ?? []) as Item[];
  const stationName = new Map((stations ?? []).map((s) => [s.id, s.name]));
  const imageByItem = new Map((images ?? []).map((i) => [i.item_id, i.path]));

  return (
    <>
      <PageHeader
        title="Menu"
        description="Customers see active categories and items. Unavailable items stay visible but can't be ordered."
        actions={
          <Link href="/admin/menu/add-ons" className={btnSecondary}>
            Manage extras
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Add a category</h2>
          <ActionForm action={createCategory} submitLabel="Add category" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
            <Field label="Name">
              <input name="name" required placeholder="Appetizers" className={input} />
            </Field>
            <Field label="Description">
              <input name="description" className={input} />
            </Field>
          </ActionForm>
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">Add an item</h2>
          {categories.length === 0 ? (
            <p className="text-sm text-ink-soft">Create a category first.</p>
          ) : (
            <ActionForm action={createItem} submitLabel="Add and edit details" submitClassName={`${btnSecondary} ${btnSmall}`}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Name">
                  <input name="name" required className={input} />
                </Field>
                <Field label="Category">
                  <select name="category_id" required className={input}>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Price">
                  <input name="base_price" type="number" min={0} step="0.01" required className={input} />
                </Field>
              </div>
            </ActionForm>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        {categories.map((c, index) => {
          const catItems = allItems.filter((i) => i.category_id === c.id);
          const photo = imageUrl(c.image_path);
          return (
            <Card key={c.id} className={c.is_active ? "" : "opacity-70"}>
              <div className="flex flex-wrap items-center gap-3">
                {photo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photo} alt="" className="size-12 rounded-lg object-cover" />
                )}
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">{c.name}</h2>
                  {c.description && <p className="text-xs text-ink-soft">{c.description}</p>}
                </div>
                {!c.is_active && <Badge>Hidden from customers</Badge>}
                <div className="ml-auto flex flex-wrap gap-1">
                  {(["up", "down"] as const).map((dir) => (
                    <ActionForm key={dir} action={moveCategory} submitLabel={dir === "up" ? "↑" : "↓"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="dir" value={dir} />
                    </ActionForm>
                  )).filter((_, i) => (i === 0 ? index > 0 : index < categories.length - 1))}
                </div>
              </div>

              <ul className="mt-4 divide-y divide-line border-t border-line">
                {catItems.length === 0 && <li className="py-3 text-sm text-ink-soft">No items yet.</li>}
                {catItems.map((i) => {
                  const img = imageUrl(imageByItem.get(i.id));
                  return (
                    <li key={i.id} className={`flex flex-wrap items-center gap-3 py-3 ${i.is_active ? "" : "opacity-60"}`}>
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt="" className="size-10 rounded-md object-cover" />
                      ) : (
                        <div className="size-10 rounded-md bg-muted" aria-hidden />
                      )}
                      <Link href={`/admin/menu/${i.id}`} className="min-w-0 flex-1 hover:underline">
                        <span className="font-medium">{i.name}</span>
                        <span className="block text-xs text-ink-soft">
                          {money.format(Number(i.base_price))}
                          {i.station_id ? ` · ${stationName.get(i.station_id) ?? "Station"}` : " · No station"}
                        </span>
                      </Link>
                      {!i.is_active && <Badge>Inactive</Badge>}
                      <ActionForm
                        action={setItemFlag}
                        submitLabel={i.is_available ? "Available" : "Unavailable"}
                        submitClassName={`${btnSmall} ${
                          i.is_available
                            ? "!bg-emerald-600 text-white hover:!bg-emerald-700"
                            : "border border-line bg-muted text-ink-soft"
                        } rounded-lg font-medium`}
                        inline
                      >
                        <input type="hidden" name="id" value={i.id} />
                        <input type="hidden" name="flag" value="is_available" />
                        <input type="hidden" name="value" value={String(!i.is_available)} />
                      </ActionForm>
                    </li>
                  );
                })}
              </ul>

              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Edit category</summary>
                <div className="mt-4 grid gap-6 lg:grid-cols-2">
                  <ActionForm action={updateCategory} submitLabel="Save" submitClassName={`${btnSecondary} ${btnSmall}`}>
                    <input type="hidden" name="id" value={c.id} />
                    <Field label="Name">
                      <input name="name" required defaultValue={c.name} className={input} />
                    </Field>
                    <Field label="Description">
                      <input name="description" defaultValue={c.description ?? ""} className={input} />
                    </Field>
                  </ActionForm>
                  <div className="space-y-4">
                    <ActionForm action={uploadCategoryImage} submitLabel="Upload photo" submitClassName={`${btnSecondary} ${btnSmall}`}>
                      <input type="hidden" name="id" value={c.id} />
                      <ImageInput />
                    </ActionForm>
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={toggleCategory} submitLabel={c.is_active ? "Hide category" : "Show category"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="active" value={String(!c.is_active)} />
                      </ActionForm>
                      {catItems.length === 0 && (
                        <ActionForm action={deleteCategory} submitLabel="Delete" submitClassName={`${btnDanger} ${btnSmall}`} confirm={`Delete ${c.name}?`} inline>
                          <input type="hidden" name="id" value={c.id} />
                        </ActionForm>
                      )}
                    </div>
                  </div>
                </div>
              </details>
            </Card>
          );
        })}
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, btnSecondary, btnSmall, input } from "@/components/ui";
import { saveStation, toggleStation } from "../menu/actions";

export const metadata: Metadata = { title: "Kitchen stations" };

export default async function StationsPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;

  const [{ data: stations }, { data: items }] = await Promise.all([
    supabase.from("kitchen_stations").select("*").eq("restaurant_id", rid).order("sort_order").order("name"),
    supabase.from("menu_items").select("station_id").eq("restaurant_id", rid).eq("is_active", true),
  ]);
  const counts = new Map<string, number>();
  let unrouted = 0;
  for (const i of items ?? []) {
    if (i.station_id) counts.set(i.station_id, (counts.get(i.station_id) ?? 0) + 1);
    else unrouted++;
  }

  return (
    <>
      <PageHeader
        title="Kitchen stations"
        description="Each menu item is routed to one station. Orders with items from several stations are split into one ticket per station."
      />

      {unrouted > 0 && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {unrouted} active item{unrouted === 1 ? " has" : "s have"} no station. Set one on the item&apos;s page.
        </p>
      )}

      <Card className="mb-6">
        <ActionForm action={saveStation} submitLabel="Add station" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
          <Field label="New station">
            <input name="name" required placeholder="Fry station" className={input} />
          </Field>
        </ActionForm>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(stations ?? []).map((s) => (
          <Card key={s.id} className={s.is_active ? "" : "opacity-60"}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-semibold">{s.name}</h2>
              <Badge>{counts.get(s.id) ?? 0} items</Badge>
              {!s.is_active && <Badge>Inactive</Badge>}
            </div>
            <ActionForm action={saveStation} submitLabel="Rename" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
              <input type="hidden" name="id" value={s.id} />
              <input name="name" required defaultValue={s.name} aria-label="Station name" className={`${input} !w-40 !py-1.5 text-xs`} />
            </ActionForm>
            <div className="mt-2">
              <ActionForm action={toggleStation} submitLabel={s.is_active ? "Deactivate" : "Activate"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                <input type="hidden" name="id" value={s.id} />
                <input type="hidden" name="value" value={String(!s.is_active)} />
              </ActionForm>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

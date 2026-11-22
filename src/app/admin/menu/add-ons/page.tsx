import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import type { AddOn } from "@/lib/menu";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, btnDanger, btnSecondary, btnSmall, input } from "@/components/ui";
import { addAddOn, deleteGroup, saveGroup, updateAddOn } from "../actions";

export const metadata: Metadata = { title: "Extras" };

function GroupFields({ g }: { g?: { name: string; min_select: number; max_select: number | null } }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Group name">
        <input name="name" required defaultValue={g?.name} placeholder="Burger extras" className={input} />
      </Field>
      <Field label="Minimum" hint="1 or more makes it mandatory.">
        <input name="min_select" type="number" min={0} max={20} defaultValue={g?.min_select ?? 0} className={input} />
      </Field>
      <Field label="Maximum" hint="Blank = no limit.">
        <input name="max_select" type="number" min={1} max={20} defaultValue={g?.max_select ?? ""} className={input} />
      </Field>
    </div>
  );
}

export default async function AddOnsPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });

  const [{ data: groups }, { data: links }] = await Promise.all([
    supabase
      .from("add_on_groups")
      .select("id, name, min_select, max_select, add_ons(*)")
      .eq("restaurant_id", ctx.restaurant.id)
      .order("name"),
    supabase.from("item_add_on_groups").select("group_id, menu_items(name)"),
  ]);
  const usedBy = new Map<string, string[]>();
  for (const l of (links ?? []) as unknown as { group_id: string; menu_items: { name: string } | null }[]) {
    usedBy.set(l.group_id, [...(usedBy.get(l.group_id) ?? []), l.menu_items?.name ?? "?"]);
  }

  return (
    <>
      <PageHeader
        title="Extras"
        description="Groups of add-ons and customizations, e.g. toppings or 'no onions'. Link groups to items on each item's page."
      />

      <Card className="mb-6">
        <h2 className="mb-3 font-semibold">New group</h2>
        <ActionForm action={saveGroup} submitLabel="Add group" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
          <GroupFields />
        </ActionForm>
      </Card>

      <div className="space-y-4">
        {(groups ?? []).map((g) => {
          const addOns = ((g.add_ons ?? []) as AddOn[]).sort((a, b) => a.sort_order - b.sort_order);
          const items = usedBy.get(g.id) ?? [];
          return (
            <Card key={g.id}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{g.name}</h2>
                <Badge>
                  Choose {g.min_select}–{g.max_select ?? "any"}
                </Badge>
                {g.min_select > 0 && <Badge>Required</Badge>}
              </div>
              <p className="mt-1 text-xs text-ink-soft">
                {items.length ? `Used by ${items.join(", ")}` : "Not linked to any item yet."}
              </p>

              <ul className="my-3 divide-y divide-line">
                {addOns.map((a) => (
                  <li key={a.id} className={`flex flex-wrap items-center gap-2 py-2 ${a.is_active ? "" : "opacity-60"}`}>
                    <span className="text-sm font-medium">{a.name}</span>
                    <span className="text-sm tabular-nums text-ink-soft">
                      {Number(a.price) > 0 ? `+${money.format(Number(a.price))}` : "Free"}
                    </span>
                    {!a.is_active && <Badge>Off</Badge>}
                    <div className="ml-auto flex gap-1">
                      <ActionForm action={updateAddOn} submitLabel={a.is_active ? "Turn off" : "Turn on"} submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="value" value={String(!a.is_active)} />
                      </ActionForm>
                      <ActionForm action={updateAddOn} submitLabel="Delete" submitClassName={`${btnDanger} ${btnSmall}`} confirm={`Delete ${a.name}?`} inline>
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="action" value="delete" />
                      </ActionForm>
                    </div>
                  </li>
                ))}
                {addOns.length === 0 && <li className="py-2 text-sm text-ink-soft">No extras in this group yet.</li>}
              </ul>

              <ActionForm action={addAddOn} submitLabel="Add extra" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
                <input type="hidden" name="group_id" value={g.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Name">
                    <input name="name" required placeholder="Extra cheese" className={input} />
                  </Field>
                  <Field label="Price">
                    <input name="price" type="number" min={0} step="0.01" defaultValue="0" required className={input} />
                  </Field>
                </div>
              </ActionForm>

              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Edit group</summary>
                <div className="mt-3 space-y-3">
                  <ActionForm action={saveGroup} submitLabel="Save group" submitClassName={`${btnSecondary} ${btnSmall}`}>
                    <input type="hidden" name="id" value={g.id} />
                    <GroupFields g={g} />
                  </ActionForm>
                  <ActionForm
                    action={deleteGroup}
                    submitLabel="Delete group"
                    submitClassName={`${btnDanger} ${btnSmall}`}
                    confirm={`Delete ${g.name} and its extras? Past orders keep their copies.`}
                    inline
                  >
                    <input type="hidden" name="id" value={g.id} />
                  </ActionForm>
                </div>
              </details>
            </Card>
          );
        })}
      </div>
    </>
  );
}

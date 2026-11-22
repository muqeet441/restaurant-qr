import type { SupabaseClient } from "@supabase/supabase-js";
import type { AddOn, AddOnGroup, Charge, MenuCategory, MenuItem, Tax, Variation } from "@/lib/menu";

export interface MenuData {
  categories: MenuCategory[];
  items: Map<string, MenuItem>;
  taxes: Tax[];
  charges: Charge[];
}

/**
 * Reads the menu as the signed-in guest. RLS returns only this restaurant's
 * active categories/items once the guest has joined a live session.
 */
export async function loadMenu(supabase: SupabaseClient, restaurantId: string): Promise<MenuData> {
  const [cats, items, variations, links, groups, addOns, images, taxes, charges] = await Promise.all([
    supabase.from("menu_categories").select("id, name, description, sort_order").eq("restaurant_id", restaurantId).eq("is_active", true).order("sort_order"),
    supabase
      .from("menu_items")
      .select("id, category_id, name, description, base_price, is_available, allergens, dietary_tags, tax_configuration_id, sort_order")
      .eq("restaurant_id", restaurantId)
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
    supabase.from("item_variations").select("*").eq("is_active", true).order("sort_order"),
    supabase.from("item_add_on_groups").select("item_id, group_id, sort_order").order("sort_order"),
    supabase.from("add_on_groups").select("id, name, min_select, max_select").eq("restaurant_id", restaurantId),
    supabase.from("add_ons").select("*").eq("is_active", true).order("sort_order"),
    supabase.from("menu_item_images").select("item_id, path, sort_order").order("sort_order"),
    supabase.from("tax_configurations").select("id, name, rate_pct, is_inclusive, is_default").eq("restaurant_id", restaurantId).eq("is_active", true),
    supabase.from("service_charges").select("id, name, rate_pct, fixed_amount").eq("restaurant_id", restaurantId).eq("is_active", true),
  ]);
  const failed = [cats, items, variations, links, groups, addOns, images, taxes, charges].find((r) => r.error);
  if (failed?.error) throw failed.error;

  const addOnsByGroup = new Map<string, AddOn[]>();
  for (const a of (addOns.data ?? []) as AddOn[]) {
    addOnsByGroup.set(a.group_id, [...(addOnsByGroup.get(a.group_id) ?? []), a]);
  }
  const groupById = new Map<string, AddOnGroup>(
    (groups.data ?? []).map((g) => [g.id, { ...g, add_ons: addOnsByGroup.get(g.id) ?? [] } as AddOnGroup]),
  );
  const groupsByItem = new Map<string, AddOnGroup[]>();
  for (const l of links.data ?? []) {
    const g = groupById.get(l.group_id);
    if (g) groupsByItem.set(l.item_id, [...(groupsByItem.get(l.item_id) ?? []), g]);
  }
  const variationsByItem = new Map<string, Variation[]>();
  for (const v of (variations.data ?? []) as Variation[]) {
    variationsByItem.set(v.item_id, [...(variationsByItem.get(v.item_id) ?? []), v]);
  }
  const imageByItem = new Map<string, string>();
  for (const i of images.data ?? []) if (!imageByItem.has(i.item_id)) imageByItem.set(i.item_id, i.path);

  const itemMap = new Map<string, MenuItem>();
  for (const i of items.data ?? []) {
    itemMap.set(i.id, {
      ...i,
      base_price: Number(i.base_price),
      image_path: imageByItem.get(i.id) ?? null,
      variations: variationsByItem.get(i.id) ?? [],
      // Groups with nothing left to choose and no minimum are just noise.
      groups: (groupsByItem.get(i.id) ?? []).filter((g) => g.add_ons.length > 0 || g.min_select > 0),
    } as MenuItem);
  }

  const categories: MenuCategory[] = (cats.data ?? [])
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      items: [...itemMap.values()].filter((i) => i.category_id === c.id),
    }))
    .filter((c) => c.items.length > 0);

  return {
    categories,
    items: itemMap,
    taxes: (taxes.data ?? []) as Tax[],
    charges: (charges.data ?? []) as Charge[],
  };
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import type { ActionState } from "@/components/action-form";

type Supabase = Awaited<ReturnType<typeof createClient>>;

const text = z.string().trim();
const uuidLike = (message: string) => z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);
const optionalText = text.transform((v) => (v === "" ? null : v)).nullable().optional();
const money = z.coerce.number().min(0, "Price can't be negative.").max(100000).multipleOf(0.01, "Use at most 2 decimals.");
const signedMoney = z.coerce.number().min(-100000).max(100000).multipleOf(0.01, "Use at most 2 decimals.");
const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

async function ctx() {
  const staff = await requireStaff(["admin"]);
  return { rid: staff.restaurant.id, supabase: await createClient() };
}

const fail = (error: unknown): ActionState => ({ error: friendlyError(error as { message?: string }) });
const issue = (e: z.ZodError): ActionState => ({ error: e.issues[0]?.message ?? "Invalid input." });

function done(ok: string, ...paths: string[]): ActionState {
  for (const p of paths.length ? paths : ["/admin/menu"]) revalidatePath(p);
  return { ok };
}

/** RLS only returns rows of the caller's restaurant, so this blocks cross-restaurant links. */
async function owns(supabase: Supabase, table: string, id: string | null | undefined, rid: string) {
  if (!id) return true;
  const { data } = await supabase.from(table).select("id").eq("id", id).eq("restaurant_id", rid).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------------
// Categories (10.1)
// ---------------------------------------------------------------------------
const categorySchema = z.object({
  name: text.min(1, "Name is required.").max(80),
  description: optionalText,
});

export async function createCategory(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const parsed = categorySchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  const { data: last } = await supabase
    .from("menu_categories")
    .select("sort_order")
    .eq("restaurant_id", rid)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase
    .from("menu_categories")
    .insert({ ...parsed.data, restaurant_id: rid, sort_order: (last?.sort_order ?? 0) + 1 });
  return error ? fail(error) : done(`Category "${parsed.data.name}" added.`);
}

export async function updateCategory(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const parsed = categorySchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  const { error } = await supabase.from("menu_categories").update(parsed.data).eq("id", String(fd.get("id")));
  return error ? fail(error) : done("Saved.");
}

export async function toggleCategory(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const { error } = await supabase
    .from("menu_categories")
    .update({ is_active: fd.get("active") === "true" })
    .eq("id", String(fd.get("id")));
  return error ? fail(error) : done("Updated.");
}

export async function moveCategory(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const id = String(fd.get("id"));
  const dir = fd.get("dir") === "up" ? -1 : 1;
  const { data: cats } = await supabase
    .from("menu_categories")
    .select("id, sort_order")
    .eq("restaurant_id", rid)
    .order("sort_order")
    .order("name");
  const order = (cats ?? []).map((c) => c.id);
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return null;
  [order[i], order[j]] = [order[j], order[i]];
  // Renumber everything so ties from older data disappear.
  for (const [index, cid] of order.entries()) {
    const { error } = await supabase.from("menu_categories").update({ sort_order: index + 1 }).eq("id", cid);
    if (error) return fail(error);
  }
  return done("Moved.");
}

export async function deleteCategory(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const { error } = await supabase.from("menu_categories").delete().eq("id", String(fd.get("id")));
  return error ? fail(error) : done("Category deleted.");
}

// ---------------------------------------------------------------------------
// Items (10.2)
// ---------------------------------------------------------------------------
export async function createItem(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const parsed = z
    .object({
      name: text.min(1, "Name is required.").max(120),
      category_id: uuidLike("Pick a category."),
      base_price: money,
    })
    .safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  if (!(await owns(supabase, "menu_categories", parsed.data.category_id, rid))) return { error: "Unknown category." };

  const { data, error } = await supabase
    .from("menu_items")
    .insert({ ...parsed.data, restaurant_id: rid })
    .select("id")
    .single();
  if (error) return fail(error);
  revalidatePath("/admin/menu");
  redirect(`/admin/menu/${data.id}`);
}

const itemSchema = z.object({
  name: text.min(1, "Name is required.").max(120),
  description: optionalText,
  category_id: uuidLike("Pick a category."),
  base_price: money,
  station_id: z.string().transform((v) => v || null),
  tax_configuration_id: z.string().transform((v) => v || null),
  prep_instructions: optionalText,
  sort_order: z.coerce.number().int().min(0).max(9999),
});

export async function updateItem(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const id = String(fd.get("id"));
  const parsed = itemSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  const d = parsed.data;
  const checks = await Promise.all([
    owns(supabase, "menu_categories", d.category_id, rid),
    owns(supabase, "kitchen_stations", d.station_id, rid),
    owns(supabase, "tax_configurations", d.tax_configuration_id, rid),
  ]);
  if (checks.includes(false)) return { error: "Unknown category, station or tax." };

  const { error } = await supabase
    .from("menu_items")
    .update({ ...d, allergens: list(fd.get("allergens")), dietary_tags: list(fd.get("dietary_tags")) })
    .eq("id", id);
  return error ? fail(error) : done("Item saved.", "/admin/menu", `/admin/menu/${id}`);
}

export async function setItemFlag(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const id = String(fd.get("id"));
  const flag = fd.get("flag") === "is_active" ? "is_active" : "is_available";
  const { error } = await supabase
    .from("menu_items")
    .update({ [flag]: fd.get("value") === "true" })
    .eq("id", id);
  return error ? fail(error) : done("Updated.", "/admin/menu", `/admin/menu/${id}`);
}

export async function deleteItem(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const id = String(fd.get("id"));
  const { data: images } = await supabase.from("menu_item_images").select("path").eq("item_id", id);
  const { error } = await supabase.from("menu_items").delete().eq("id", id);
  if (error) return fail(error);
  if (images?.length) await supabase.storage.from("menu-images").remove(images.map((i) => i.path));
  revalidatePath("/admin/menu");
  redirect("/admin/menu");
}

// ---------------------------------------------------------------------------
// Images (FR-125). The browser shrinks photos before upload; this re-checks.
// ---------------------------------------------------------------------------
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function uploadImage(supabase: Supabase, rid: string, prefix: string, file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image." } as const;
  const ext = IMAGE_TYPES[file.type];
  if (!ext) return { error: "Use a JPEG, PNG or WebP image." } as const;
  if (file.size > MAX_IMAGE_BYTES) return { error: "Images must be under 2 MB." } as const;
  const path = `${rid}/${prefix}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from("menu-images")
    .upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
  return error ? ({ error: friendlyError(error) } as const) : ({ path } as const);
}

export async function uploadItemImage(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const id = String(fd.get("id"));
  if (!(await owns(supabase, "menu_items", id, rid))) return { error: "Item not found." };
  const up = await uploadImage(supabase, rid, `item-${id}`, fd.get("image"));
  if ("error" in up) return { error: up.error };

  const { data: old } = await supabase.from("menu_item_images").select("id, path").eq("item_id", id);
  const { error } = await supabase.from("menu_item_images").insert({ item_id: id, path: up.path, sort_order: 0 });
  if (error) {
    await supabase.storage.from("menu-images").remove([up.path]);
    return fail(error);
  }
  if (old?.length) {
    await supabase.from("menu_item_images").delete().in("id", old.map((o) => o.id));
    await supabase.storage.from("menu-images").remove(old.map((o) => o.path));
  }
  return done("Photo updated.", "/admin/menu", `/admin/menu/${id}`);
}

export async function removeItemImage(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const id = String(fd.get("id"));
  const { data: old } = await supabase.from("menu_item_images").select("id, path").eq("item_id", id);
  if (old?.length) {
    await supabase.from("menu_item_images").delete().in("id", old.map((o) => o.id));
    await supabase.storage.from("menu-images").remove(old.map((o) => o.path));
  }
  return done("Photo removed.", "/admin/menu", `/admin/menu/${id}`);
}

export async function uploadCategoryImage(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const id = String(fd.get("id"));
  const { data: cat } = await supabase
    .from("menu_categories")
    .select("id, image_path")
    .eq("id", id)
    .eq("restaurant_id", rid)
    .maybeSingle();
  if (!cat) return { error: "Category not found." };
  const up = await uploadImage(supabase, rid, `category-${id}`, fd.get("image"));
  if ("error" in up) return { error: up.error };
  const { error } = await supabase.from("menu_categories").update({ image_path: up.path }).eq("id", id);
  if (error) return fail(error);
  if (cat.image_path) await supabase.storage.from("menu-images").remove([cat.image_path]);
  return done("Category photo updated.");
}

// ---------------------------------------------------------------------------
// Variations (FR-128)
// ---------------------------------------------------------------------------
export async function addVariation(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const itemId = String(fd.get("item_id"));
  const parsed = z
    .object({ name: text.min(1, "Name is required.").max(60), price_delta: signedMoney })
    .safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  if (!(await owns(supabase, "menu_items", itemId, rid))) return { error: "Item not found." };

  const { data: existing } = await supabase.from("item_variations").select("id").eq("item_id", itemId);
  const first = !existing?.length;
  const { error } = await supabase.from("item_variations").insert({
    ...parsed.data,
    item_id: itemId,
    is_default: first,
    sort_order: (existing?.length ?? 0) + 1,
  });
  return error ? fail(error) : done("Option added.", `/admin/menu/${itemId}`);
}

export async function updateVariation(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const id = String(fd.get("id"));
  const itemId = String(fd.get("item_id"));
  const action = String(fd.get("action"));

  if (action === "default") {
    await supabase.from("item_variations").update({ is_default: false }).eq("item_id", itemId);
    const { error } = await supabase.from("item_variations").update({ is_default: true, is_active: true }).eq("id", id);
    return error ? fail(error) : done("Default updated.", `/admin/menu/${itemId}`);
  }
  if (action === "toggle") {
    const active = fd.get("value") === "true";
    const { error } = await supabase
      .from("item_variations")
      .update(active ? { is_active: true } : { is_active: false, is_default: false })
      .eq("id", id);
    return error ? fail(error) : done("Updated.", `/admin/menu/${itemId}`);
  }
  if (action === "delete") {
    const { error } = await supabase.from("item_variations").delete().eq("id", id);
    return error ? fail(error) : done("Option deleted.", `/admin/menu/${itemId}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Add-on groups and add-ons (FR-129..132)
// ---------------------------------------------------------------------------
const groupSchema = z
  .object({
    name: text.min(1, "Name is required.").max(60),
    min_select: z.coerce.number().int().min(0).max(20),
    max_select: z
      .string()
      .transform((v) => (v.trim() === "" ? null : Number(v)))
      .pipe(z.number().int().min(1, "Maximum must be at least 1.").max(20).nullable()),
  })
  .refine((g) => g.max_select == null || g.max_select >= g.min_select, "Maximum can't be below minimum.");

export async function saveGroup(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const parsed = groupSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  const id = fd.get("id");
  const { error } = id
    ? await supabase.from("add_on_groups").update(parsed.data).eq("id", String(id))
    : await supabase.from("add_on_groups").insert({ ...parsed.data, restaurant_id: rid });
  return error ? fail(error) : done(id ? "Group saved." : "Group added.", "/admin/menu/add-ons");
}

export async function deleteGroup(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const { error } = await supabase.from("add_on_groups").delete().eq("id", String(fd.get("id")));
  return error ? fail(error) : done("Group deleted.", "/admin/menu/add-ons");
}

export async function addAddOn(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const groupId = String(fd.get("group_id"));
  const parsed = z
    .object({ name: text.min(1, "Name is required.").max(60), price: money })
    .safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  if (!(await owns(supabase, "add_on_groups", groupId, rid))) return { error: "Group not found." };
  const { count } = await supabase.from("add_ons").select("id", { count: "exact", head: true }).eq("group_id", groupId);
  const { error } = await supabase
    .from("add_ons")
    .insert({ ...parsed.data, group_id: groupId, sort_order: (count ?? 0) + 1 });
  return error ? fail(error) : done("Extra added.", "/admin/menu/add-ons");
}

export async function updateAddOn(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const id = String(fd.get("id"));
  const { error } =
    fd.get("action") === "delete"
      ? await supabase.from("add_ons").delete().eq("id", id)
      : await supabase.from("add_ons").update({ is_active: fd.get("value") === "true" }).eq("id", id);
  return error ? fail(error) : done("Updated.", "/admin/menu/add-ons");
}

export async function setItemGroups(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const itemId = String(fd.get("item_id"));
  if (!(await owns(supabase, "menu_items", itemId, rid))) return { error: "Item not found." };
  const wanted = fd.getAll("group_ids").map(String);
  const { data: valid } = wanted.length
    ? await supabase.from("add_on_groups").select("id").eq("restaurant_id", rid).in("id", wanted)
    : { data: [] as { id: string }[] };

  const { error: delError } = await supabase.from("item_add_on_groups").delete().eq("item_id", itemId);
  if (delError) return fail(delError);
  if (valid?.length) {
    const { error } = await supabase
      .from("item_add_on_groups")
      .insert(valid.map((g, i) => ({ item_id: itemId, group_id: g.id, sort_order: i })));
    if (error) return fail(error);
  }
  return done("Extras updated.", `/admin/menu/${itemId}`);
}

// ---------------------------------------------------------------------------
// Kitchen stations (FR-063, FR-064)
// ---------------------------------------------------------------------------
export async function saveStation(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { rid, supabase } = await ctx();
  const parsed = z.object({ name: text.min(1, "Name is required.").max(60) }).safeParse(Object.fromEntries(fd));
  if (!parsed.success) return issue(parsed.error);
  const id = fd.get("id");
  const { error } = id
    ? await supabase.from("kitchen_stations").update(parsed.data).eq("id", String(id))
    : await supabase.from("kitchen_stations").insert({ ...parsed.data, restaurant_id: rid });
  return error ? fail(error) : done(id ? "Station saved." : "Station added.", "/admin/stations");
}

export async function toggleStation(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await ctx();
  const { error } = await supabase
    .from("kitchen_stations")
    .update({ is_active: fd.get("value") === "true" })
    .eq("id", String(fd.get("id")));
  return error ? fail(error) : done("Updated.", "/admin/stations");
}

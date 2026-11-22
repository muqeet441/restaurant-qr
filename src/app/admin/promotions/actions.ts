"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import { addDays, zonedToUtc } from "@/lib/time";
import type { ActionState } from "@/components/action-form";

const blank = (v: unknown) => (v === "" || v == null ? null : v);

const schema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(80),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .max(30)
      .regex(/^[A-Z0-9_-]*$/, "Codes use letters, numbers, - and _ only.")
      .transform((v) => v || null),
    type: z.enum(["percentage", "fixed_amount", "bogo"]),
    value: z.coerce.number().min(0).max(100000),
    scope: z.enum(["order", "item", "category"]),
    target_item_id: z.preprocess(blank, z.string().nullable()),
    target_category_id: z.preprocess(blank, z.string().nullable()),
    min_order_amount: z.preprocess(blank, z.coerce.number().min(0).nullable()),
    starts_on: z.preprocess(blank, z.string().nullable()),
    ends_on: z.preprocess(blank, z.string().nullable()),
    start_time: z.preprocess(blank, z.string().nullable()),
    end_time: z.preprocess(blank, z.string().nullable()),
    max_uses: z.preprocess(blank, z.coerce.number().int().min(1).nullable()),
  })
  .refine((d) => d.type !== "percentage" || d.value <= 100, "A percentage can't be over 100.")
  .refine((d) => d.type === "bogo" || d.value > 0, "Enter a discount value.")
  .refine((d) => d.type !== "bogo" || d.scope !== "order", "Buy-one-get-one needs an item or category.")
  .refine((d) => d.scope !== "item" || d.target_item_id, "Pick the item.")
  .refine((d) => d.scope !== "category" || d.target_category_id, "Pick the category.")
  .refine((d) => !d.starts_on || !d.ends_on || d.ends_on >= d.starts_on, "The end date is before the start date.")
  .refine((d) => !d.start_time === !d.end_time, "Give both a start and an end time, or neither.");

export async function savePromotion(_p: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff(["admin"]);
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const d = parsed.data;
  const tz = ctx.restaurant.timezone;
  const days = fd.getAll("active_days").map(Number).filter((n) => n >= 0 && n <= 6);

  const row = {
    name: d.name,
    code: d.code,
    type: d.type,
    value: d.type === "bogo" ? 0 : d.value,
    scope: d.scope,
    target_item_id: d.scope === "item" ? d.target_item_id : null,
    target_category_id: d.scope === "category" ? d.target_category_id : null,
    min_order_amount: d.min_order_amount,
    starts_at: d.starts_on ? zonedToUtc(d.starts_on, "00:00", tz) : null,
    ends_at: d.ends_on ? zonedToUtc(addDays(d.ends_on, 1), "00:00", tz) : null,
    active_days: days.length && days.length < 7 ? days : null,
    start_time: d.start_time,
    end_time: d.end_time,
    max_uses: d.max_uses,
  };

  const supabase = await createClient();
  const id = String(fd.get("id") ?? "");
  const { error } = id
    ? await supabase.from("discounts").update(row).eq("id", id)
    : await supabase.from("discounts").insert({ ...row, restaurant_id: ctx.restaurant.id });
  if (error) return { error: error.message.includes("duplicate") ? "Another promotion already uses that code." : friendlyError(error) };
  revalidatePath("/admin/promotions");
  return { ok: id ? "Promotion saved." : "Promotion created." };
}

export async function togglePromotion(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("discounts")
    .update({ is_active: fd.get("value") === "true" })
    .eq("id", String(fd.get("id")));
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/promotions");
  return { ok: "Updated." };
}

export async function deletePromotion(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin"]);
  const supabase = await createClient();
  const { error } = await supabase.from("discounts").delete().eq("id", String(fd.get("id")));
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/promotions");
  return { ok: "Deleted." };
}

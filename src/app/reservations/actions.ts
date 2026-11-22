"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import { zonedToUtc } from "@/lib/time";
import type { ActionState } from "@/components/action-form";

const ROLES = ["admin", "manager", "waiter", "cashier"] as const;

const schema = z.object({
  customer_name: z.string().trim().min(1, "Name is required.").max(120),
  contact_number: z.string().trim().min(3, "Contact number is required.").max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
  guest_count: z.coerce.number().int().min(1).max(100),
  duration_minutes: z.coerce.number().int().min(15).max(600),
  table_id: z.string().transform((v) => v || null),
  special_instructions: z
    .string()
    .trim()
    .max(500)
    .transform((v) => v || null),
});

export async function saveReservation(_p: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff([...ROLES]);
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const { date, time, ...rest } = parsed.data;
  const row = { ...rest, reserved_for: zonedToUtc(date, time, ctx.restaurant.timezone) };

  const supabase = await createClient();
  const id = String(fd.get("id") ?? "");
  const { error } = id
    ? await supabase.from("reservations").update(row).eq("id", id)
    : await supabase.from("reservations").insert({ ...row, restaurant_id: ctx.restaurant.id, status: fd.get("confirm") === "on" ? "confirmed" : "pending" });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/reservations");
  return { ok: id ? "Reservation updated." : "Reservation saved." };
}

export async function setReservationStatus(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff([...ROLES]);
  const status = String(fd.get("status"));
  if (!["confirmed", "cancelled", "no_show"].includes(status)) return { error: "Unknown status." };
  const supabase = await createClient();
  const { error } = await supabase.from("reservations").update({ status }).eq("id", String(fd.get("id")));
  if (error) return { error: friendlyError(error) };
  revalidatePath("/reservations");
  return { ok: "Updated." };
}

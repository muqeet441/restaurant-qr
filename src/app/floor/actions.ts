"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import type { ActionState } from "@/components/action-form";

// The database functions re-check every permission; requireStaff only makes
// sure there is a signed-in staff member.

export async function openSession(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin", "manager", "waiter", "cashier"]);
  const guests = z.coerce.number().int().min(1).max(50).optional().safeParse(fd.get("guest_count") || undefined);
  if (!guests.success) return { error: "Guest count must be between 1 and 50." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("open_table_session", {
    p_table_id: String(fd.get("table_id")),
    p_guest_count: guests.data ?? null,
    p_reservation_id: String(fd.get("reservation_id") ?? "") || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/floor");
  return { ok: "Session opened." };
}

export async function closeSession(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin", "manager", "cashier"]);
  const supabase = await createClient();
  const reason = String(fd.get("reason") ?? "").trim();
  const { error } = await supabase.rpc("close_table_session", {
    p_session_id: String(fd.get("session_id")),
    p_exception_reason: reason || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/floor");
  return { ok: "Session closed." };
}

export async function transferSession(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase.rpc("transfer_session", {
    p_session_id: String(fd.get("session_id")),
    p_to_table_id: String(fd.get("to_table_id")),
    p_reason: String(fd.get("reason") ?? "").trim() || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/floor");
  return { ok: "Party moved." };
}

export async function mergeSessions(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin", "manager", "waiter"]);
  const supabase = await createClient();
  const { error } = await supabase.rpc("merge_sessions", {
    p_primary_session_id: String(fd.get("session_id")),
    p_merged_session_id: String(fd.get("merge_session_id")),
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/floor");
  return { ok: "Tables merged onto one bill." };
}

export async function markCleaned(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin", "manager", "waiter", "cashier"]);
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_table_cleaned", { p_table_id: String(fd.get("table_id")) });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/floor");
  return { ok: "Table available." };
}

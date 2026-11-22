"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import type { ActionState } from "@/components/action-form";

async function call(fn: string, args: Record<string, unknown>, ok: string): Promise<ActionState> {
  await requireStaff(["admin", "manager", "kitchen"]);
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/kitchen");
  return { ok };
}

const ticket = (fd: FormData) => String(fd.get("ticket_id") ?? "");

export async function acceptTicket(_p: ActionState, fd: FormData) {
  return call("accept_ticket", { p_ticket_id: ticket(fd) }, "Accepted.");
}

export async function startTicket(_p: ActionState, fd: FormData) {
  return call("start_ticket", { p_ticket_id: ticket(fd) }, "Cooking.");
}

export async function markReady(_p: ActionState, fd: FormData) {
  const items = fd.getAll("ticket_item_ids").map(String).filter(Boolean);
  return call("mark_ticket_items_ready", { p_ticket_id: ticket(fd), p_ticket_item_ids: items.length ? items : null }, "Ready.");
}

export async function reportUnavailable(_p: ActionState, fd: FormData) {
  return call(
    "report_item_unavailable",
    { p_ticket_item_id: String(fd.get("ticket_item_id") ?? ""), p_note: String(fd.get("note") ?? "").trim() || null },
    "Taken off the menu; the waiter has been told.",
  );
}

export async function messageWaiter(_p: ActionState, fd: FormData) {
  return call("kitchen_message_waiter", { p_ticket_id: ticket(fd), p_message: String(fd.get("message") ?? "") }, "Sent to the waiter.");
}

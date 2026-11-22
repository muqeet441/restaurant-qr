"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import type { ActionState } from "@/components/action-form";

// Every function re-checks the caller's role and the order state in the database.

async function call(fn: string, args: Record<string, unknown>, ok: string): Promise<ActionState> {
  await requireStaff(["admin", "manager", "waiter"]);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/waiter");
  return { ok: typeof data === "string" && data === "requested" ? "Sent to a manager for approval." : ok };
}

const id = (fd: FormData, key = "order_id") => String(fd.get(key) ?? "");
const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

export async function confirmOrder(_p: ActionState, fd: FormData) {
  return call("confirm_order", { p_order_id: id(fd) }, "Sent to the kitchen.");
}

export async function rejectOrder(_p: ActionState, fd: FormData) {
  return call("reject_order", { p_order_id: id(fd), p_reason: text(fd, "reason") }, "Order rejected.");
}

export async function askCustomer(_p: ActionState, fd: FormData) {
  return call("request_order_clarification", { p_order_id: id(fd), p_question: text(fd, "question") }, "Question sent.");
}

export async function serveItems(_p: ActionState, fd: FormData) {
  const ids = fd.getAll("item_ids").map(String).filter(Boolean);
  if (ids.length === 0) return { error: "Tick the items you're serving." };
  return call("serve_items", { p_order_item_ids: ids }, "Marked as served.");
}

export async function cancelItem(_p: ActionState, fd: FormData) {
  return call("cancel_order_item", { p_order_item_id: id(fd, "item_id"), p_reason: text(fd, "reason") }, "Item cancelled.");
}

export async function handleRequest(_p: ActionState, fd: FormData) {
  const done = fd.get("step") === "complete";
  return call(done ? "complete_service_request" : "accept_service_request", { p_request_id: id(fd, "request_id") }, done ? "Done." : "On your way.");
}

export async function reviewCancellation(_p: ActionState, fd: FormData) {
  const approve = fd.get("approve") === "true";
  return call("review_cancellation", { p_request_id: id(fd, "request_id"), p_approve: approve }, approve ? "Approved." : "Denied.");
}

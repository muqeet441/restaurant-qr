"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import type { ActionState } from "@/components/action-form";

// The database re-checks every permission, amount and state.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (fd: FormData, k: string) => {
  const v = str(fd, k);
  return v === "" ? null : Number(v);
};

async function call(fn: string, args: Record<string, unknown>, ok: string, ...paths: string[]) {
  await requireStaff(["admin", "manager", "cashier"]);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: friendlyError(error), data: null };
  for (const p of paths.length ? paths : ["/pos"]) revalidatePath(p, "layout");
  return { ok, data };
}

export async function prepareBill(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call("generate_invoice", { p_session_id: str(fd, "session_id") }, "Bill updated.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function openBill(fd: FormData) {
  const sessionId = str(fd, "session_id");
  await call("generate_invoice", { p_session_id: sessionId }, "");
  redirect(`/pos/session/${sessionId}`);
}

export async function finalizeBill(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call("finalize_invoice", { p_invoice_id: str(fd, "invoice_id") }, "Bill is final.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function voidBill(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call("void_invoice", { p_invoice_id: str(fd, "invoice_id"), p_reason: str(fd, "reason") }, "Invoice voided.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function addDiscount(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call(
    "apply_manual_discount",
    {
      p_invoice_id: str(fd, "invoice_id"),
      p_kind: str(fd, "kind") === "fixed_amount" ? "fixed_amount" : "percentage",
      p_value: num(fd, "value"),
      p_reason: str(fd, "reason"),
    },
    "Discount applied.",
  );
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function addCoupon(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call("apply_coupon", { p_invoice_id: str(fd, "invoice_id"), p_code: str(fd, "code") }, "Coupon applied.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function removeDiscount(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call("remove_discount", { p_application_id: str(fd, "application_id") }, "Removed.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export type PaymentState = { error?: string; ok?: string; change?: number | null; key?: string } | null;

export async function takePayment(_p: PaymentState, fd: FormData): Promise<PaymentState> {
  const items = fd.getAll("item_ids").map(String).filter(Boolean);
  const failed = fd.get("failed") === "on";
  const r = await call(
    "record_payment",
    {
      p_invoice_id: str(fd, "invoice_id"),
      p_method: str(fd, "method"),
      p_idempotency_key: str(fd, "key"),
      p_amount: items.length ? null : num(fd, "amount"),
      p_reference: str(fd, "reference") || null,
      p_tendered: str(fd, "method") === "cash" ? num(fd, "tendered") : null,
      p_invoice_item_ids: items.length ? items : null,
      p_payer_label: str(fd, "payer") || null,
      p_failed: failed,
      p_failure_reason: failed ? str(fd, "failure_reason") || null : null,
    },
    "",
  );
  if (r.error) return { error: r.error, key: str(fd, "key") };
  const res = r.data as { amount: number; change: number | null; status: string; duplicate: boolean };
  return {
    ok: res.status === "failed" ? "Failed attempt recorded. Nothing was charged." : `Payment of ${Number(res.amount).toFixed(2)} recorded.`,
    change: res.change,
    key: crypto.randomUUID(), // next payment gets a new key
  };
}

export async function refund(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call(
    "request_refund",
    { p_payment_id: str(fd, "payment_id"), p_amount: num(fd, "amount"), p_reason: str(fd, "reason") },
    "",
  );
  if (r.error) return { error: r.error };
  return { ok: r.data === "approved" ? "Refund recorded." : "Refund sent to a manager for approval." };
}

export async function reviewRefund(_p: ActionState, fd: FormData): Promise<ActionState> {
  const approve = fd.get("approve") === "true";
  const r = await call("review_refund", { p_refund_id: str(fd, "refund_id"), p_approve: approve }, approve ? "Approved." : "Denied.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function closeTable(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call(
    "close_table_session",
    { p_session_id: str(fd, "session_id"), p_exception_reason: str(fd, "reason") || null },
    "Table closed.",
  );
  if (r.error) return { error: r.error };
  redirect("/pos");
}

// --- Register ---------------------------------------------------------------
export async function openRegister(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call(
    "open_register_session",
    { p_register_id: str(fd, "register_id"), p_opening_balance: num(fd, "opening_balance") },
    "Register open.",
  );
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function closeRegister(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call(
    "close_register_session",
    { p_session_id: str(fd, "register_session_id"), p_counted_cash: num(fd, "counted_cash"), p_notes: str(fd, "notes") || null },
    "",
  );
  if (r.error) return { error: r.error };
  const s = r.data as { discrepancy: number };
  const d = Number(s.discrepancy);
  return { ok: d === 0 ? "Register closed. Cash matches." : `Register closed. Difference: ${d > 0 ? "+" : ""}${d.toFixed(2)}` };
}

export async function reviewRegister(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await call("review_register_session", { p_session_id: str(fd, "register_session_id"), p_notes: str(fd, "notes") || null }, "Reviewed.");
  return r.error ? { error: r.error } : { ok: r.ok };
}

export async function addRegister(_p: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff(["admin"]);
  const name = str(fd, "name");
  if (!name) return { error: "Name is required." };
  const supabase = await createClient();
  const { error } = await supabase.from("cash_registers").insert({ restaurant_id: ctx.restaurant.id, name });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/pos/register");
  return { ok: "Register added." };
}

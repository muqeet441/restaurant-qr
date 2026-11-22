"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff, isAdmin } from "@/lib/staff";
import { friendlyError } from "@/lib/errors";
import { STAFF_ROLES, type AppRole } from "@/lib/types";
import type { ActionState } from "@/components/action-form";

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Invalid input.";
}

async function adminContext() {
  const ctx = await requireStaff(["admin"]);
  if (!isAdmin(ctx)) throw new Error("forbidden");
  return { ctx, supabase: await createClient() };
}

// ---------------------------------------------------------------------------
// Tables & QR codes (FR-001, FR-006, FR-069..073)
// ---------------------------------------------------------------------------
const tableSchema = z.object({
  table_number: z.string().trim().min(1, "Table number is required.").max(20),
  name: optionalText,
  capacity: z.coerce.number().int().min(1, "Capacity must be at least 1.").max(50),
  location: optionalText,
});

export async function createTable(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const parsed = tableSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const { error } = await supabase
    .from("restaurant_tables")
    .insert({ ...parsed.data, restaurant_id: ctx.restaurant.id });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/tables");
  return { ok: `Table ${parsed.data.table_number} created.` };
}

export async function updateTable(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await adminContext();
  const id = String(fd.get("id"));
  const parsed = tableSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const { error } = await supabase.from("restaurant_tables").update(parsed.data).eq("id", id);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/tables");
  return { ok: "Saved." };
}

export async function setTableActive(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await adminContext();
  const { error } = await supabase
    .from("restaurant_tables")
    .update({ is_active: fd.get("active") === "true" })
    .eq("id", String(fd.get("id")));
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/tables");
  return { ok: "Updated." };
}

export async function regenerateQr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await adminContext();
  const { error } = await supabase.rpc("regenerate_table_qr", { p_table_id: String(fd.get("id")) });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/tables");
  return { ok: "New QR code generated. Reprint it — the old one no longer works." };
}

export async function assignWaiter(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff(["admin", "manager"]);
  const supabase = await createClient();
  const employee = String(fd.get("employee_id") ?? "");
  const { error } = await supabase.rpc("assign_table_waiter", {
    p_table_id: String(fd.get("id")),
    p_employee_id: employee || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/tables");
  return { ok: "Assigned." };
}

// ---------------------------------------------------------------------------
// Employees (Module 9)
// ---------------------------------------------------------------------------
const rolesSchema = z
  .array(z.enum(STAFF_ROLES as [AppRole, ...AppRole[]]))
  .min(1, "Pick at least one role.");

const employeeSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  phone: optionalText,
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export async function createEmployee(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const parsed = employeeSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const roles = rolesSchema.safeParse(fd.getAll("roles"));
  if (!roles.success) return { error: firstIssue(roles.error) };
  const stations = fd.getAll("stations").map(String);

  const admin = createAdminClient();
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { full_name: parsed.data.full_name },
  });
  if (authError || !created.user) {
    return {
      error: authError?.message.includes("already")
        ? "An account with that email already exists."
        : friendlyError(authError),
    };
  }
  const userId = created.user.id;

  // The service role creates the employee row; roles are then granted with the
  // admin's own session so RLS decides what they may grant.
  const { data: employee, error: empError } = await admin
    .from("employees")
    .insert({
      restaurant_id: ctx.restaurant.id,
      user_id: userId,
      full_name: parsed.data.full_name,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
    })
    .select("id")
    .single();

  const { error: roleError } = empError
    ? { error: empError }
    : await supabase
        .from("user_roles")
        .insert(roles.data.map((role) => ({ user_id: userId, restaurant_id: ctx.restaurant.id, role })));

  if (empError || roleError) {
    await admin.auth.admin.deleteUser(userId); // cascades employee + roles
    return { error: friendlyError(empError ?? roleError) };
  }

  if (stations.length && roles.data.includes("kitchen")) {
    await supabase
      .from("employee_station_assignments")
      .insert(stations.map((station_id) => ({ employee_id: employee!.id, station_id })));
  }

  revalidatePath("/admin/employees");
  return { ok: `${parsed.data.full_name} can now sign in.` };
}

/** Loads an employee of the caller's restaurant, through RLS. */
async function ownEmployee(supabase: Awaited<ReturnType<typeof createClient>>, id: string, restaurantId: string) {
  const { data } = await supabase
    .from("employees")
    .select("id, user_id, full_name")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return data;
}

export async function setEmployeeActive(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const emp = await ownEmployee(supabase, String(fd.get("id")), ctx.restaurant.id);
  if (!emp) return { error: "Employee not found." };
  const active = fd.get("active") === "true";
  if (!active && emp.user_id === ctx.userId) return { error: "You cannot deactivate yourself." };

  const { error } = await supabase.from("employees").update({ is_active: active }).eq("id", emp.id);
  if (error) return { error: friendlyError(error) };

  // Block (or restore) sign-in as well as data access.
  await createAdminClient().auth.admin.updateUserById(emp.user_id, {
    ban_duration: active ? "none" : "876000h",
  });
  revalidatePath("/admin/employees");
  return { ok: active ? "Reactivated." : "Deactivated." };
}

export async function resetEmployeePassword(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const emp = await ownEmployee(supabase, String(fd.get("id")), ctx.restaurant.id);
  if (!emp) return { error: "Employee not found." };
  const password = z.string().min(8, "Password must be at least 8 characters.").safeParse(fd.get("password"));
  if (!password.success) return { error: firstIssue(password.error) };

  const { error } = await createAdminClient().auth.admin.updateUserById(emp.user_id, {
    password: password.data,
  });
  if (error) return { error: friendlyError(error) };
  return { ok: `Password for ${emp.full_name} updated.` };
}

export async function updateEmployeeRoles(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const emp = await ownEmployee(supabase, String(fd.get("id")), ctx.restaurant.id);
  if (!emp) return { error: "Employee not found." };
  const roles = rolesSchema.safeParse(fd.getAll("roles"));
  if (!roles.success) return { error: firstIssue(roles.error) };
  if (emp.user_id === ctx.userId && !roles.data.includes("admin")) {
    return { error: "You cannot remove your own administrator role." };
  }

  const { data: current } = await supabase
    .from("user_roles")
    .select("id, role")
    .eq("user_id", emp.user_id)
    .eq("restaurant_id", ctx.restaurant.id);
  const have = new Set((current ?? []).map((r) => r.role as AppRole));
  const want = new Set(roles.data);

  const toAdd = [...want].filter((r) => !have.has(r));
  const toRemove = (current ?? []).filter((r) => !want.has(r.role as AppRole)).map((r) => r.id);

  if (toAdd.length) {
    const { error } = await supabase
      .from("user_roles")
      .insert(toAdd.map((role) => ({ user_id: emp.user_id, restaurant_id: ctx.restaurant.id, role })));
    if (error) return { error: friendlyError(error) };
  }
  if (toRemove.length) {
    const { error } = await supabase.from("user_roles").delete().in("id", toRemove);
    if (error) return { error: friendlyError(error) };
  }

  // Kitchen station assignments (FR-066)
  const stations = fd.getAll("stations").map(String);
  await supabase.from("employee_station_assignments").delete().eq("employee_id", emp.id);
  if (want.has("kitchen") && stations.length) {
    await supabase
      .from("employee_station_assignments")
      .insert(stations.map((station_id) => ({ employee_id: emp.id, station_id })));
  }

  revalidatePath("/admin/employees");
  return { ok: "Roles saved. They apply on the employee's next request." };
}

// ---------------------------------------------------------------------------
// Restaurant configuration, taxes, service charges
// ---------------------------------------------------------------------------
const restaurantSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  description: optionalText,
  address: optionalText,
  phone: optionalText,
  email: optionalText,
  currency: z.string().trim().toUpperCase().length(3, "Use a 3-letter currency code, e.g. USD."),
  timezone: z.string().trim().min(1),
});

export async function updateRestaurant(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const parsed = restaurantSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { error } = await supabase.from("restaurants").update(parsed.data).eq("id", ctx.restaurant.id);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin", "layout");
  return { ok: "Restaurant details saved." };
}

export async function updateSettings(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const parsed = z
    .object({
      pending_order_alert_minutes: z.coerce.number().int().min(1).max(120),
      manager_discount_limit_pct: z.coerce.number().min(0).max(100),
    })
    .safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const { error } = await supabase
    .from("restaurant_settings")
    .update({
      ...parsed.data,
      customer_can_open_session: fd.get("customer_can_open_session") === "on",
      require_cleaning: fd.get("require_cleaning") === "on",
    })
    .eq("restaurant_id", ctx.restaurant.id);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/settings");
  return { ok: "Settings saved." };
}

export async function addTax(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const parsed = z
    .object({
      name: z.string().trim().min(1, "Name is required."),
      rate_pct: z.coerce.number().min(0).max(100, "Rate must be 0–100%."),
    })
    .safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const makeDefault = fd.get("is_default") === "on";
  if (makeDefault) {
    await supabase
      .from("tax_configurations")
      .update({ is_default: false })
      .eq("restaurant_id", ctx.restaurant.id);
  }
  const { error } = await supabase.from("tax_configurations").insert({
    ...parsed.data,
    restaurant_id: ctx.restaurant.id,
    is_inclusive: fd.get("is_inclusive") === "on",
    is_default: makeDefault,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/settings");
  return { ok: "Tax added." };
}

export async function addServiceCharge(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, supabase } = await adminContext();
  const parsed = z
    .object({
      name: z.string().trim().min(1, "Name is required."),
      rate_pct: z.coerce.number().min(0).max(100, "Rate must be 0–100%."),
    })
    .safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { error } = await supabase
    .from("service_charges")
    .insert({ ...parsed.data, restaurant_id: ctx.restaurant.id });
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/settings");
  return { ok: "Service charge added." };
}

export async function toggleCharge(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { supabase } = await adminContext();
  const table = fd.get("kind") === "tax" ? "tax_configurations" : "service_charges";
  const { error } = await supabase
    .from(table)
    .update({ is_active: fd.get("active") === "true" })
    .eq("id", String(fd.get("id")));
  if (error) return { error: friendlyError(error) };
  revalidatePath("/admin/settings");
  return { ok: "Updated." };
}

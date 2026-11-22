import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AppRole, Employee, Restaurant } from "@/lib/types";

export interface StaffContext {
  userId: string;
  email: string;
  roles: AppRole[];
  restaurant: Restaurant;
  employee: Employee | null;
}

/**
 * Loads the signed-in staff member and their restaurant, or redirects.
 * `allowed` limits the page to those roles (super_admin always passes).
 */
export async function requireStaff(allowed?: AppRole[]): Promise<StaffContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) redirect("/login");

  const { data: roleRows } = await supabase
    .from("user_roles")
    .select("role, restaurant_id")
    .eq("user_id", user.id);
  const roles = (roleRows ?? []).map((r) => r.role as AppRole);
  if (roles.length === 0) redirect("/staff");
  if (allowed && !roles.some((r) => allowed.includes(r) || r === "super_admin")) redirect("/staff");

  const restaurantId = roleRows?.find((r) => r.restaurant_id)?.restaurant_id as string | undefined;
  const base = supabase.from("restaurants").select("*");
  const { data: restaurant } = restaurantId
    ? await base.eq("id", restaurantId).maybeSingle()
    : await base.order("created_at").limit(1).maybeSingle(); // super admin without a restaurant role
  if (!restaurant) redirect("/staff");

  const { data: employee } = await supabase
    .from("employees")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return { userId: user.id, email: user.email ?? "", roles, restaurant, employee };
}

export const isAdmin = (ctx: StaffContext) =>
  ctx.roles.includes("admin") || ctx.roles.includes("super_admin");

export const hasAnyRole = (ctx: StaffContext, roles: AppRole[]) =>
  ctx.roles.includes("super_admin") || ctx.roles.some((r) => roles.includes(r));

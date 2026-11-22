import "server-only";
import { cache } from "react";
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
 * Loads the signed-in staff member once per request (layouts, pages and
 * server actions share the result). One verified-JWT check plus two parallel
 * queries instead of several sequential round trips.
 */
const loadStaff = cache(async (): Promise<StaffContext | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims as { sub?: string; email?: string; is_anonymous?: boolean } | undefined;
  if (!claims?.sub || claims.is_anonymous) return null;
  const userId = claims.sub;

  const [{ data: roleRows }, { data: employee }] = await Promise.all([
    supabase.from("user_roles").select("role, restaurant_id, restaurants(*)").eq("user_id", userId),
    supabase.from("employees").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  const rows = (roleRows ?? []) as unknown as { role: AppRole; restaurant_id: string | null; restaurants: Restaurant | null }[];
  const roles = rows.map((r) => r.role);
  if (roles.length === 0) return { userId, email: claims.email ?? "", roles, restaurant: null as unknown as Restaurant, employee };

  let restaurant = rows.find((r) => r.restaurants)?.restaurants ?? null;
  if (!restaurant) {
    // Super admin without a restaurant role: use the first restaurant.
    const { data: first } = await supabase.from("restaurants").select("*").order("created_at").limit(1).maybeSingle();
    restaurant = first;
  }
  return { userId, email: claims.email ?? "", roles, restaurant: restaurant as Restaurant, employee: (employee as Employee) ?? null };
});

/**
 * The signed-in staff member and their restaurant, or a redirect.
 * `allowed` limits the page to those roles (super_admin always passes).
 */
export async function requireStaff(allowed?: AppRole[]): Promise<StaffContext> {
  const ctx = await loadStaff();
  if (!ctx) redirect("/login");
  if (ctx.roles.length === 0) redirect("/staff");
  if (allowed && !ctx.roles.some((r) => allowed.includes(r) || r === "super_admin")) redirect("/staff");
  if (!ctx.restaurant) redirect("/staff");
  return ctx;
}

export const isAdmin = (ctx: StaffContext) =>
  ctx.roles.includes("admin") || ctx.roles.includes("super_admin");

export const hasAnyRole = (ctx: StaffContext, roles: AppRole[]) =>
  ctx.roles.includes("super_admin") || ctx.roles.some((r) => roles.includes(r));

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { AppRole } from "@/lib/types";

// Which roles may open which staff areas. The database enforces the real rules;
// this only keeps people out of screens they cannot use.
const AREAS: { prefix: string; roles: AppRole[] }[] = [
  { prefix: "/admin", roles: ["super_admin", "admin"] },
  { prefix: "/floor", roles: ["super_admin", "admin", "manager", "waiter", "cashier"] },
  { prefix: "/waiter", roles: ["super_admin", "admin", "manager", "waiter"] },
  { prefix: "/kitchen", roles: ["super_admin", "admin", "manager", "kitchen"] },
  { prefix: "/pos", roles: ["super_admin", "admin", "manager", "cashier"] },
  { prefix: "/reservations", roles: ["super_admin", "admin", "manager", "waiter", "cashier"] },
  { prefix: "/staff", roles: ["super_admin", "admin", "manager", "waiter", "kitchen", "cashier"] },
];

type Claims = { sub?: string; is_anonymous?: boolean; app_roles?: { role: AppRole }[] };

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Refreshes the session cookie when needed and verifies the JWT. With
  // asymmetric signing keys this is a local check (no network round trip).
  const { data } = await supabase.auth.getClaims();
  const claims = (data?.claims ?? null) as Claims | null;

  const path = request.nextUrl.pathname;
  const area = AREAS.find((a) => path === a.prefix || path.startsWith(a.prefix + "/"));
  if (!area) return response;

  if (!claims?.sub || claims.is_anonymous) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }
  if (area.prefix === "/staff") return response;

  // Roles come from the access-token hook; fall back to the database only for
  // tokens issued before the hook was enabled.
  let mine = (claims.app_roles ?? []).map((r) => r.role);
  if (!claims.app_roles) {
    const { data: rows } = await supabase.from("user_roles").select("role").eq("user_id", claims.sub);
    mine = (rows ?? []).map((r) => r.role as AppRole);
  }
  if (!mine.some((r) => area.roles.includes(r))) {
    const url = request.nextUrl.clone();
    url.pathname = "/staff";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

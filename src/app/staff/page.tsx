import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui";
import { ROLE_LABELS, type AppRole } from "@/lib/types";
import { signOut } from "@/app/login/actions";

export const metadata: Metadata = { title: "Staff" };

const DESTINATIONS: { href: string; title: string; body: string; roles: AppRole[] }[] = [
  {
    href: "/waiter",
    title: "Waiter dashboard",
    body: "Confirm orders, serve ready food, handle cancellations.",
    roles: ["super_admin", "admin", "manager", "waiter"],
  },
  {
    href: "/kitchen",
    title: "Kitchen display",
    body: "Tickets by station: accept, cook, mark ready.",
    roles: ["super_admin", "admin", "manager", "kitchen"],
  },
  {
    href: "/floor",
    title: "Floor",
    body: "Table statuses, open and close sessions, cleaning.",
    roles: ["super_admin", "admin", "manager", "waiter", "cashier"],
  },
  {
    href: "/pos",
    title: "POS / Cashier",
    body: "Bills, discounts, split payments, refunds, cash register.",
    roles: ["super_admin", "admin", "manager", "cashier"],
  },
  {
    href: "/reservations",
    title: "Reservations",
    body: "Bookings by day, table assignment, arrivals and no-shows.",
    roles: ["super_admin", "admin", "manager", "waiter", "cashier"],
  },
  {
    href: "/admin",
    title: "Administration",
    body: "Tables & QR codes, employees, restaurant settings.",
    roles: ["super_admin", "admin"],
  },
];

const COMING: { title: string; roles: AppRole[] }[] = [];

export default async function StaffHome() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: rows } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user?.id ?? "");
  const roles = (rows ?? []).map((r) => r.role as AppRole);
  const open = DESTINATIONS.filter((d) => d.roles.some((r) => roles.includes(r)));
  const coming = COMING.filter((d) => d.roles.some((r) => roles.includes(r)));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Welcome</h1>
          <p className="text-sm text-ink-soft">
            {user?.email} · {roles.map((r) => ROLE_LABELS[r]).join(", ") || "No role assigned"}
          </p>
        </div>
        <form action={signOut}>
          <button className="text-sm text-ink-soft underline hover:text-ink">Sign out</button>
        </form>
      </div>

      {roles.length === 0 && (
        <Card>
          <p className="text-sm">
            Your account has no role yet. Ask a restaurant administrator to assign one.
          </p>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {open.map((d) => (
          <Link key={d.href} href={d.href} className="group">
            <Card className="h-full transition group-hover:border-brand">
              <h2 className="font-semibold">{d.title}</h2>
              <p className="mt-1 text-sm text-ink-soft">{d.body}</p>
            </Card>
          </Link>
        ))}
        {coming.map((d) => (
          <Card key={d.title} className="h-full opacity-60">
            <h2 className="font-semibold">{d.title}</h2>
            <p className="mt-1 text-sm text-ink-soft">Not built yet.</p>
          </Card>
        ))}
      </div>
    </main>
  );
}

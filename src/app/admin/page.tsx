import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminHome() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;

  const [tables, sessions, employees, taxes] = await Promise.all([
    supabase.from("restaurant_tables").select("id", { count: "exact", head: true }).eq("restaurant_id", rid).eq("is_active", true),
    supabase.from("table_sessions").select("id", { count: "exact", head: true }).eq("restaurant_id", rid).neq("status", "closed"),
    supabase.from("employees").select("id", { count: "exact", head: true }).eq("restaurant_id", rid).eq("is_active", true),
    supabase.from("tax_configurations").select("id", { count: "exact", head: true }).eq("restaurant_id", rid).eq("is_active", true),
  ]);

  const stats = [
    { label: "Active tables", value: tables.count ?? 0, href: "/admin/tables" },
    { label: "Live sessions", value: sessions.count ?? 0, href: "/floor" },
    { label: "Active employees", value: employees.count ?? 0, href: "/admin/employees" },
  ];

  const checklist = [
    { done: (tables.count ?? 0) > 0, text: "Create your tables", href: "/admin/tables" },
    { done: (tables.count ?? 0) > 0, text: "Print the table QR codes", href: "/admin/tables/qr" },
    { done: (employees.count ?? 0) > 1, text: "Add waiters, kitchen staff and cashiers", href: "/admin/employees" },
    { done: (taxes.count ?? 0) > 0, text: "Configure taxes and service charges", href: "/admin/settings" },
  ];

  return (
    <>
      <PageHeader title="Overview" description={ctx.restaurant.address ?? undefined} />
      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="transition hover:border-brand">
              <p className="text-sm text-ink-soft">{s.label}</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</p>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="mt-6">
        <h2 className="font-semibold">Setup checklist</h2>
        <ul className="mt-3 space-y-2">
          {checklist.map((c) => (
            <li key={c.text} className="flex items-center gap-3 text-sm">
              <span
                aria-hidden
                className={`grid size-5 place-items-center rounded-full text-xs ${
                  c.done ? "bg-emerald-600 text-white" : "border border-line"
                }`}
              >
                {c.done ? "✓" : ""}
              </span>
              <Link href={c.href} className="hover:underline">
                {c.text}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-ink-soft">
          Menu management, ordering, kitchen and billing screens arrive in the next phases.
        </p>
      </Card>
    </>
  );
}

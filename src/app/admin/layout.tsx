import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { signOut } from "@/app/login/actions";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/menu", label: "Menu" },
  { href: "/admin/menu/add-ons", label: "Extras" },
  { href: "/admin/stations", label: "Kitchen stations" },
  { href: "/admin/promotions", label: "Promotions" },
  { href: "/admin/feedback", label: "Feedback" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/tables", label: "Tables & QR" },
  { href: "/admin/employees", label: "Employees" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/floor", label: "Floor view" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaff(["admin"]);
  return (
    <div className="min-h-screen md:flex">
      <aside className="no-print border-b border-line bg-surface md:min-h-screen md:w-56 md:border-b-0 md:border-r">
        <div className="px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">TableQR Admin</p>
          <p className="mt-1 truncate text-sm font-medium">{ctx.restaurant.name}</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:pb-0">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink-soft hover:bg-muted hover:text-ink"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <form action={signOut} className="hidden px-4 py-4 md:block">
          <p className="truncate text-xs text-ink-soft">{ctx.email}</p>
          <button className="mt-1 text-xs text-ink-soft underline hover:text-ink">Sign out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}

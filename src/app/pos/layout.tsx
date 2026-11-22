import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { NotificationBell } from "@/components/notification-bell";

export default async function PosLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaff(["admin", "manager", "cashier"]);
  return (
    <div className="min-h-screen">
      <header className="no-print border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          <Link href="/pos" className="font-semibold">
            <span className="text-brand">POS</span> · {ctx.restaurant.name}
          </Link>
          <nav className="flex gap-4 text-sm text-ink-soft">
            <Link href="/pos" className="hover:text-ink">
              Tables & bills
            </Link>
            <Link href="/pos/register" className="hover:text-ink">
              Cash register
            </Link>
            <Link href="/floor" className="hover:text-ink">
              Floor
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <NotificationBell userId={ctx.userId} />
            <Link href="/staff" className="text-sm text-ink-soft underline">
              Home
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}

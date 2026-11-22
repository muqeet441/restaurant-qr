import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { addDays, todayIn, zonedToUtc } from "@/lib/time";
import { PageHeader, btnSecondary, btnSmall, input } from "@/components/ui";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE = 50;
const TABLES = [
  "invoices", "payments", "refunds", "discount_applications", "discounts", "cash_register_sessions",
  "table_sessions", "restaurant_tables", "reservations", "menu_items", "order_cancellation_requests",
  "employees", "user_roles", "restaurants", "restaurant_settings", "tax_configurations", "service_charges",
];
const SKIP = new Set(["updated_at", "created_at"]);

/** Fields whose value changed between old and new rows. */
function changes(oldRow: Record<string, unknown> | null, newRow: Record<string, unknown> | null) {
  if (!oldRow || !newRow) return [];
  return Object.keys(newRow)
    .filter((k) => !SKIP.has(k) && JSON.stringify(oldRow[k]) !== JSON.stringify(newRow[k]))
    .map((k) => ({ field: k, from: oldRow[k], to: newRow[k] }));
}
const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string; actor?: string; from?: string; to?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const tz = ctx.restaurant.timezone;
  const page = Math.max(1, Number(sp.page) || 1);
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : todayIn(tz, -7);
  const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : todayIn(tz);
  const when = new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "medium", timeZone: tz });

  let q = supabase
    .from("audit_logs")
    .select("id, actor_id, table_name, record_id, action, old_data, new_data, created_at", { count: "exact" })
    .eq("restaurant_id", ctx.restaurant.id)
    .gte("created_at", zonedToUtc(from, "00:00", tz))
    .lt("created_at", zonedToUtc(addDays(to, 1), "00:00", tz))
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (sp.table && TABLES.includes(sp.table)) q = q.eq("table_name", sp.table);
  if (sp.actor) q = q.eq("actor_id", sp.actor);

  const [{ data, count }, { data: employees }] = await Promise.all([
    q,
    supabase.from("employees").select("user_id, full_name").eq("restaurant_id", ctx.restaurant.id).order("full_name"),
  ]);
  const nameOf = new Map((employees ?? []).map((e) => [e.user_id, e.full_name]));
  const rows = (data ?? []) as {
    id: number;
    actor_id: string | null;
    table_name: string;
    record_id: string | null;
    action: string;
    old_data: Record<string, unknown> | null;
    new_data: Record<string, unknown> | null;
    created_at: string;
  }[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const qs = (extra: Record<string, string | number>) =>
    "?" + new URLSearchParams({ ...(sp.table ? { table: sp.table } : {}), ...(sp.actor ? { actor: sp.actor } : {}), from, to, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString();

  return (
    <>
      <PageHeader title="Audit log" description="Changes to sensitive records: who, what and when (NFR-012)." />

      <form className="mb-5 flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <span className="block text-xs text-ink-soft">Record type</span>
          <select name="table" defaultValue={sp.table ?? ""} className={`${input} !w-52`}>
            <option value="">All</option>
            {TABLES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-ink-soft">By</span>
          <select name="actor" defaultValue={sp.actor ?? ""} className={`${input} !w-48`}>
            <option value="">Anyone</option>
            {(employees ?? []).map((e) => (
              <option key={e.user_id} value={e.user_id}>
                {e.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-ink-soft">From</span>
          <input type="date" name="from" defaultValue={from} className={`${input} !w-40`} />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-ink-soft">To</span>
          <input type="date" name="to" defaultValue={to} className={`${input} !w-40`} />
        </label>
        <button className={`${btnSecondary} ${btnSmall}`}>Filter</button>
        <span className="ml-auto text-xs text-ink-soft">{count ?? 0} entries</span>
      </form>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-line text-left text-xs text-ink-soft">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Who</th>
              <th className="px-4 py-2 font-medium">What</th>
              <th className="px-4 py-2 font-medium">Changes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line align-top">
            {rows.map((r) => {
              const diff = changes(r.old_data, r.new_data);
              const label = (r.new_data ?? r.old_data) as Record<string, unknown> | null;
              const name = label?.invoice_number ?? label?.name ?? label?.full_name ?? label?.table_number ?? label?.customer_name;
              return (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-soft">{when.format(new Date(r.created_at))}</td>
                  <td className="px-4 py-2">{r.actor_id ? nameOf.get(r.actor_id) ?? "Customer / system" : "System"}</td>
                  <td className="px-4 py-2">
                    <span className="capitalize">{r.action}</span> {r.table_name.replace(/_/g, " ")}
                    {name ? <span className="text-ink-soft"> · {String(name)}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {r.action === "update" ? (
                      diff.length ? (
                        <ul className="space-y-0.5">
                          {diff.slice(0, 8).map((c) => (
                            <li key={c.field}>
                              <span className="font-medium">{c.field}</span>: <span className="text-ink-soft line-through">{show(c.from)}</span> → {show(c.to)}
                            </li>
                          ))}
                          {diff.length > 8 && <li className="text-ink-soft">+{diff.length - 8} more</li>}
                        </ul>
                      ) : (
                        <span className="text-ink-soft">—</span>
                      )
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-ink-soft">Record</summary>
                        <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                          {JSON.stringify(r.new_data ?? r.old_data, null, 1)}
                        </pre>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-soft">
                  Nothing in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <nav className="mt-6 flex gap-3 text-sm">
          {page > 1 && <Link href={`/admin/audit${qs({ page: page - 1 })}`} className="underline">Newer</Link>}
          <span className="text-ink-soft">Page {page} of {pages}</span>
          {page < pages && <Link href={`/admin/audit${qs({ page: page + 1 })}`} className="underline">Older</Link>}
        </nav>
      )}
    </>
  );
}

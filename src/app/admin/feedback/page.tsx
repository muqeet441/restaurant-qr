import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Feedback" };
export const dynamic = "force-dynamic";

const PAGE = 30;

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: ctx.restaurant.timezone });

  const { data, count } = await supabase
    .from("customer_feedback")
    .select("id, rating, comment, created_at, table_sessions!inner(restaurant_id, restaurant_tables(table_number))", { count: "exact" })
    .eq("table_sessions.restaurant_id", ctx.restaurant.id)
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  const rows = (data ?? []) as unknown as {
    id: string;
    rating: number;
    comment: string | null;
    created_at: string;
    table_sessions: { restaurant_tables: { table_number: string } | null };
  }[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));

  return (
    <>
      <PageHeader title="Customer feedback" description="Ratings customers leave after paying." />
      {rows.length === 0 && <p className="text-sm text-ink-soft">No feedback yet.</p>}
      <div className="space-y-3">
        {rows.map((f) => (
          <Card key={f.id}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg tracking-wider text-amber-500" aria-label={`${f.rating} out of 5`}>
                {"★".repeat(f.rating)}
                <span className="text-line">{"★".repeat(5 - f.rating)}</span>
              </span>
              <span className="text-sm text-ink-soft">Table {f.table_sessions.restaurant_tables?.table_number ?? "?"}</span>
              <span className="ml-auto text-xs text-ink-soft">{when.format(new Date(f.created_at))}</span>
            </div>
            {f.comment && <p className="mt-2 text-sm">{f.comment}</p>}
          </Card>
        ))}
      </div>
      {pages > 1 && (
        <nav className="mt-6 flex gap-3 text-sm">
          {page > 1 && <Link href={`/admin/feedback?page=${page - 1}`} className="underline">Newer</Link>}
          <span className="text-ink-soft">Page {page} of {pages}</span>
          {page < pages && <Link href={`/admin/feedback?page=${page + 1}`} className="underline">Older</Link>}
        </nav>
      )}
    </>
  );
}

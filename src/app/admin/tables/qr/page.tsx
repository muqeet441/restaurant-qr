import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { siteUrl, tableUrl } from "@/lib/site";
import { btnPrimary, btnSecondary } from "@/components/ui";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Print QR codes" };

export default async function QrSheet({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const base = await siteUrl();

  let query = supabase
    .from("restaurant_tables")
    .select("id, table_number, name, qr_token")
    .eq("restaurant_id", ctx.restaurant.id)
    .eq("is_active", true);
  if (id) query = query.eq("id", id);
  const { data } = await query;

  const tables = (data ?? [])
    .filter((t) => t.qr_token)
    .sort((a, b) => a.table_number.localeCompare(b.table_number, undefined, { numeric: true }));

  const cards = await Promise.all(
    tables.map(async (t) => ({
      ...t,
      svg: await QRCode.toString(tableUrl(base, t.qr_token!), {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
      }),
    })),
  );

  return (
    <>
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">QR codes</h1>
          <p className="text-sm text-ink-soft">
            Codes point to <code>{base}</code>. Set <code>NEXT_PUBLIC_SITE_URL</code> to your
            production domain before printing.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/tables" className={btnSecondary}>
            Back
          </Link>
          <PrintButton className={btnPrimary} />
        </div>
      </div>

      {cards.length === 0 && <p className="text-sm text-ink-soft">No active tables.</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
        {cards.map((c) => (
          <div
            key={c.id}
            className="flex break-inside-avoid flex-col items-center rounded-xl border border-line bg-white p-5 text-center text-black print:rounded-none print:border-black"
          >
            <p className="text-xs font-semibold uppercase tracking-wide">{ctx.restaurant.name}</p>
            <p className="mt-1 text-2xl font-bold">Table {c.table_number}</p>
            <div className="my-3 w-44" dangerouslySetInnerHTML={{ __html: c.svg }} />
            <p className="text-sm font-medium">Scan to see the menu and order</p>
          </div>
        ))}
      </div>
    </>
  );
}

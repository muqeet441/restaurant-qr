import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Receipt, type ReceiptData } from "@/components/receipt";
import { btnSecondary } from "@/components/ui";
import { PrintButton } from "@/app/admin/tables/qr/print-button";

export const metadata: Metadata = { title: "Receipt", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Public digital receipt (FR-099). The unguessable token is the only key. */
export default async function DigitalReceipt({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{40}$/.test(token)) notFound();
  const { data } = await createAdminClient().rpc("get_receipt", { p_token: token });
  if (!data) notFound();

  return (
    <main className="min-h-screen bg-muted px-4 py-8">
      <div className="mx-auto max-w-sm overflow-hidden rounded-xl shadow-lg">
        <Receipt data={data as ReceiptData} />
      </div>
      <div className="no-print mt-4 flex justify-center">
        <PrintButton className={btnSecondary} />
      </div>
    </main>
  );
}

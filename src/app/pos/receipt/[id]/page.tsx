import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { siteUrl } from "@/lib/site";
import { Receipt, type ReceiptData } from "@/components/receipt";
import { btnPrimary } from "@/components/ui";
import { PrintButton } from "@/app/admin/tables/qr/print-button";

export const metadata: Metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

export default async function PrintReceipt({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaff(["admin", "manager", "cashier"]);
  // RLS confirms the invoice belongs to this cashier's restaurant.
  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("invoices")
    .select("receipt_token")
    .eq("id", id)
    .eq("restaurant_id", ctx.restaurant.id)
    .maybeSingle();
  if (!inv?.receipt_token) notFound();

  const { data } = await createAdminClient().rpc("get_receipt", { p_token: inv.receipt_token });
  if (!data) notFound();
  const url = `${await siteUrl()}/r/${inv.receipt_token}`;

  return (
    <div>
      <style>{`@media print { @page { size: 80mm auto; margin: 0 } }`}</style>
      <div className="no-print mb-4 flex justify-center">
        <PrintButton className={btnPrimary} />
      </div>
      <div className="flex justify-center">
        <div className="rounded-lg border border-line print:border-0">
          <Receipt data={data as ReceiptData} url={url} />
        </div>
      </div>
    </div>
  );
}

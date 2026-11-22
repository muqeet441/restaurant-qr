import type { Metadata } from "next";
import { CustomerTable } from "./customer-table";

export const metadata: Metadata = {
  title: "Menu",
  robots: { index: false, follow: false },
};

export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CustomerTable token={token} />;
}

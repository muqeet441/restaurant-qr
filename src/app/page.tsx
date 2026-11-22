import Link from "next/link";
import { btnPrimary } from "@/components/ui";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand">TableQR</p>
      <h1 className="mt-2 text-3xl font-semibold text-ink">Restaurant operations</h1>
      <p className="mt-3 text-ink-soft">
        Guests order by scanning the QR code on their table. Staff sign in below to manage
        tables, sessions and the restaurant.
      </p>
      <div className="mt-8">
        <Link href="/login" className={btnPrimary}>
          Staff sign in
        </Link>
      </div>
    </main>
  );
}

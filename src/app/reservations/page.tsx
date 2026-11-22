import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { addDays, todayIn, toZonedParts, zonedToUtc } from "@/lib/time";
import { ActionForm } from "@/components/action-form";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Card, Field, PageHeader, btnDanger, btnSecondary, btnSmall, input } from "@/components/ui";
import { saveReservation, setReservationStatus } from "./actions";

export const metadata: Metadata = { title: "Reservations" };
export const dynamic = "force-dynamic";

type Reservation = {
  id: string;
  table_id: string | null;
  customer_name: string;
  contact_number: string;
  reserved_for: string;
  duration_minutes: number;
  guest_count: number;
  special_instructions: string | null;
  status: string;
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  confirmed: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  arrived: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  completed: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  cancelled: "bg-slate-200 text-slate-500 line-through dark:bg-slate-800",
  no_show: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date: dateParam } = await searchParams;
  const ctx = await requireStaff(["admin", "manager", "waiter", "cashier"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const tz = ctx.restaurant.timezone;
  const today = todayIn(tz);
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;
  const clock = new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: tz });
  const dayLabel = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

  const [{ data: rows }, { data: tableRows }] = await Promise.all([
    supabase
      .from("reservations")
      .select("*")
      .eq("restaurant_id", rid)
      .gte("reserved_for", zonedToUtc(date, "00:00", tz))
      .lt("reserved_for", zonedToUtc(addDays(date, 1), "00:00", tz))
      .order("reserved_for"),
    supabase.from("restaurant_tables").select("id, table_number, capacity").eq("restaurant_id", rid).eq("is_active", true),
  ]);
  const reservations = (rows ?? []) as Reservation[];
  const tables = (tableRows ?? []).sort((a, b) => a.table_number.localeCompare(b.table_number, undefined, { numeric: true }));
  const tableNumber = new Map(tables.map((t) => [t.id, t.table_number]));
  const active = reservations.filter((r) => ["pending", "confirmed", "arrived"].includes(r.status));
  const covers = active.reduce((n, r) => n + r.guest_count, 0);

  function ReservationFields({ r }: { r?: Reservation }) {
    const parts = r ? toZonedParts(r.reserved_for, tz) : { date, time: "19:00" };
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <input name="customer_name" required defaultValue={r?.customer_name} className={input} />
        </Field>
        <Field label="Phone">
          <input name="contact_number" type="tel" required defaultValue={r?.contact_number} className={input} />
        </Field>
        <Field label="Date">
          <input name="date" type="date" required defaultValue={parts.date} className={input} />
        </Field>
        <Field label="Time">
          <input name="time" type="time" required defaultValue={parts.time} className={input} />
        </Field>
        <Field label="Guests">
          <input name="guest_count" type="number" min={1} max={100} required defaultValue={r?.guest_count ?? 2} className={input} />
        </Field>
        <Field label="Length (minutes)">
          <input name="duration_minutes" type="number" min={15} max={600} step={15} required defaultValue={r?.duration_minutes ?? 90} className={input} />
        </Field>
        <Field label="Table" hint="Optional. Double bookings are refused.">
          <select name="table_id" defaultValue={r?.table_id ?? ""} className={input}>
            <option value="">Not assigned</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                Table {t.table_number} ({t.capacity} seats)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes">
          <input name="special_instructions" defaultValue={r?.special_instructions ?? ""} placeholder="Birthday, high chair…" className={input} />
        </Field>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <PageHeader
        title="Reservations"
        description={`${dayLabel} · ${active.length} booking${active.length === 1 ? "" : "s"}, ${covers} guests`}
        actions={
          <>
            <RealtimeRefresh channel={`reservations:${rid}`} watch={[{ table: "reservations", filter: `restaurant_id=eq.${rid}` }]} />
            <Link href="/floor" className={`${btnSecondary} ${btnSmall}`}>
              Floor
            </Link>
            <Link href="/staff" className="text-sm text-ink-soft underline">
              Home
            </Link>
          </>
        }
      />

      <nav className="mb-5 flex flex-wrap items-center gap-2 text-sm" aria-label="Day">
        <Link href={`/reservations?date=${addDays(date, -1)}`} className={`${btnSecondary} ${btnSmall}`}>
          ← Previous day
        </Link>
        <Link href="/reservations" className={`${btnSecondary} ${btnSmall} ${date === today ? "!border-brand" : ""}`}>
          Today
        </Link>
        <Link href={`/reservations?date=${addDays(date, 1)}`} className={`${btnSecondary} ${btnSmall}`}>
          Next day →
        </Link>
        <form className="flex items-center gap-2">
          <input type="date" name="date" defaultValue={date} className={`${input} !w-40 !py-1.5`} aria-label="Go to date" />
          <button className={`${btnSecondary} ${btnSmall}`}>Go</button>
        </form>
      </nav>

      <Card className="mb-6">
        <h2 className="mb-3 font-semibold">New reservation</h2>
        <ActionForm action={saveReservation} submitLabel="Save reservation" resetOnSuccess>
          <ReservationFields />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" defaultChecked /> Confirmed with the customer
          </label>
        </ActionForm>
      </Card>

      {reservations.length === 0 && <p className="text-sm text-ink-soft">No reservations on this day.</p>}
      <div className="space-y-3">
        {reservations.map((r) => {
          const open = r.status === "pending" || r.status === "confirmed";
          return (
            <Card key={r.id} className={open ? "" : "opacity-70"}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <p className="w-16 text-lg font-semibold tabular-nums">{clock.format(new Date(r.reserved_for))}</p>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.customer_name} · {r.guest_count} guests
                  </p>
                  <p className="text-xs text-ink-soft">
                    {r.contact_number} · {r.duration_minutes} min · {r.table_id ? `Table ${tableNumber.get(r.table_id)}` : "No table yet"}
                    {r.special_instructions && ` · ${r.special_instructions}`}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_TONE[r.status] ?? ""}`}>{r.status.replace("_", "-")}</span>
              </div>
              {open && (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.status === "pending" && (
                      <ActionForm action={setReservationStatus} submitLabel="Confirm" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="status" value="confirmed" />
                      </ActionForm>
                    )}
                    <Link href="/floor" className={`${btnSecondary} ${btnSmall}`}>
                      Seat on floor
                    </Link>
                    <ActionForm action={setReservationStatus} submitLabel="No-show" submitClassName={`${btnSecondary} ${btnSmall}`} confirm={`Mark ${r.customer_name} as a no-show?`} inline>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value="no_show" />
                    </ActionForm>
                    <ActionForm action={setReservationStatus} submitLabel="Cancel booking" submitClassName={`${btnDanger} ${btnSmall}`} confirm={`Cancel ${r.customer_name}'s reservation?`} inline>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value="cancelled" />
                    </ActionForm>
                  </div>
                  <details className="mt-3 border-t border-line pt-3">
                    <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Edit</summary>
                    <ActionForm action={saveReservation} submitLabel="Save changes" submitClassName={`${btnSecondary} ${btnSmall}`} className="mt-3 space-y-3">
                      <input type="hidden" name="id" value={r.id} />
                      <ReservationFields r={r} />
                    </ActionForm>
                  </details>
                </>
              )}
            </Card>
          );
        })}
      </div>
    </main>
  );
}

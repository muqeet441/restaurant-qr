import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff, hasAnyRole } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { Card, TableStatusBadge, btnDanger, btnPrimary, btnSecondary, btnSmall, input } from "@/components/ui";
import type { RestaurantTable, TableSession, TableStatus } from "@/lib/types";
import { closeSession, markCleaned, mergeSessions, openSession, transferSession } from "./actions";
import { RealtimeRefresh } from "@/components/realtime-refresh";

export const metadata: Metadata = { title: "Floor" };
export const dynamic = "force-dynamic";

const FILTERS: (TableStatus | "all")[] = ["all", "available", "occupied", "cleaning", "reserved"];

function since(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export default async function FloorPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const ctx = await requireStaff(["admin", "manager", "waiter", "cashier"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;

  const now = Date.now();
  const [{ data: tables }, { data: sessions }, { data: assignments }, { data: employees }, { data: bookings }] = await Promise.all([
    supabase.from("restaurant_tables").select("*").eq("restaurant_id", rid).eq("is_active", true),
    supabase.from("table_sessions").select("*").eq("restaurant_id", rid).neq("status", "closed"),
    supabase.from("employee_table_assignments").select("table_id, employee_id").is("unassigned_at", null),
    supabase.from("employees").select("id, full_name").eq("restaurant_id", rid),
    supabase
      .from("reservations")
      .select("id, table_id, customer_name, guest_count, reserved_for")
      .eq("restaurant_id", rid)
      .in("status", ["pending", "confirmed"])
      .gte("reserved_for", new Date(now - 60 * 60000).toISOString())
      .lte("reserved_for", new Date(now + 3 * 60 * 60000).toISOString())
      .order("reserved_for"),
  ]);

  const liveSessions = (sessions ?? []) as TableSession[];
  const sessionByTable = new Map(liveSessions.map((s) => [s.table_id, s]));

  // Tables merged into a live party: show which table they joined.
  const { data: merges } = liveSessions.length
    ? await supabase.from("table_merges").select("primary_session_id, merged_session_id").in("primary_session_id", liveSessions.map((s) => s.id))
    : { data: [] as { primary_session_id: string; merged_session_id: string }[] };
  const { data: mergedSessions } = merges?.length
    ? await supabase.from("table_sessions").select("id, table_id").in("id", merges.map((m) => m.merged_session_id))
    : { data: [] as { id: string; table_id: string }[] };
  const tableNumber = new Map(((tables ?? []) as RestaurantTable[]).map((t) => [t.id, t.table_number]));
  const mergedInto = new Map<string, string>();
  for (const m of merges ?? []) {
    const merged = mergedSessions?.find((s) => s.id === m.merged_session_id);
    const primary = liveSessions.find((s) => s.id === m.primary_session_id);
    if (merged && primary) mergedInto.set(merged.table_id, tableNumber.get(primary.table_id) ?? "?");
  }
  const bookingByTable = new Map<string, NonNullable<typeof bookings>[number]>();
  for (const b of bookings ?? []) if (b.table_id && !bookingByTable.has(b.table_id)) bookingByTable.set(b.table_id, b);
  const clock = new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: ctx.restaurant.timezone });
  const nameByEmployee = new Map((employees ?? []).map((e) => [e.id, e.full_name]));
  const waiterByTable = new Map((assignments ?? []).map((a) => [a.table_id, nameByEmployee.get(a.employee_id)]));

  const all = ((tables ?? []) as RestaurantTable[]).sort((a, b) =>
    a.table_number.localeCompare(b.table_number, undefined, { numeric: true }),
  );
  const filter = FILTERS.includes(status as TableStatus) ? (status as TableStatus) : "all";
  const shown = filter === "all" ? all : all.filter((t) => t.status === filter);
  const counts = Object.fromEntries(FILTERS.map((f) => [f, f === "all" ? all.length : all.filter((t) => t.status === f).length]));

  const canClose = hasAnyRole(ctx, ["admin", "manager", "cashier"]);
  const canForceClose = hasAnyRole(ctx, ["admin", "manager"]);
  const canTransfer = hasAnyRole(ctx, ["admin", "manager"]);
  const canMerge = hasAnyRole(ctx, ["admin", "manager", "waiter"]);
  const freeTables = all.filter((t) => !sessionByTable.has(t.id) && !mergedInto.has(t.id) && (t.status === "available" || t.status === "reserved"));

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Floor</h1>
          <p className="text-sm text-ink-soft">{ctx.restaurant.name}</p>
        </div>
        <div className="flex items-center gap-4">
          <RealtimeRefresh
            channel={`floor:${rid}`}
            watch={[
              { table: "restaurant_tables", filter: `restaurant_id=eq.${rid}` },
              { table: "table_sessions", filter: `restaurant_id=eq.${rid}` },
              { table: "reservations", filter: `restaurant_id=eq.${rid}` },
            ]}
          />
          <Link href="/staff" className="text-sm text-ink-soft underline hover:text-ink">
            Staff home
          </Link>
        </div>
      </div>

      <nav className="mb-5 flex gap-2 overflow-x-auto pb-1" aria-label="Filter tables">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/floor" : `/floor?status=${f}`}
            className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm capitalize ${
              filter === f ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink-soft hover:text-ink"
            }`}
          >
            {f} <span className="tabular-nums opacity-75">{counts[f]}</span>
          </Link>
        ))}
      </nav>

      {all.length === 0 && (
        <Card>
          <p className="text-sm">No tables yet. An administrator can add them under Admin → Tables.</p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((t) => {
          const session = sessionByTable.get(t.id);
          const waiter = waiterByTable.get(t.id);
          const joined = mergedInto.get(t.id);
          const booking = bookingByTable.get(t.id);
          const otherParties = liveSessions.filter((s) => s.id !== session?.id);
          return (
            <Card key={t.id} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xl font-semibold">Table {t.table_number}</p>
                  <p className="text-xs text-ink-soft">
                    {t.capacity} seats{t.location ? ` · ${t.location}` : ""}
                  </p>
                </div>
                <TableStatusBadge status={t.status} />
              </div>

              <p className="text-xs text-ink-soft">
                Waiter: <span className="text-ink">{waiter ?? "unassigned"}</span>
                {session && (
                  <>
                    <br />
                    Seated {since(session.opened_at)} ago
                    {session.guest_count ? ` · ${session.guest_count} guests` : ""}
                  </>
                )}
              </p>
              {joined && <p className="rounded-md bg-muted px-2 py-1 text-xs">Joined with table {joined} (one bill)</p>}
              {booking && !session && (
                <p className="rounded-md bg-violet-50 px-2 py-1 text-xs text-violet-900 dark:bg-violet-950 dark:text-violet-200">
                  Booked {clock.format(new Date(booking.reserved_for))} · {booking.customer_name} ({booking.guest_count})
                </p>
              )}

              <div className="mt-auto space-y-2">
                {!session && !joined && booking && (t.status === "available" || t.status === "reserved") && (
                  <ActionForm action={openSession} submitLabel={`Seat ${booking.customer_name}`} submitClassName={`${btnPrimary} ${btnSmall}`} inline>
                    <input type="hidden" name="table_id" value={t.id} />
                    <input type="hidden" name="reservation_id" value={booking.id} />
                    <input type="hidden" name="guest_count" value={booking.guest_count} />
                  </ActionForm>
                )}
                {!session && !joined && (t.status === "available" || t.status === "reserved") && (
                  <ActionForm action={openSession} submitLabel={booking ? "Seat walk-in" : "Seat guests"} submitClassName={`${booking ? btnSecondary : btnPrimary} ${btnSmall}`} inline>
                    <input type="hidden" name="table_id" value={t.id} />
                    <input
                      name="guest_count"
                      type="number"
                      min={1}
                      max={50}
                      placeholder="Guests"
                      aria-label="Number of guests"
                      className={`${input} !w-24 !py-1.5 text-xs`}
                    />
                  </ActionForm>
                )}

                {t.status === "cleaning" && (
                  <ActionForm action={markCleaned} submitLabel="Mark clean" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                    <input type="hidden" name="table_id" value={t.id} />
                  </ActionForm>
                )}

                {session && canClose && (
                  <details>
                    <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Close session</summary>
                    <div className="mt-2 space-y-2">
                      <ActionForm
                        action={closeSession}
                        submitLabel="Close session"
                        submitClassName={`${btnDanger} ${btnSmall}`}
                        className="space-y-2"
                        confirm={`Close the session at table ${t.table_number}?`}
                      >
                        <input type="hidden" name="session_id" value={session.id} />
                        {canForceClose && (
                          <input
                            name="reason"
                            placeholder="Reason, only if the bill is unpaid"
                            className={`${input} text-xs`}
                          />
                        )}
                      </ActionForm>
                    </div>
                  </details>
                )}

                {session && (canTransfer || canMerge) && (
                  <details>
                    <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Move or merge</summary>
                    <div className="mt-2 space-y-3">
                      {canTransfer && freeTables.length > 0 && (
                        <ActionForm action={transferSession} submitLabel="Move party" submitClassName={`${btnSecondary} ${btnSmall}`} className="space-y-2">
                          <input type="hidden" name="session_id" value={session.id} />
                          <select name="to_table_id" className={`${input} text-xs`} aria-label="Move to table">
                            {freeTables.map((f) => (
                              <option key={f.id} value={f.id}>
                                Table {f.table_number} ({f.capacity} seats)
                              </option>
                            ))}
                          </select>
                          <input name="reason" placeholder="Reason (optional)" className={`${input} text-xs`} />
                        </ActionForm>
                      )}
                      {canMerge && otherParties.length > 0 && (
                        <ActionForm
                          action={mergeSessions}
                          submitLabel={`Merge into table ${t.table_number}`}
                          submitClassName={`${btnSecondary} ${btnSmall}`}
                          confirm={`Combine that table's orders into table ${t.table_number}'s bill?`}
                          className="space-y-2"
                        >
                          <input type="hidden" name="session_id" value={session.id} />
                          <select name="merge_session_id" className={`${input} text-xs`} aria-label="Table to merge in">
                            {otherParties.map((p) => (
                              <option key={p.id} value={p.id}>
                                Table {tableNumber.get(p.table_id)}
                              </option>
                            ))}
                          </select>
                        </ActionForm>
                      )}
                    </div>
                  </details>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </main>
  );
}

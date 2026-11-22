import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { hasAnyRole, isAdmin, requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, btnPrimary, btnSecondary, btnSmall, input } from "@/components/ui";
import { addRegister, closeRegister, openRegister, reviewRegister } from "../actions";

export const metadata: Metadata = { title: "Cash register" };
export const dynamic = "force-dynamic";

type RegSession = {
  id: string;
  register_id: string;
  opened_by: string;
  opening_balance: number;
  opened_at: string;
  closed_at: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  discrepancy: number | null;
  notes: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  cash_registers: { name: string } | null;
};

export default async function RegisterPage() {
  const ctx = await requireStaff(["admin", "manager", "cashier"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const isManager = hasAnyRole(ctx, ["admin", "manager"]);
  const money = new Intl.NumberFormat("en", { style: "currency", currency: ctx.restaurant.currency });
  const when = new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short", timeZone: ctx.restaurant.timezone });

  const [{ data: registers }, { data: sessionRows }, { data: employees }] = await Promise.all([
    supabase.from("cash_registers").select("id, name, is_active").eq("restaurant_id", rid).order("name"),
    supabase
      .from("cash_register_sessions")
      .select("*, cash_registers!inner(name, restaurant_id)")
      .eq("cash_registers.restaurant_id", rid)
      .order("opened_at", { ascending: false })
      .limit(30),
    supabase.from("employees").select("user_id, full_name").eq("restaurant_id", rid),
  ]);
  const sessions = (sessionRows ?? []) as unknown as RegSession[];
  const nameOf = new Map((employees ?? []).map((e) => [e.user_id, e.full_name]));
  const mine = sessions.find((s) => s.opened_by === ctx.userId && !s.closed_at);
  const busy = new Set(sessions.filter((s) => !s.closed_at).map((s) => s.register_id));

  // Running totals for the open session.
  let cashIn = 0;
  let cashOut = 0;
  if (mine) {
    const [{ data: pays }, { data: refs }] = await Promise.all([
      supabase.from("payments").select("amount").eq("register_session_id", mine.id).eq("method", "cash").eq("status", "succeeded"),
      supabase.from("refunds").select("amount").eq("register_session_id", mine.id).eq("method", "cash").eq("status", "approved"),
    ]);
    cashIn = (pays ?? []).reduce((s, p) => s + Number(p.amount), 0);
    cashOut = (refs ?? []).reduce((s, r) => s + Number(r.amount), 0);
  }
  const expected = mine ? Number(mine.opening_balance) + cashIn - cashOut : 0;

  return (
    <>
      <PageHeader title="Cash register" description="Open a register at the start of your shift and count it when you close." />

      <div className="grid gap-6 lg:grid-cols-2">
        {mine ? (
          <Card className="border-emerald-400 dark:border-emerald-700">
            <h2 className="font-semibold">{mine.cash_registers?.name} · open since {when.format(new Date(mine.opened_at))}</h2>
            <dl className="my-4 space-y-1 text-sm">
              <Row label="Opening float" value={money.format(Number(mine.opening_balance))} />
              <Row label="Cash payments" value={`+ ${money.format(cashIn)}`} />
              <Row label="Cash refunds" value={`− ${money.format(cashOut)}`} />
              <div className="flex justify-between border-t border-line pt-1 font-semibold">
                <dt>Expected in drawer</dt>
                <dd className="tabular-nums">{money.format(expected)}</dd>
              </div>
            </dl>
            <ActionForm action={closeRegister} submitLabel="Close register" submitClassName={btnPrimary} confirm="Close the register with this count?">
              <input type="hidden" name="register_session_id" value={mine.id} />
              <Field label="Cash counted">
                <input name="counted_cash" type="number" min={0} step="0.01" required className={input} />
              </Field>
              <Field label="Notes">
                <input name="notes" maxLength={300} className={input} />
              </Field>
            </ActionForm>
          </Card>
        ) : (
          <Card>
            <h2 className="mb-3 font-semibold">Open a register</h2>
            {(registers ?? []).filter((r) => r.is_active).length === 0 ? (
              <p className="text-sm text-ink-soft">No registers yet{isAdmin(ctx) ? ". Add one below." : ". Ask an administrator to add one."}</p>
            ) : (
              <ActionForm action={openRegister} submitLabel="Open register">
                <Field label="Register">
                  <select name="register_id" className={input}>
                    {(registers ?? [])
                      .filter((r) => r.is_active)
                      .map((r) => (
                        <option key={r.id} value={r.id} disabled={busy.has(r.id)}>
                          {r.name}
                          {busy.has(r.id) ? " (in use)" : ""}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Opening float" hint="Cash in the drawer before any sales.">
                  <input name="opening_balance" type="number" min={0} step="0.01" required defaultValue="0" className={input} />
                </Field>
              </ActionForm>
            )}
          </Card>
        )}

        {isAdmin(ctx) && (
          <Card>
            <h2 className="mb-3 font-semibold">Registers</h2>
            <ul className="mb-4 flex flex-wrap gap-2">
              {(registers ?? []).map((r) => (
                <Badge key={r.id}>{r.name}</Badge>
              ))}
            </ul>
            <ActionForm action={addRegister} submitLabel="Add register" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess inline>
              <input name="name" required placeholder="Bar till" className={`${input} !w-48`} aria-label="Register name" />
            </ActionForm>
          </Card>
        )}
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Recent register sessions</h2>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-line text-left text-xs text-ink-soft">
            <tr>
              <th className="px-4 py-2 font-medium">Register</th>
              <th className="px-4 py-2 font-medium">Cashier</th>
              <th className="px-4 py-2 font-medium">Opened</th>
              <th className="px-4 py-2 font-medium">Closed</th>
              <th className="px-4 py-2 text-right font-medium">Expected</th>
              <th className="px-4 py-2 text-right font-medium">Counted</th>
              <th className="px-4 py-2 text-right font-medium">Difference</th>
              <th className="px-4 py-2 font-medium">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sessions.map((s) => {
              const d = s.discrepancy == null ? null : Number(s.discrepancy);
              return (
                <tr key={s.id}>
                  <td className="px-4 py-2">{s.cash_registers?.name}</td>
                  <td className="px-4 py-2">{nameOf.get(s.opened_by) ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-soft">{when.format(new Date(s.opened_at))}</td>
                  <td className="px-4 py-2 text-ink-soft">{s.closed_at ? when.format(new Date(s.closed_at)) : <Badge>Open</Badge>}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{s.expected_cash != null ? money.format(Number(s.expected_cash)) : "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{s.counted_cash != null ? money.format(Number(s.counted_cash)) : "—"}</td>
                  <td className={`px-4 py-2 text-right font-medium tabular-nums ${d ? "text-red-600 dark:text-red-400" : ""}`}>
                    {d == null ? "—" : `${d > 0 ? "+" : ""}${money.format(d)}`}
                  </td>
                  <td className="px-4 py-2">
                    {s.reviewed_by ? (
                      <span className="text-xs text-ink-soft">✓ {s.review_notes ?? nameOf.get(s.reviewed_by) ?? "Reviewed"}</span>
                    ) : s.closed_at && isManager ? (
                      <ActionForm action={reviewRegister} submitLabel="Sign off" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                        <input type="hidden" name="register_session_id" value={s.id} />
                        <input name="notes" maxLength={200} placeholder="Note" className={`${input} !w-32 !py-1.5 text-xs`} aria-label="Review note" />
                      </ActionForm>
                    ) : (
                      <span className="text-xs text-ink-soft">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ink-soft">
                  No register sessions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

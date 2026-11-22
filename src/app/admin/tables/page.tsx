import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { siteUrl, tableUrl } from "@/lib/site";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Card,
  Field,
  PageHeader,
  TableStatusBadge,
  btnDanger,
  btnPrimary,
  btnSecondary,
  btnSmall,
  input,
} from "@/components/ui";
import type { RestaurantTable } from "@/lib/types";
import {
  assignWaiter,
  createTable,
  regenerateQr,
  setTableActive,
  updateTable,
} from "../actions";

export const metadata: Metadata = { title: "Tables & QR" };

function TableFields({ table }: { table?: RestaurantTable }) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Field label="Number">
        <input name="table_number" required defaultValue={table?.table_number} className={input} />
      </Field>
      <Field label="Name">
        <input name="name" defaultValue={table?.name ?? ""} placeholder="Window booth" className={input} />
      </Field>
      <Field label="Seats">
        <input name="capacity" type="number" min={1} max={50} required defaultValue={table?.capacity ?? 4} className={input} />
      </Field>
      <Field label="Location">
        <input name="location" defaultValue={table?.location ?? ""} placeholder="Terrace" className={input} />
      </Field>
    </div>
  );
}

export default async function TablesPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;
  const base = await siteUrl();

  const [{ data: tables }, { data: assignments }, { data: roleRows }, { data: employees }] =
    await Promise.all([
      supabase.from("restaurant_tables").select("*").eq("restaurant_id", rid).order("is_active", { ascending: false }).order("table_number"),
      supabase.from("employee_table_assignments").select("table_id, employee_id").is("unassigned_at", null),
      supabase.from("user_roles").select("user_id, role").eq("restaurant_id", rid).in("role", ["waiter", "manager"]),
      supabase.from("employees").select("id, user_id, full_name, is_active").eq("restaurant_id", rid).eq("is_active", true).order("full_name"),
    ]);

  const waiterUserIds = new Set((roleRows ?? []).map((r) => r.user_id));
  const waiters = (employees ?? []).filter((e) => waiterUserIds.has(e.user_id));
  const assigned = new Map((assignments ?? []).map((a) => [a.table_id, a.employee_id]));
  const list = (tables ?? []) as RestaurantTable[];

  // Natural sort: 2 before 10.
  list.sort((a, b) =>
    a.is_active === b.is_active
      ? a.table_number.localeCompare(b.table_number, undefined, { numeric: true })
      : a.is_active ? -1 : 1,
  );

  return (
    <>
      <PageHeader
        title="Tables & QR codes"
        description="Every active table has its own QR code. Regenerating a code invalidates the printed one."
        actions={
          <Link href="/admin/tables/qr" className={btnPrimary}>
            Print all QR codes
          </Link>
        }
      />

      <Card className="mb-6">
        <h2 className="mb-3 font-semibold">Add a table</h2>
        <ActionForm action={createTable} submitLabel="Add table" resetOnSuccess>
          <TableFields />
        </ActionForm>
      </Card>

      <div className="space-y-3">
        {list.length === 0 && <p className="text-sm text-ink-soft">No tables yet.</p>}
        {list.map((t) => (
          <Card key={t.id} className={t.is_active ? "" : "opacity-60"}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-24">
                <p className="text-lg font-semibold">Table {t.table_number}</p>
                <p className="text-xs text-ink-soft">
                  {[t.name, t.location, `${t.capacity} seats`].filter(Boolean).join(" · ")}
                </p>
              </div>
              <TableStatusBadge status={t.status} />
              {!t.is_active && <Badge>Deactivated</Badge>}

              <div className="ml-auto flex flex-wrap items-center gap-2">
                {t.is_active && (
                  <ActionForm action={assignWaiter} submitLabel="Assign" submitClassName={`${btnSecondary} ${btnSmall}`} inline>
                    <input type="hidden" name="id" value={t.id} />
                    <select
                      name="employee_id"
                      defaultValue={assigned.get(t.id) ?? ""}
                      aria-label={`Waiter for table ${t.table_number}`}
                      className={`${input} !w-40 !py-1.5 text-xs`}
                    >
                      <option value="">No waiter</option>
                      {waiters.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.full_name}
                        </option>
                      ))}
                    </select>
                  </ActionForm>
                )}
                {t.is_active && (
                  <Link href={`/admin/tables/qr?id=${t.id}`} className={`${btnSecondary} ${btnSmall}`}>
                    Print QR
                  </Link>
                )}
              </div>
            </div>

            <details className="mt-3 border-t border-line pt-3">
              <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Edit, QR and status</summary>
              <div className="mt-4 space-y-4">
                <ActionForm action={updateTable} submitLabel="Save changes" submitClassName={`${btnSecondary} ${btnSmall}`}>
                  <input type="hidden" name="id" value={t.id} />
                  <TableFields table={t} />
                </ActionForm>

                {t.qr_token && t.is_active && (
                  <p className="break-all text-xs text-ink-soft">
                    Customer link: <code>{tableUrl(base, t.qr_token)}</code>
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <ActionForm
                    action={regenerateQr}
                    submitLabel="Regenerate QR code"
                    submitClassName={`${btnSecondary} ${btnSmall}`}
                    confirm={`Regenerate the QR code for table ${t.table_number}? The printed code will stop working.`}
                    inline
                  >
                    <input type="hidden" name="id" value={t.id} />
                  </ActionForm>
                  <ActionForm
                    action={setTableActive}
                    submitLabel={t.is_active ? "Deactivate table" : "Reactivate table"}
                    submitClassName={`${t.is_active ? btnDanger : btnSecondary} ${btnSmall}`}
                    confirm={t.is_active ? `Deactivate table ${t.table_number}? Its QR code will stop working.` : undefined}
                    inline
                  >
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="active" value={String(!t.is_active)} />
                  </ActionForm>
                </div>
              </div>
            </details>
          </Card>
        ))}
      </div>
    </>
  );
}

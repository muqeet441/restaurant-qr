import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Card,
  Field,
  PageHeader,
  btnDanger,
  btnSecondary,
  btnSmall,
  input,
} from "@/components/ui";
import { ROLE_LABELS, STAFF_ROLES, type AppRole, type Employee } from "@/lib/types";
import {
  createEmployee,
  resetEmployeePassword,
  setEmployeeActive,
  updateEmployeeRoles,
} from "../actions";

export const metadata: Metadata = { title: "Employees" };

type Station = { id: string; name: string };

function RolePicker({ selected = [] }: { selected?: AppRole[] }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium">Roles</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {STAFF_ROLES.map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="roles" value={r} defaultChecked={selected.includes(r)} />
            {ROLE_LABELS[r]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StationPicker({ stations, selected = [] }: { stations: Station[]; selected?: string[] }) {
  if (!stations.length) return null;
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium">Kitchen stations</legend>
      <p className="mb-2 text-xs text-ink-soft">Kitchen staff only see tickets for these stations.</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {stations.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="stations" value={s.id} defaultChecked={selected.includes(s.id)} />
            {s.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default async function EmployeesPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const rid = ctx.restaurant.id;

  const [{ data: employees }, { data: roleRows }, { data: stations }, { data: stationRows }] =
    await Promise.all([
      supabase.from("employees").select("*").eq("restaurant_id", rid).order("is_active", { ascending: false }).order("full_name"),
      supabase.from("user_roles").select("user_id, role").eq("restaurant_id", rid),
      supabase.from("kitchen_stations").select("id, name").eq("restaurant_id", rid).eq("is_active", true).order("sort_order"),
      supabase.from("employee_station_assignments").select("employee_id, station_id"),
    ]);

  const rolesByUser = new Map<string, AppRole[]>();
  for (const r of roleRows ?? []) {
    rolesByUser.set(r.user_id, [...(rolesByUser.get(r.user_id) ?? []), r.role as AppRole]);
  }
  const stationsByEmployee = new Map<string, string[]>();
  for (const s of stationRows ?? []) {
    stationsByEmployee.set(s.employee_id, [...(stationsByEmployee.get(s.employee_id) ?? []), s.station_id]);
  }

  return (
    <>
      <PageHeader
        title="Employees"
        description="Staff sign in with email and password. Roles decide which screens and actions they can use."
      />

      <Card className="mb-6">
        <h2 className="mb-3 font-semibold">Add an employee</h2>
        <ActionForm action={createEmployee} submitLabel="Create account" resetOnSuccess>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name">
              <input name="full_name" required className={input} />
            </Field>
            <Field label="Email">
              <input name="email" type="email" required autoComplete="off" className={input} />
            </Field>
            <Field label="Phone">
              <input name="phone" type="tel" className={input} />
            </Field>
            <Field label="Temporary password" hint="At least 8 characters. Share it with the employee privately.">
              <input name="password" type="text" minLength={8} required autoComplete="new-password" className={input} />
            </Field>
          </div>
          <RolePicker selected={["waiter"]} />
          <StationPicker stations={stations ?? []} />
        </ActionForm>
      </Card>

      <div className="space-y-3">
        {((employees ?? []) as Employee[]).map((e) => {
          const roles = rolesByUser.get(e.user_id) ?? [];
          const isSelf = e.user_id === ctx.userId;
          return (
            <Card key={e.id} className={e.is_active ? "" : "opacity-60"}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {e.full_name} {isSelf && <span className="text-xs font-normal text-ink-soft">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-ink-soft">
                    {e.email}
                    {e.phone ? ` · ${e.phone}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {roles.map((r) => (
                    <Badge key={r}>{ROLE_LABELS[r]}</Badge>
                  ))}
                  {!e.is_active && <Badge>Deactivated</Badge>}
                </div>
              </div>

              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm text-ink-soft hover:text-ink">Manage</summary>
                <div className="mt-4 grid gap-6 lg:grid-cols-2">
                  <ActionForm action={updateEmployeeRoles} submitLabel="Save roles" submitClassName={`${btnSecondary} ${btnSmall}`}>
                    <input type="hidden" name="id" value={e.id} />
                    <RolePicker selected={roles} />
                    <StationPicker stations={stations ?? []} selected={stationsByEmployee.get(e.id)} />
                  </ActionForm>

                  <div className="space-y-4">
                    <ActionForm action={resetEmployeePassword} submitLabel="Set password" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
                      <input type="hidden" name="id" value={e.id} />
                      <Field label="New password">
                        <input name="password" type="text" minLength={8} required autoComplete="new-password" className={input} />
                      </Field>
                    </ActionForm>
                    {!isSelf && (
                      <ActionForm
                        action={setEmployeeActive}
                        submitLabel={e.is_active ? "Deactivate account" : "Reactivate account"}
                        submitClassName={`${e.is_active ? btnDanger : btnSecondary} ${btnSmall}`}
                        confirm={e.is_active ? `Deactivate ${e.full_name}? They will be signed out and blocked.` : undefined}
                        inline
                      >
                        <input type="hidden" name="id" value={e.id} />
                        <input type="hidden" name="active" value={String(!e.is_active)} />
                      </ActionForm>
                    )}
                  </div>
                </div>
              </details>
            </Card>
          );
        })}
      </div>
    </>
  );
}

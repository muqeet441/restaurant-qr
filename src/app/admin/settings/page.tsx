import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, btnSecondary, btnSmall, input } from "@/components/ui";
import type { RestaurantSettings, ServiceCharge, TaxConfiguration } from "@/lib/types";
import {
  addServiceCharge,
  addTax,
  toggleCharge,
  updateRestaurant,
  updateSettings,
} from "../actions";

export const metadata: Metadata = { title: "Settings" };

function ChargeRow({
  kind,
  id,
  label,
  active,
  tags,
}: {
  kind: "tax" | "service";
  id: string;
  label: string;
  active: boolean;
  tags: string[];
}) {
  return (
    <li className={`flex flex-wrap items-center gap-2 py-2 ${active ? "" : "opacity-60"}`}>
      <span className="text-sm font-medium">{label}</span>
      {tags.map((t) => (
        <Badge key={t}>{t}</Badge>
      ))}
      <div className="ml-auto">
        <ActionForm
          action={toggleCharge}
          submitLabel={active ? "Disable" : "Enable"}
          submitClassName={`${btnSecondary} ${btnSmall}`}
          inline
        >
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="active" value={String(!active)} />
        </ActionForm>
      </div>
    </li>
  );
}

export default async function SettingsPage() {
  const ctx = await requireStaff(["admin"]);
  const supabase = await createClient();
  const r = ctx.restaurant;

  const [{ data: settings }, { data: taxes }, { data: charges }] = await Promise.all([
    supabase.from("restaurant_settings").select("*").eq("restaurant_id", r.id).single(),
    supabase.from("tax_configurations").select("*").eq("restaurant_id", r.id).order("created_at"),
    supabase.from("service_charges").select("*").eq("restaurant_id", r.id).order("created_at"),
  ]);
  const s = settings as RestaurantSettings | null;

  return (
    <>
      <PageHeader title="Settings" description="Restaurant details, operating rules, taxes and service charges." />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Restaurant</h2>
          <ActionForm action={updateRestaurant} submitLabel="Save details">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input name="name" required defaultValue={r.name} className={input} />
              </Field>
              <Field label="Phone">
                <input name="phone" defaultValue={r.phone ?? ""} className={input} />
              </Field>
              <Field label="Email">
                <input name="email" type="email" defaultValue={r.email ?? ""} className={input} />
              </Field>
              <Field label="Address">
                <input name="address" defaultValue={r.address ?? ""} className={input} />
              </Field>
              <Field label="Currency" hint="ISO code, e.g. USD, EUR, PKR">
                <input name="currency" required maxLength={3} defaultValue={r.currency} className={input} />
              </Field>
              <Field label="Time zone" hint="IANA name, e.g. Asia/Karachi. Used for daily order numbers.">
                <input name="timezone" required defaultValue={r.timezone} className={input} />
              </Field>
            </div>
            <Field label="Description" hint="Shown to customers when they scan the QR code.">
              <textarea name="description" rows={2} defaultValue={r.description ?? ""} className={input} />
            </Field>
          </ActionForm>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold">Operating rules</h2>
          {s && (
            <ActionForm action={updateSettings} submitLabel="Save rules">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" name="customer_can_open_session" defaultChecked={s.customer_can_open_session} className="mt-1" />
                <span>
                  <span className="font-medium">Customers can start a table session by scanning</span>
                  <span className="block text-xs text-ink-soft">
                    Off: staff must seat guests and open the session first (recommended).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" name="require_cleaning" defaultChecked={s.require_cleaning} className="mt-1" />
                <span>
                  <span className="font-medium">Tables need cleaning before reuse</span>
                  <span className="block text-xs text-ink-soft">
                    Closed tables move to Cleaning until staff mark them clean.
                  </span>
                </span>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Alert manager after (minutes)" hint="Orders waiting for a waiter this long.">
                  <input name="pending_order_alert_minutes" type="number" min={1} max={120} defaultValue={s.pending_order_alert_minutes} className={input} />
                </Field>
                <Field label="Discount limit without manager (%)">
                  <input name="manager_discount_limit_pct" type="number" min={0} max={100} step="0.5" defaultValue={s.manager_discount_limit_pct} className={input} />
                </Field>
              </div>
            </ActionForm>
          )}
        </Card>

        <Card>
          <h2 className="font-semibold">Taxes</h2>
          <ul className="my-2 divide-y divide-line">
            {((taxes ?? []) as TaxConfiguration[]).map((t) => (
              <ChargeRow
                key={t.id}
                kind="tax"
                id={t.id}
                label={`${t.name} · ${Number(t.rate_pct)}%`}
                active={t.is_active}
                tags={[t.is_inclusive ? "Included in price" : "Added at checkout", ...(t.is_default ? ["Default"] : [])]}
              />
            ))}
          </ul>
          <ActionForm action={addTax} submitLabel="Add tax" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input name="name" required placeholder="Sales tax" className={input} />
              </Field>
              <Field label="Rate (%)">
                <input name="rate_pct" type="number" min={0} max={100} step="0.01" required className={input} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="is_inclusive" /> Included in menu prices
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="is_default" /> Default for new items
              </label>
            </div>
          </ActionForm>
        </Card>

        <Card>
          <h2 className="font-semibold">Service charges</h2>
          <ul className="my-2 divide-y divide-line">
            {((charges ?? []) as ServiceCharge[]).map((c) => (
              <ChargeRow
                key={c.id}
                kind="service"
                id={c.id}
                label={`${c.name} · ${c.rate_pct != null ? `${Number(c.rate_pct)}%` : Number(c.fixed_amount).toFixed(2)}`}
                active={c.is_active}
                tags={[]}
              />
            ))}
          </ul>
          <ActionForm action={addServiceCharge} submitLabel="Add service charge" submitClassName={`${btnSecondary} ${btnSmall}`} resetOnSuccess>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input name="name" required placeholder="Service charge" className={input} />
              </Field>
              <Field label="Rate (%)">
                <input name="rate_pct" type="number" min={0} max={100} step="0.01" required className={input} />
              </Field>
            </div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}

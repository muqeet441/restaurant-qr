// End-to-end check against a REAL Supabase project (Phase 6).
//
//   npm run e2e:live
//
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY in .env.local, migrations pushed, and anonymous
// sign-ins enabled.
//
// Everything runs inside a separate restaurant (slug "e2e-check") with its own
// staff accounts (*@e2e.tableqr.test); your real data is never touched. The
// restaurant is deactivated at the end and reused on the next run.
import { createClient } from "@supabase/supabase-js";
import { randomUUID, randomBytes } from "node:crypto";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

let passed = 0;
let failed = 0;
const timings = [];
const ok = (name, cond, extra = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
async function timed(label, fn) {
  const t = performance.now();
  const r = await fn();
  timings.push([label, performance.now() - t]);
  return r;
}
async function rpc(client, fn, args, label = fn) {
  const { data, error } = await timed(label, () => client.rpc(fn, args));
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

if (!URL || !ANON || !SERVICE || /PASTE/.test(ANON + SERVICE)) {
  die("Fill NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.local");
}
const admin = createClient(URL, SERVICE, opts);

// ---------------------------------------------------------------------------
console.log("Preflight");
// ---------------------------------------------------------------------------
const settings = await fetch(`${URL}/auth/v1/settings`, { headers: { apikey: ANON } }).then((r) => r.json());
ok("anonymous sign-ins enabled (Authentication → Sign In / Providers)", settings?.external?.anonymous_users === true);
const probe = await admin.from("restaurants").select("id").limit(1);
if (probe.error) die(`Database schema not found (${probe.error.message}). Run: npx supabase db push`);
ok("database schema present", true);
const { data: hookCheck } = await admin.from("roles").select("code");
ok("roles catalogue seeded", (hookCheck ?? []).length === 6);
if (settings?.external?.anonymous_users !== true) die("Enable anonymous sign-ins first.");

// ---------------------------------------------------------------------------
console.log("Fixtures (restaurant e2e-check)");
// ---------------------------------------------------------------------------
let { data: r } = await admin.from("restaurants").select("*").eq("slug", "e2e-check").maybeSingle();
if (!r) {
  ({ data: r } = await admin.from("restaurants").insert({ name: "E2E check", slug: "e2e-check", currency: "USD" }).select().single());
} else {
  await admin.from("restaurants").update({ is_active: true }).eq("id", r.id);
}
const rid = r.id;
const one = async (table, match, insert) => {
  const { data } = await admin.from(table).select("*").match(match).limit(1).maybeSingle();
  if (data) return data;
  const res = await admin.from(table).insert({ ...match, ...insert }).select().single();
  if (res.error) die(`${table}: ${res.error.message}`);
  return res.data;
};
const station = await one("kitchen_stations", { restaurant_id: rid, name: "E2E grill" }, {});
const category = await one("menu_categories", { restaurant_id: rid, name: "E2E" }, {});
const item = await one("menu_items", { restaurant_id: rid, name: "E2E burger" }, { category_id: category.id, station_id: station.id, base_price: 10 });
await admin.from("menu_items").update({ base_price: 10, is_available: true, is_active: true, station_id: station.id }).eq("id", item.id);
await one("tax_configurations", { restaurant_id: rid, name: "E2E tax" }, { rate_pct: 10, is_default: true });
const register = await one("cash_registers", { restaurant_id: rid, name: "E2E till" }, {});
const table = await one("restaurant_tables", { restaurant_id: rid, table_number: "E2E-1" }, { capacity: 4 });

// Staff accounts: reused across runs, fresh random password each time.
const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 });
async function staffUser(role) {
  const email = `${role}@e2e.tableqr.test`;
  const password = randomBytes(18).toString("base64url");
  let u = userList.users.find((x) => x.email === email);
  if (u) {
    await admin.auth.admin.updateUserById(u.id, { password, ban_duration: "none" });
  } else {
    const res = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (res.error) die(`create ${email}: ${res.error.message}`);
    u = res.data.user;
  }
  await admin.from("employees").upsert({ restaurant_id: rid, user_id: u.id, full_name: `E2E ${role}`, email, is_active: true }, { onConflict: "user_id" });
  const { data: existing } = await admin.from("user_roles").select("id").eq("user_id", u.id).eq("restaurant_id", rid).eq("role", role);
  if (!existing?.length) await admin.from("user_roles").insert({ user_id: u.id, restaurant_id: rid, role });
  const client = createClient(URL, ANON, opts);
  const { error } = await timed(`sign in (${role})`, () => client.auth.signInWithPassword({ email, password }));
  if (error) die(`sign in ${email}: ${error.message}`);
  return { id: u.id, client };
}
const manager = await staffUser("manager");
const waiter = await staffUser("waiter");
const cook = await staffUser("kitchen");
const cashier = await staffUser("cashier");
ok("staff accounts ready and signed in", true);

const { data: claims } = await waiter.client.auth.getSession();
const payload = JSON.parse(Buffer.from(claims.session.access_token.split(".")[1], "base64url").toString());
ok("access-token hook adds app_roles (Authentication → Hooks)", Array.isArray(payload.app_roles) && payload.app_roles.some((x) => x.role === "waiter"),
  "enable the Customize Access Token hook → public.custom_access_token_hook");

// Leftovers from an interrupted run.
const { data: leftover } = await admin.from("table_sessions").select("id").eq("table_id", table.id).neq("status", "closed");
for (const s of leftover ?? []) await manager.client.rpc("close_table_session", { p_session_id: s.id, p_exception_reason: "e2e cleanup" });
await admin.from("restaurant_tables").select("status").eq("id", table.id).single().then(async ({ data }) => {
  if (data.status === "cleaning") await waiter.client.rpc("mark_table_cleaned", { p_table_id: table.id });
});
const { data: openReg } = await admin.from("cash_register_sessions").select("id").eq("opened_by", cashier.id).is("closed_at", null);
for (const s of openReg ?? []) await cashier.client.rpc("close_register_session", { p_session_id: s.id, p_counted_cash: 0 });

// ---------------------------------------------------------------------------
console.log("Dine-in flow");
// ---------------------------------------------------------------------------
try {
  const session = await rpc(waiter.client, "open_table_session", { p_table_id: table.id, p_guest_count: 2 });
  ok("waiter seats the table", session.status === "open");

  const guest = createClient(URL, ANON, opts);
  const { error: anonErr } = await timed("anonymous sign-in", () => guest.auth.signInAnonymously());
  ok("customer gets an anonymous session", !anonErr, anonErr?.message);
  const { data: tableRow } = await admin.from("restaurant_tables").select("qr_token").eq("id", table.id).single();
  const joined = await rpc(guest, "join_table_session", { p_qr_token: tableRow.qr_token });
  ok("QR code joins the live session", joined.status === "joined" && joined.session.id === session.id);

  const { data: menu } = await timed("read menu", () => guest.from("menu_items").select("id, base_price").eq("restaurant_id", rid));
  ok("customer reads the menu through RLS", (menu ?? []).some((m) => m.id === item.id));
  const priceHack = await guest.from("menu_items").update({ base_price: 0 }).eq("id", item.id).select();
  ok("customer can't change prices", (priceHack.data ?? []).length === 0);

  // Realtime: the customer should hear about the confirmation.
  const { data: guestSession } = await guest.auth.getSession();
  await guest.realtime.setAuth(guestSession.session.access_token);
  let resolveHeard;
  const heard = new Promise((resolve) => {
    resolveHeard = resolve;
    setTimeout(() => resolve(false), 10000);
  });
  const subscribed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("TIMED_OUT (no reply)"), 10000);
    guest
      .channel(`e2e:${session.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `session_id=eq.${session.id}` }, () => resolveHeard(true))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(t);
          resolve(status + (err ? `: ${err.message}` : ""));
        }
      });
  });
  ok("customer's live channel connects", subscribed === "SUBSCRIBED", subscribed);
  await new Promise((r) => setTimeout(r, 1000));

  const order = await rpc(guest, "submit_order", {
    p_session_id: session.id,
    p_items: [{ menu_item_id: item.id, quantity: 2, special_instructions: "e2e" }],
    p_idempotency_key: randomUUID(),
  });
  ok("customer submits an order (2 × 10.00)", Number(order.subtotal) === 20);

  await rpc(waiter.client, "confirm_order", { p_order_id: order.order_id });
  ok("customer receives the confirmation live (Realtime + RLS)", await heard);

  const { data: tickets } = await cook.client.from("kitchen_tickets").select("id, status").eq("order_id", order.order_id);
  ok("kitchen sees the ticket", tickets?.length === 1);
  await rpc(cook.client, "start_ticket", { p_ticket_id: tickets[0].id });
  await rpc(cook.client, "mark_ticket_items_ready", { p_ticket_id: tickets[0].id, p_ticket_item_ids: null });
  await rpc(waiter.client, "serve_order", { p_order_id: order.order_id });
  const { data: served } = await guest.from("orders").select("status").eq("id", order.order_id).single();
  ok("order served and visible to the customer", served.status === "served");

  await rpc(cashier.client, "open_register_session", { p_register_id: register.id, p_opening_balance: 50 });
  const invoiceId = await rpc(cashier.client, "generate_invoice", { p_session_id: session.id });
  const { data: inv } = await cashier.client.from("invoices").select("total, receipt_token").eq("id", invoiceId).single();
  ok("bill = 20.00 + 10% tax", Number(inv.total) === 22);
  const pay = await rpc(cashier.client, "record_payment", {
    p_invoice_id: invoiceId, p_method: "cash", p_idempotency_key: randomUUID(), p_tendered: 30,
  });
  ok("cash payment with change", pay.invoice_status === "paid" && Number(pay.change) === 8);
  const { data: receipt } = await admin.rpc("get_receipt", { p_token: inv.receipt_token });
  ok("digital receipt available", receipt?.invoice?.status === "paid");
  const guestReceipt = await guest.rpc("get_receipt", { p_token: inv.receipt_token });
  ok("customers can't call the receipt function directly", !!guestReceipt.error);

  await rpc(cashier.client, "close_table_session", { p_session_id: session.id });
  const afterClose = await guest.from("menu_items").select("id").eq("restaurant_id", rid);
  ok("customer loses access when the visit ends", (afterClose.data ?? []).length === 0);
  await rpc(waiter.client, "mark_table_cleaned", { p_table_id: table.id });

  const { data: reg } = await admin.from("cash_register_sessions").select("id").eq("opened_by", cashier.id).is("closed_at", null).single();
  const closed = await rpc(cashier.client, "close_register_session", { p_session_id: reg.id, p_counted_cash: 72 });
  ok("register balances (50 float + 22 cash)", Number(closed.discrepancy) === 0);

  const signedOut = createClient(URL, ANON, opts);
  const blocked = await signedOut.rpc("join_table_session", { p_qr_token: tableRow.qr_token });
  ok("signed-out requests are refused", !!blocked.error);
  await guest.removeAllChannels();
} catch (e) {
  ok("flow completed", false, e.message);
} finally {
  await admin.from("restaurants").update({ is_active: false }).eq("id", rid);
  for (const s of [manager, waiter, cook, cashier]) await s.client.auth.signOut();
}

// ---------------------------------------------------------------------------
const sorted = timings.map(([, ms]) => ms).sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
console.log(`\nAPI calls: ${timings.length} · median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} ms · p95 ${p95.toFixed(0)} ms · slowest ${timings.sort((a, b) => b[1] - a[1])[0]?.join(" ")}`);
ok("95% of API calls under 2 s (NFR-001)", p95 < 2000);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

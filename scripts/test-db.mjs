// Runs every migration + seed in an in-process Postgres (PGlite) with a stub of
// Supabase's auth schema, then exercises RLS and the table/session RPCs as
// different users. No Docker or Supabase project required.
//
//   npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new PGlite();

// ---------------------------------------------------------------------------
// Minimal Supabase platform stub
// ---------------------------------------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    is_anonymous boolean not null default false
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, supabase_auth_admin;
  grant execute on function auth.uid() to anon, authenticated, supabase_auth_admin;
`);

const migrationsDir = join(root, "supabase", "migrations");
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  try {
    await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  } catch (e) {
    console.error(`Migration ${file} failed:`, e.message);
    process.exit(1);
  }
  console.log(`applied ${file}`);
}
await db.exec(readFileSync(join(root, "supabase", "seed.sql"), "utf8"));
console.log("applied seed.sql\n");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const R1 = "11111111-1111-1111-1111-111111111111";
let passed = 0;
let failed = 0;

async function as(uid, sql, params = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? ""]);
  await db.exec(uid ? "set role authenticated" : "set role anon");
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
  }
}
const su = (sql, params = []) => db.query(sql, params);

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
async function expectError(name, fn, match) {
  try {
    await fn();
    check(name, false, "(no error raised)");
  } catch (e) {
    check(name, e.message.includes(match), `(got: ${e.message})`);
  }
}

async function user(email, anonymous = false) {
  const { rows } = await su(
    "insert into auth.users (email, is_anonymous) values ($1, $2) returning id",
    [email, anonymous],
  );
  return rows[0].id;
}
async function staff(email, role, restaurant = R1) {
  const id = await user(email);
  await su(
    "insert into public.employees (restaurant_id, user_id, full_name, email) values ($1, $2, $3, $4)",
    [restaurant, id, email.split("@")[0], email],
  );
  await su("insert into public.user_roles (user_id, restaurant_id, role) values ($1, $2, $3)", [
    id,
    restaurant,
    role,
  ]);
  return id;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const { rows: [r2] } = await su(
  "insert into public.restaurants (name, slug) values ('Other Place', 'other-place') returning id",
);
const admin = await staff("admin@demo.test", "admin");
const manager = await staff("manager@demo.test", "manager");
const waiter = await staff("waiter@demo.test", "waiter");
const cashier = await staff("cashier@demo.test", "cashier");
const kitchen = await staff("kitchen@demo.test", "kitchen");
const outsider = await staff("admin@other.test", "admin", r2.id);
const guest = await user(null, true);
const stranger = await user(null, true);

const { rows: [t1] } = await su(
  "select id, qr_token from public.restaurant_tables where restaurant_id = $1 and table_number = '1'",
  [R1],
);

// ---------------------------------------------------------------------------
console.log("Tables & QR");
// ---------------------------------------------------------------------------
{
  const { rows } = await as(admin,
    `insert into public.restaurant_tables (restaurant_id, table_number, capacity)
     values ($1, '99', 4) returning id, qr_token, status`, [R1]);
  check("admin creates table with generated QR token", rows[0].qr_token?.length === 40);
  check("new table status is available", rows[0].status === "available");
  await expectError("admin cannot set table status directly",
    () => as(admin, "update public.restaurant_tables set status = 'occupied' where id = $1", [rows[0].id]),
    "permission denied");
  await expectError("waiter cannot create tables",
    () => as(waiter, "insert into public.restaurant_tables (restaurant_id, table_number) values ($1, '98')", [R1]),
    "row-level security");
  const other = await as(outsider, "select count(*)::int n from public.restaurant_tables where restaurant_id = $1", [R1]);
  check("other restaurant's admin sees no tables", other.rows[0].n === 0);
  const own = await as(waiter, "select count(*)::int n from public.restaurant_tables");
  check("waiter sees own restaurant tables", own.rows[0].n === 11);
}

// ---------------------------------------------------------------------------
console.log("Customer QR before a session exists");
// ---------------------------------------------------------------------------
await expectError("unknown QR token is rejected",
  () => as(guest, "select public.join_table_session('nope')"), "invalid_qr");
await expectError("bare anon role cannot call RPC",
  () => as(null, "select public.join_table_session($1)", [t1.qr_token]), "permission denied");
{
  const { rows } = await as(guest, "select public.join_table_session($1) j", [t1.qr_token]);
  check("valid QR without session → waiting_for_staff", rows[0].j.status === "waiting_for_staff");
  check("restaurant identified from QR", rows[0].j.restaurant.id === R1 && rows[0].j.table.table_number === "1");
  const menu = await as(guest, "select count(*)::int n from public.menu_items");
  check("guest cannot read menu before joining", menu.rows[0].n === 0);
}

// ---------------------------------------------------------------------------
console.log("Opening a session");
// ---------------------------------------------------------------------------
await expectError("kitchen staff cannot open sessions",
  () => as(kitchen, "select public.open_table_session($1, 2)", [t1.id]), "forbidden");
await expectError("guest cannot open sessions",
  () => as(guest, "select public.open_table_session($1, 2)", [t1.id]), "forbidden");
const { rows: [opened] } = await as(waiter, "select * from public.open_table_session($1, 2)", [t1.id]);
check("waiter opens session", opened.status === "open" && opened.opened_by === waiter);
{
  const { rows } = await su("select status from public.restaurant_tables where id = $1", [t1.id]);
  check("table becomes occupied", rows[0].status === "occupied");
}
await expectError("second session on same table is refused",
  () => as(waiter, "select public.open_table_session($1, 2)", [t1.id]), "table_not_available");
await expectError("cannot deactivate a table with a live session",
  () => as(admin, "update public.restaurant_tables set is_active = false where id = $1", [t1.id]),
  "table_has_live_session");

// ---------------------------------------------------------------------------
console.log("Customer joins");
// ---------------------------------------------------------------------------
{
  const { rows } = await as(guest, "select public.join_table_session($1) j", [t1.qr_token]);
  check("guest joins live session", rows[0].j.status === "joined" && rows[0].j.session.id === opened.id);
  await as(guest, "select public.join_table_session($1)", [t1.qr_token]);
  const g = await su("select count(*)::int n from public.session_guests where session_id = $1", [opened.id]);
  check("re-scanning does not duplicate the guest", g.rows[0].n === 1);

  const items = await as(guest, "select count(*)::int n from public.menu_items");
  check("guest reads the menu", items.rows[0].n === 5);
  const addOns = await as(guest, "select count(*)::int n from public.add_ons");
  check("guest reads add-ons", addOns.rows[0].n === 6);
  const tables = await as(guest, "select count(*)::int n from public.restaurant_tables");
  check("guest sees only their own table", tables.rows[0].n === 1);
  const sessions = await as(guest, "select count(*)::int n from public.table_sessions");
  check("guest sees only their own session", sessions.rows[0].n === 1);
  const emps = await as(guest, "select count(*)::int n from public.employees");
  check("guest cannot read employees", emps.rows[0].n === 0);
  const strangerMenu = await as(stranger, "select count(*)::int n from public.menu_items");
  check("user who has not scanned sees no menu", strangerMenu.rows[0].n === 0);
  await expectError("guest cannot write orders directly",
    () => as(guest,
      `insert into public.orders (restaurant_id, session_id, table_id, order_number, idempotency_key)
       values ($1, $2, $3, 'X', gen_random_uuid())`, [R1, opened.id, t1.id]),
    "row-level security");
  const upd = await as(guest, "update public.menu_items set base_price = 0");
  check("guest price update affects no rows", (upd.affectedRows ?? 0) === 0);
  const price = await su("select min(base_price)::float p from public.menu_items");
  check("prices unchanged after guest attempt", price.rows[0].p > 0);
}

// ---------------------------------------------------------------------------
console.log("QR regeneration");
// ---------------------------------------------------------------------------
await expectError("waiter cannot regenerate QR",
  () => as(waiter, "select public.regenerate_table_qr($1)", [t1.id]), "forbidden");
const { rows: [{ t: newToken }] } = await as(admin, "select public.regenerate_table_qr($1) t", [t1.id]);
check("admin regenerates QR", newToken && newToken !== t1.qr_token);
await expectError("old QR token stops working",
  () => as(stranger, "select public.join_table_session($1)", [t1.qr_token]), "invalid_qr");

// ---------------------------------------------------------------------------
console.log("Waiter assignment");
// ---------------------------------------------------------------------------
{
  const { rows: [w] } = await su("select id from public.employees where user_id = $1", [waiter]);
  const { rows: [k] } = await su("select id from public.employees where user_id = $1", [kitchen]);
  await expectError("waiter cannot assign tables",
    () => as(waiter, "select public.assign_table_waiter($1, $2)", [t1.id, w.id]), "forbidden");
  await expectError("kitchen employee cannot be assigned as waiter",
    () => as(manager, "select public.assign_table_waiter($1, $2)", [t1.id, k.id]), "employee_not_waiter");
  await as(manager, "select public.assign_table_waiter($1, $2)", [t1.id, w.id]);
  await as(manager, "select public.assign_table_waiter($1, $2)", [t1.id, w.id]);
  const a = await su(
    "select count(*) filter (where unassigned_at is null)::int cur, count(*)::int total from public.employee_table_assignments where table_id = $1",
    [t1.id]);
  check("reassignment keeps one current waiter and history", a.rows[0].cur === 1 && a.rows[0].total === 2);
}

// ---------------------------------------------------------------------------
console.log("Closing a session");
// ---------------------------------------------------------------------------
{
  const { rows: [{ n }] } = await su("select app.next_document_number($1, 'ord') n", [R1]);
  const { rows: [{ n: n2 }] } = await su("select app.next_document_number($1, 'ord') n", [R1]);
  check("order numbers are sequential", /^ORD-\d{6}-0001$/.test(n) && n2.endsWith("-0002"), `${n} ${n2}`);
  await su(
    `insert into public.orders (restaurant_id, session_id, table_id, order_number, status, idempotency_key, subtotal)
     values ($1, $2, $3, $4, 'served', gen_random_uuid(), 20)`,
    [R1, opened.id, t1.id, n]);

  await expectError("waiter cannot close sessions",
    () => as(waiter, "select public.close_table_session($1)", [opened.id]), "forbidden");
  await expectError("unpaid session cannot be closed",
    () => as(cashier, "select public.close_table_session($1)", [opened.id]), "outstanding_balance");
  await expectError("cashier cannot force-close with a reason",
    () => as(cashier, "select public.close_table_session($1, 'walked out')", [opened.id]), "forbidden");
  const { rows: [closed] } = await as(manager,
    "select * from public.close_table_session($1, 'Customer walked out')", [opened.id]);
  check("manager force-closes with recorded reason",
    closed.status === "closed" && closed.exceptional_close_reason === "Customer walked out");
  const t = await su("select status from public.restaurant_tables where id = $1", [t1.id]);
  check("table moves to cleaning", t.rows[0].status === "cleaning");
  const menu = await as(guest, "select count(*)::int n from public.menu_items");
  check("guest loses access after session closes", menu.rows[0].n === 0);
  await expectError("cannot open session on a table being cleaned",
    () => as(waiter, "select public.open_table_session($1)", [t1.id]), "table_not_available");
  await as(waiter, "select public.mark_table_cleaned($1)", [t1.id]);
  const t2 = await su("select status from public.restaurant_tables where id = $1", [t1.id]);
  check("cleaning done → available", t2.rows[0].status === "available");
}
{
  // A session with nothing ordered closes without a reason.
  const { rows: [{ id: t2id }] } = await su(
    "select id from public.restaurant_tables where restaurant_id = $1 and table_number = '2'", [R1]);
  const { rows: [s] } = await as(waiter, "select * from public.open_table_session($1)", [t2id]);
  const { rows: [c] } = await as(cashier, "select * from public.close_table_session($1)", [s.id]);
  check("empty session closes normally", c.status === "closed" && c.exceptional_close_reason === null);
}

// ---------------------------------------------------------------------------
console.log("History, audit, roles");
// ---------------------------------------------------------------------------
{
  const h = await su("select array_agg(to_status::text order by id) s from public.table_session_history where session_id = $1", [opened.id]);
  check("session status history recorded", h.rows[0].s.join(",") === "open,closed");
  const a = await su("select count(*)::int n from public.audit_logs where table_name = 'table_sessions' and actor_id = $1", [manager]);
  check("audit log records the manager's close", a.rows[0].n >= 1);
  const visible = await as(waiter, "select count(*)::int n from public.audit_logs");
  check("waiter cannot read audit logs", visible.rows[0].n === 0);
  const mgr = await as(manager, "select count(*)::int n from public.audit_logs");
  check("manager can read audit logs", mgr.rows[0].n > 0);

  await expectError("admin cannot grant super_admin",
    () => as(admin, "insert into public.user_roles (user_id, restaurant_id, role) values ($1, null, 'super_admin')", [waiter]),
    "row-level security");
  await expectError("admin cannot grant roles in another restaurant",
    () => as(admin, "insert into public.user_roles (user_id, restaurant_id, role) values ($1, $2, 'admin')", [waiter, r2.id]),
    "row-level security");
  await as(admin, "insert into public.user_roles (user_id, restaurant_id, role) values ($1, $2, 'cashier')", [waiter, R1]);
  check("admin grants a role in own restaurant", true);

  await su("update public.employees set is_active = false where user_id = $1", [cashier]);
  const deact = await as(cashier, "select count(*)::int n from public.restaurant_tables");
  check("deactivated employee loses access", deact.rows[0].n === 0);
}

// ---------------------------------------------------------------------------
console.log("Access token hook");
// ---------------------------------------------------------------------------
{
  await db.exec("set role supabase_auth_admin");
  const { rows } = await db.query(
    "select public.custom_access_token_hook(jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb)) e",
    [waiter]);
  await db.exec("reset role");
  const roles = rows[0].e.claims.app_roles.map((r) => r.role).sort();
  check("hook adds app_roles claim", roles.join(",") === "cashier,waiter", JSON.stringify(roles));
  await expectError("users cannot call the hook",
    () => as(waiter, "select public.custom_access_token_hook('{}'::jsonb)"), "permission denied");
}

// ---------------------------------------------------------------------------
console.log("Ordering (Phase 2)");
// ---------------------------------------------------------------------------
{
  const BURGER = "44444444-0000-0000-0000-000000000001";
  const CHICKEN = "44444444-0000-0000-0000-000000000002";
  const PIZZA = "44444444-0000-0000-0000-000000000003";
  const LEMONADE = "44444444-0000-0000-0000-000000000004";
  const BROWNIE = "44444444-0000-0000-0000-000000000005";
  const idOf = async (sql, params) => (await su(sql, params)).rows[0].id;
  const large = await idOf("select id from public.item_variations where item_id = $1 and name = 'Large'", [BURGER]);
  const medium = await idOf("select id from public.item_variations where item_id = $1 and name = 'Medium'", [PIZZA]);
  const cheese = await idOf("select id from public.add_ons where name = 'Extra cheese'");
  const patty = await idOf("select id from public.add_ons where name = 'Extra patty'");
  const onions = await idOf("select id from public.add_ons where name = 'No onions'");
  const olives = await idOf("select id from public.add_ons where name = 'Olives'");

  const { rows: [t3] } = await su(
    "select id, qr_token from public.restaurant_tables where restaurant_id = $1 and table_number = '3'", [R1]);
  const { rows: [s3] } = await as(waiter, "select * from public.open_table_session($1, 3)", [t3.id]);
  const diner = await user(null, true);
  await as(diner, "select public.join_table_session($1)", [t3.qr_token]);

  const submit = (uid, items, key = crypto.randomUUID(), session = s3.id) =>
    as(uid, "select public.submit_order($1, $2::jsonb, $3, 'no rush') r", [session, JSON.stringify(items), key])
      .then((r) => r.rows[0].r);
  const orderCount = async () =>
    (await su("select count(*)::int n from public.orders where session_id = $1", [s3.id])).rows[0].n;

  const key = crypto.randomUUID();
  const items = [
    { menu_item_id: BURGER, variation_id: large, quantity: 2, add_on_ids: [cheese, patty],
      special_instructions: "  medium rare  ", unit_price: 0 /* ignored */ },
    { menu_item_id: LEMONADE, quantity: 1 },
  ];
  const first = await submit(diner, items, key);
  check("order submitted with pending status", first.status === "pending_confirmation" && !first.duplicate);
  check("order number generated", /^ORD-\d{6}-\d{4}$/.test(first.order_number), first.order_number);
  check("subtotal computed by the database (2×(9.50+2.50+1+3) + 3.50 = 35.50)", Number(first.subtotal) === 35.5,
    String(first.subtotal));

  const { rows: lines } = await su(
    `select item_name_snapshot, variation_name_snapshot, unit_price_snapshot::float u, quantity, line_total::float t,
            special_instructions, status, station_id
       from public.order_items where order_id = $1 order by line_total desc`, [first.order_id]);
  check("line snapshots stored", lines[0].item_name_snapshot === "Classic Burger"
    && lines[0].variation_name_snapshot === "Large" && lines[0].u === 12 && lines[0].t === 32);
  check("instructions trimmed and saved", lines[0].special_instructions === "medium rare");
  check("items start pending and carry their kitchen station",
    lines.every((l) => l.status === "pending") && lines[0].station_id === "22222222-0000-0000-0000-000000000001");
  const addOnRows = await su(
    "select count(*)::int n, sum(price_snapshot)::float p from public.order_item_add_ons oa join public.order_items oi on oi.id = oa.order_item_id where oi.order_id = $1",
    [first.order_id]);
  check("add-on snapshots stored", addOnRows.rows[0].n === 2 && addOnRows.rows[0].p === 4);

  const again = await submit(diner, items, key);
  check("same idempotency key returns the same order", again.duplicate === true && again.order_id === first.order_id);
  check("no duplicate order created", (await orderCount()) === 1);

  await su("update public.menu_items set base_price = 99 where id = $1", [BURGER]);
  const snap = await su("select unit_price_snapshot::float u from public.order_items where order_id = $1 and menu_item_id = $2",
    [first.order_id, BURGER]);
  check("menu price change does not alter submitted order", snap.rows[0].u === 12);
  await su("update public.menu_items set base_price = 9.50 where id = $1", [BURGER]);

  const sess = await su("select status from public.table_sessions where id = $1", [s3.id]);
  check("first order moves session to active", sess.rows[0].status === "active");
  const hist = await su("select count(*)::int n from public.order_status_history where order_id = $1", [first.order_id]);
  check("order status history recorded", hist.rows[0].n === 1);
  const notes = await as(waiter, "select n.title from public.notifications n where n.order_id = $1", [first.order_id]);
  check("waiter notified about the new order", notes.rows.length === 1 && notes.rows[0].title.includes("Table 3"));
  const guestNotes = await as(diner, "select count(*)::int n from public.notifications");
  check("customer does not see staff notifications", guestNotes.rows[0].n === 0);

  const before = await orderCount();
  await expectError("variation required when item has variations",
    () => submit(diner, [{ menu_item_id: BURGER, quantity: 1 }]), "variation_required");
  await expectError("variation from another item rejected",
    () => submit(diner, [{ menu_item_id: BURGER, variation_id: medium, quantity: 1 }]), "invalid_variation");
  await expectError("add-on not linked to the item rejected",
    () => submit(diner, [{ menu_item_id: CHICKEN, quantity: 1, add_on_ids: [olives] }]), "invalid_add_on");
  await expectError("duplicate add-on rejected",
    () => submit(diner, [{ menu_item_id: CHICKEN, quantity: 1, add_on_ids: [cheese, cheese] }]), "invalid_add_on");
  await su("update public.add_on_groups set max_select = 1 where name = 'Burger extras'");
  await expectError("more add-ons than the group maximum rejected",
    () => submit(diner, [{ menu_item_id: CHICKEN, quantity: 1, add_on_ids: [cheese, onions] }]), "add_on_selection_invalid");
  await su("update public.add_on_groups set max_select = 3 where name = 'Burger extras'");
  await su("update public.add_on_groups set min_select = 1 where name = 'Pizza toppings'");
  await expectError("fewer add-ons than the group minimum rejected",
    () => submit(diner, [{ menu_item_id: PIZZA, variation_id: medium, quantity: 1 }]), "add_on_selection_invalid");
  await su("update public.add_on_groups set min_select = 0 where name = 'Pizza toppings'");
  await su("update public.menu_items set is_available = false where id = $1", [BROWNIE]);
  await expectError("unavailable item cannot be ordered",
    () => submit(diner, [{ menu_item_id: BROWNIE, quantity: 1 }]), "item_unavailable");
  await su("update public.menu_items set is_available = true, is_active = false where id = $1", [BROWNIE]);
  await expectError("inactive item cannot be ordered",
    () => submit(diner, [{ menu_item_id: BROWNIE, quantity: 1 }]), "item_not_found");
  await su("update public.menu_items set is_active = true where id = $1", [BROWNIE]);
  await expectError("unknown item id rejected",
    () => submit(diner, [{ menu_item_id: "not-a-uuid", quantity: 1 }]), "item_not_found");
  for (const [label, q] of [["zero", 0], ["fractional", 1.5], ["text", "2"], ["huge", 500]]) {
    await expectError(`${label} quantity rejected`,
      () => submit(diner, [{ menu_item_id: LEMONADE, quantity: q }]), "invalid_quantity");
  }
  await expectError("empty order rejected", () => submit(diner, []), "empty_order");
  await expectError("partially valid order rejected as a whole",
    () => submit(diner, [{ menu_item_id: LEMONADE, quantity: 1 }, { menu_item_id: BURGER, quantity: 1 }]),
    "variation_required");
  check("failed submissions leave no partial orders", (await orderCount()) === before);

  await expectError("user who has not scanned this table cannot order",
    () => submit(stranger, [{ menu_item_id: LEMONADE, quantity: 1 }]), "forbidden");
  const waiterOrder = await submit(waiter, [{ menu_item_id: LEMONADE, quantity: 2 }]);
  check("waiter can place an order for the table", Number(waiterOrder.subtotal) === 7);

  const own = await as(diner, "select count(*)::int n from public.orders");
  const ownItems = await as(diner, "select count(*)::int n from public.order_items");
  check("customer sees their table's orders", own.rows[0].n === 2 && ownItems.rows[0].n === 3);
  const other = await as(stranger, "select count(*)::int n from public.orders");
  check("other customers see none of them", other.rows[0].n === 0);
  await expectError("customer cannot edit an order",
    () => as(diner, "update public.orders set subtotal = 0 where id = $1 returning id", [first.order_id])
      .then((r) => { if (r.rows.length === 0) throw new Error("row-level security: no rows"); }),
    "row-level security");

  await expectError("stranger cannot cancel the order",
    () => as(stranger, "select public.cancel_pending_order($1)", [first.order_id]), "forbidden");
  await as(diner, "select public.cancel_pending_order($1)", [first.order_id]);
  const cancelled = await su(
    "select o.status, o.rejection_reason, bool_and(oi.status = 'cancelled') items from public.orders o join public.order_items oi on oi.order_id = o.id where o.id = $1 group by o.id",
    [first.order_id]);
  check("customer cancels a pending order with a recorded reason",
    cancelled.rows[0].status === "cancelled" && cancelled.rows[0].rejection_reason === "Cancelled by customer"
    && cancelled.rows[0].items);
  await expectError("cannot cancel twice",
    () => as(diner, "select public.cancel_pending_order($1)", [first.order_id]), "order_already_confirmed");

  for (let i = 0; i < 4; i++) await submit(diner, [{ menu_item_id: LEMONADE, quantity: 1 }]);
  await expectError("pending orders per table are capped",
    () => submit(diner, [{ menu_item_id: LEMONADE, quantity: 1 }]), "too_many_pending_orders");

  await as(manager, "select * from public.close_table_session($1, 'test')", [s3.id]);
  await expectError("customer cannot order after the session closes",
    () => submit(diner, [{ menu_item_id: LEMONADE, quantity: 1 }]), "forbidden");
  await expectError("nobody can order on a closed session",
    () => submit(waiter, [{ menu_item_id: LEMONADE, quantity: 1 }]), "session_closed");
  const pend = await su("select count(*)::int n from public.orders where session_id = $1 and status = 'pending_confirmation'", [s3.id]);
  check("unconfirmed orders are cancelled when the session closes", pend.rows[0].n === 0);
}

// ---------------------------------------------------------------------------
console.log("Waiter & kitchen (Phase 3)");
// ---------------------------------------------------------------------------
{
  const BURGER = "44444444-0000-0000-0000-000000000001";
  const CHICKEN = "44444444-0000-0000-0000-000000000002";
  const LEMONADE = "44444444-0000-0000-0000-000000000004";
  const BROWNIE = "44444444-0000-0000-0000-000000000005";
  const GRILL = "22222222-0000-0000-0000-000000000001";
  const BEVERAGE = "22222222-0000-0000-0000-000000000003";
  const regular = (await su("select id from public.item_variations where item_id = $1 and name = 'Regular'", [BURGER])).rows[0].id;

  const grillCook = await staff("grill@demo.test", "kitchen");
  const barista = await staff("bar@demo.test", "kitchen");
  for (const [uid, station] of [[grillCook, GRILL], [barista, BEVERAGE]]) {
    await su(`insert into public.employee_station_assignments (employee_id, station_id)
              select id, $2 from public.employees where user_id = $1`, [uid, station]);
  }

  const { rows: [t4] } = await su(
    "select id, qr_token from public.restaurant_tables where restaurant_id = $1 and table_number = '4'", [R1]);
  const { rows: [wEmp] } = await su("select id from public.employees where user_id = $1", [waiter]);
  await as(manager, "select public.assign_table_waiter($1, $2)", [t4.id, wEmp.id]);
  const { rows: [s4] } = await as(waiter, "select * from public.open_table_session($1, 2)", [t4.id]);
  const guest4 = await user(null, true);
  await as(guest4, "select public.join_table_session($1)", [t4.qr_token]);

  const order = async (items) =>
    (await as(guest4, "select public.submit_order($1, $2::jsonb, gen_random_uuid()) r", [s4.id, JSON.stringify(items)])).rows[0].r;
  const status = async (id) => (await su("select status from public.orders where id = $1", [id])).rows[0].status;
  const itemId = async (orderId, menuItem) =>
    (await su("select id from public.order_items where order_id = $1 and menu_item_id = $2", [orderId, menuItem])).rows[0].id;
  const unread = async (uid, type) =>
    (await as(uid, `select count(*)::int n from public.notifications n
                    join public.notification_recipients r on r.notification_id = n.id
                    where r.user_id = auth.uid() and r.read_at is null and n.type = $1`, [type])).rows[0].n;

  const o1 = await order([
    { menu_item_id: BURGER, variation_id: regular, quantity: 1 },
    { menu_item_id: CHICKEN, quantity: 1 },
    { menu_item_id: LEMONADE, quantity: 2 },
  ]);
  check("assigned waiter gets the new-order notification", (await unread(waiter, "order.new")) >= 1);

  await expectError("kitchen staff cannot confirm orders",
    () => as(kitchen, "select public.confirm_order($1)", [o1.order_id]), "forbidden");
  await expectError("customers cannot confirm orders",
    () => as(guest4, "select public.confirm_order($1)", [o1.order_id]), "forbidden");
  check("unconfirmed order has no kitchen tickets",
    (await su("select count(*)::int n from public.kitchen_tickets where order_id = $1", [o1.order_id])).rows[0].n === 0);

  await as(waiter, "select public.confirm_order($1)", [o1.order_id]);
  check("confirmed order is sent to the kitchen", (await status(o1.order_id)) === "sent_to_kitchen");
  const conf = await su("select confirmed_by, confirmed_at from public.orders where id = $1", [o1.order_id]);
  check("confirming waiter and time recorded", conf.rows[0].confirmed_by === waiter && conf.rows[0].confirmed_at);
  const hist = await su("select array_agg(to_status::text order by id) s from public.order_status_history where order_id = $1", [o1.order_id]);
  check("history shows pending → confirmed → sent to kitchen", hist.rows[0].s.join(",") === "pending_confirmation,confirmed,sent_to_kitchen");
  await expectError("an order can only be confirmed once",
    () => as(waiter, "select public.confirm_order($1)", [o1.order_id]), "order_not_pending");

  const tickets = await su(
    "select t.id, t.station_id, count(ti.*)::int n from public.kitchen_tickets t join public.kitchen_ticket_items ti on ti.ticket_id = t.id where t.order_id = $1 group by t.id",
    [o1.order_id]);
  const grillTicket = tickets.rows.find((t) => t.station_id === GRILL);
  const barTicket = tickets.rows.find((t) => t.station_id === BEVERAGE);
  check("order split into one ticket per station", tickets.rows.length === 2 && grillTicket?.n === 2 && barTicket?.n === 1);
  const seen = async (uid) => (await as(uid, "select count(*)::int n from public.kitchen_tickets where order_id = $1", [o1.order_id])).rows[0].n;
  check("grill cook sees only the grill ticket", (await seen(grillCook)) === 1);
  check("barista sees only the beverage ticket", (await seen(barista)) === 1);
  check("kitchen staff without stations see all tickets", (await seen(kitchen)) === 2);
  check("grill cook notified of the grill ticket only", (await unread(grillCook, "ticket.new")) === 1);

  await expectError("barista cannot touch the grill ticket",
    () => as(barista, "select public.start_ticket($1)", [grillTicket.id]), "forbidden");
  await expectError("waiter cannot run kitchen tickets",
    () => as(waiter, "select public.start_ticket($1)", [grillTicket.id]), "forbidden");
  await as(grillCook, "select public.accept_ticket($1)", [grillTicket.id]);
  await expectError("ticket accepted only once",
    () => as(grillCook, "select public.accept_ticket($1)", [grillTicket.id]), "ticket_not_new");
  await as(grillCook, "select public.start_ticket($1)", [grillTicket.id]);
  const tk = await su("select status, started_at, accepted_by from public.kitchen_tickets where id = $1", [grillTicket.id]);
  check("ticket preparing with start time and cook recorded",
    tk.rows[0].status === "preparing" && tk.rows[0].started_at && tk.rows[0].accepted_by === grillCook);
  check("order becomes preparing", (await status(o1.order_id)) === "preparing");
  check("waiter told preparation started", (await unread(waiter, "order.preparing")) >= 1);

  const burgerItem = await itemId(o1.order_id, BURGER);
  const chickenItem = await itemId(o1.order_id, CHICKEN);
  const lemonadeItem = await itemId(o1.order_id, LEMONADE);
  const burgerTi = (await su("select id from public.kitchen_ticket_items where order_item_id = $1", [burgerItem])).rows[0].id;
  await as(grillCook, "select public.mark_ticket_items_ready($1, $2)", [grillTicket.id, [burgerTi]]);
  check("one item ready → ticket partially ready",
    (await su("select status from public.kitchen_tickets where id = $1", [grillTicket.id])).rows[0].status === "partially_ready");
  check("order partially ready", (await status(o1.order_id)) === "partially_ready");
  check("waiter told the item is ready", (await unread(waiter, "item.ready")) >= 1);
  await expectError("an item can't be marked ready twice",
    () => as(grillCook, "select public.mark_ticket_items_ready($1, $2)", [grillTicket.id, [burgerTi]]), "item_not_preparable");

  await expectError("item that isn't ready can't be served",
    () => as(waiter, "select public.serve_items($1)", [[lemonadeItem]]), "item_not_ready");
  await expectError("order can't be marked served while items are outstanding",
    () => as(waiter, "select public.serve_order($1)", [o1.order_id]), "order_not_ready");
  await expectError("kitchen cannot serve",
    () => as(grillCook, "select public.serve_items($1)", [[burgerItem]]), "forbidden");
  await as(waiter, "select public.serve_items($1)", [[burgerItem]]);
  const served = await su("select status, served_by, served_at from public.order_items where id = $1", [burgerItem]);
  check("serving records employee and time", served.rows[0].status === "served" && served.rows[0].served_by === waiter && served.rows[0].served_at);
  check("order partially served", (await status(o1.order_id)) === "partially_served");
  await expectError("served item can't be cancelled",
    () => as(waiter, "select public.cancel_order_item($1, 'changed mind')", [burgerItem]), "item_already_served");

  await expectError("cancelling needs a reason",
    () => as(waiter, "select public.cancel_order_item($1, ' ')", [lemonadeItem]), "reason_required");
  const direct = await as(waiter, "select public.cancel_order_item($1, 'Customer changed mind') r", [lemonadeItem]);
  check("waiter cancels an item the kitchen hasn't started", direct.rows[0].r === "cancelled");
  check("its ticket is cancelled",
    (await su("select status from public.kitchen_tickets where id = $1", [barTicket.id])).rows[0].status === "cancelled");
  check("station told about the cancellation", (await unread(barista, "ticket.cancelled")) === 1);

  const req = await as(waiter, "select public.cancel_order_item($1, 'Too slow') r", [chickenItem]);
  check("cancelling an item in preparation needs approval", req.rows[0].r === "requested");
  check("item keeps cooking until approved",
    (await su("select status from public.order_items where id = $1", [chickenItem])).rows[0].status === "preparing");
  await expectError("duplicate cancellation request refused",
    () => as(waiter, "select public.cancel_order_item($1, 'again')", [chickenItem]), "cancellation_already_requested");
  check("manager notified of the request", (await unread(manager, "cancellation.requested")) >= 1);
  const { rows: [reqRow] } = await su("select id from public.order_cancellation_requests where order_item_id = $1 and status = 'pending'", [chickenItem]);
  await expectError("waiter cannot approve cancellations",
    () => as(waiter, "select public.review_cancellation($1, true)", [reqRow.id]), "forbidden");
  await as(manager, "select public.review_cancellation($1, false)", [reqRow.id]);
  check("denied request leaves the item alone",
    (await su("select status from public.order_items where id = $1", [chickenItem])).rows[0].status === "preparing");
  check("requester told the outcome", (await unread(waiter, "cancellation.reviewed")) >= 1);

  await as(grillCook, "select public.mark_ticket_items_ready($1)", [grillTicket.id]);
  check("whole ticket ready",
    (await su("select status, ready_at from public.kitchen_tickets where id = $1", [grillTicket.id])).rows[0].ready_at !== null);
  await as(waiter, "select public.serve_order($1)", [o1.order_id]);
  const fin = await su("select status, served_at from public.orders where id = $1", [o1.order_id]);
  check("serving the rest marks the order served", fin.rows[0].status === "served" && fin.rows[0].served_at);
  const kitchenPrice = await as(grillCook, "update public.order_items set unit_price_snapshot = 0 where order_id = $1", [o1.order_id]);
  check("kitchen cannot change order prices", (kitchenPrice.affectedRows ?? 0) === 0);

  // Rejection
  const o2 = await order([{ menu_item_id: LEMONADE, quantity: 1 }]);
  await expectError("rejection needs a reason",
    () => as(waiter, "select public.reject_order($1, '')", [o2.order_id]), "reason_required");
  await as(waiter, "select public.reject_order($1, 'Kitchen closing')", [o2.order_id]);
  const rej = await as(guest4, "select status, rejection_reason from public.orders where id = $1", [o2.order_id]);
  check("customer sees the rejection and reason", rej.rows[0].status === "rejected" && rej.rows[0].rejection_reason === "Kitchen closing");
  check("rejected order never reaches the kitchen",
    (await su("select count(*)::int n from public.kitchen_tickets where order_id = $1", [o2.order_id])).rows[0].n === 0);
  await expectError("rejected order can't be confirmed",
    () => as(waiter, "select public.confirm_order($1)", [o2.order_id]), "order_not_pending");

  // Clarification
  const o3 = await order([{ menu_item_id: LEMONADE, quantity: 3 }]);
  await expectError("answer without a question refused",
    () => as(guest4, "select public.answer_order_clarification($1, 'hi')", [o3.order_id]), "no_question_pending");
  await as(waiter, "select public.request_order_clarification($1, 'Three lemonades or three glasses?')", [o3.order_id]);
  const held = await as(guest4, "select status, clarification_question q from public.orders where id = $1", [o3.order_id]);
  check("customer sees the waiter's question", held.rows[0].status === "on_hold" && held.rows[0].q.startsWith("Three"));
  await expectError("orders on hold can't be confirmed",
    () => as(waiter, "select public.confirm_order($1)", [o3.order_id]), "order_not_pending");
  await expectError("other customers can't answer",
    () => as(stranger, "select public.answer_order_clarification($1, 'x')", [o3.order_id]), "forbidden");
  await as(guest4, "select public.answer_order_clarification($1, 'Three lemonades please')", [o3.order_id]);
  const answered = await su("select status, clarification_answer a from public.orders where id = $1", [o3.order_id]);
  check("answer sends the order back to the waiter", answered.rows[0].status === "pending_confirmation" && answered.rows[0].a === "Three lemonades please");
  check("waiter notified of the answer", (await unread(waiter, "order.clarified")) >= 1);

  // Kitchen reports an item as unavailable
  const o4 = await order([{ menu_item_id: BROWNIE, quantity: 1 }]);
  await as(waiter, "select public.confirm_order($1)", [o4.order_id]);
  const brownieTi = (await su(
    "select ti.id from public.kitchen_ticket_items ti join public.order_items oi on oi.id = ti.order_item_id where oi.order_id = $1",
    [o4.order_id])).rows[0].id;
  await as(kitchen, "select public.report_item_unavailable($1, 'last one burnt')", [brownieTi]);
  check("reported item comes off the menu",
    (await su("select is_available from public.menu_items where id = $1", [BROWNIE])).rows[0].is_available === false);
  check("waiter told it's unavailable", (await unread(waiter, "item.unavailable")) >= 1);
  await su("update public.menu_items set is_available = true where id = $1", [BROWNIE]);
  const ticket4 = (await su("select id from public.kitchen_tickets where order_id = $1", [o4.order_id])).rows[0].id;
  await as(kitchen, "select public.kitchen_message_waiter($1, 'Ice cream or cream?')", [ticket4]);
  check("kitchen can message the waiter", (await unread(waiter, "kitchen.question")) >= 1);
  const mgrCancel = await as(manager, "select public.cancel_order_item($1, 'Out of stock') r", [await itemId(o4.order_id, BROWNIE)]);
  check("manager cancels immediately and the empty order is cancelled",
    mgrCancel.rows[0].r === "cancelled" && (await status(o4.order_id)) === "cancelled");

  // Stale-order alert
  await su("update public.orders set created_at = now() - interval '20 minutes' where id = $1", [o3.order_id]);
  const { rows: [{ n: alerted }] } = await su("select app.alert_stale_orders() n");
  const { rows: [{ n: again }] } = await su("select app.alert_stale_orders() n");
  check("manager alerted once about a long-waiting order", alerted === 1 && again === 0);
  check("manager receives the stale alert", (await unread(manager, "order.stale")) === 1);

  // Notifications housekeeping
  await as(waiter, "select public.mark_all_notifications_read()");
  check("mark all notifications read", (await unread(waiter, "order.new")) === 0);

  // Closing the session cancels orders still on hold
  await as(waiter, "select public.request_order_clarification($1, 'Still want them?')", [o3.order_id]);
  await as(manager, "select * from public.close_table_session($1, 'test')", [s4.id]);
  check("orders on hold are cancelled when the session closes", (await status(o3.order_id)) === "cancelled");
}

// ---------------------------------------------------------------------------
console.log("Billing & POS (Phase 4)");
// ---------------------------------------------------------------------------
{
  const BURGER = "44444444-0000-0000-0000-000000000001";
  const LEMONADE = "44444444-0000-0000-0000-000000000004";
  const idOf = async (sql, params) => (await su(sql, params)).rows[0].id;
  const large = await idOf("select id from public.item_variations where item_id = $1 and name = 'Large'", [BURGER]);
  const cheese = await idOf("select id from public.add_ons where name = 'Extra cheese'");
  const patty = await idOf("select id from public.add_ons where name = 'Extra patty'");
  const register = await idOf("select id from public.cash_registers where restaurant_id = $1", [R1]);
  const till = await staff("till@demo.test", "cashier");
  const server = await staff("server@demo.test", "waiter"); // waiter role only
  const r2 = (n) => Math.round(n * 100) / 100;

  const tableId = async (n) => (await su("select id, qr_token from public.restaurant_tables where restaurant_id = $1 and table_number = $2", [R1, n])).rows[0];
  const t5 = await tableId("5");
  const { rows: [s5] } = await as(waiter, "select * from public.open_table_session($1, 2)", [t5.id]);
  const g5 = await user(null, true);
  await as(g5, "select public.join_table_session($1)", [t5.qr_token]);
  const order = async (items) =>
    (await as(g5, "select public.submit_order($1, $2::jsonb, gen_random_uuid()) r", [s5.id, JSON.stringify(items)])).rows[0].r;
  const inv = async (id) => (await su("select * from public.invoices where id = $1", [id])).rows[0];
  const unread = async (uid, type) =>
    (await as(uid, `select count(*)::int n from public.notifications n join public.notification_recipients r on r.notification_id = n.id
                    where r.user_id = auth.uid() and n.type = $1`, [type])).rows[0].n;

  const o1 = await order([
    { menu_item_id: BURGER, variation_id: large, quantity: 2, add_on_ids: [cheese, patty] },
    { menu_item_id: LEMONADE, quantity: 1 },
  ]);
  await as(waiter, "select public.confirm_order($1)", [o1.order_id]);

  await as(g5, "select public.request_bill($1)", [s5.id]);
  await as(g5, "select public.request_bill($1)", [s5.id]);
  check("bill request notifies the cashier once", (await unread(till, "bill.requested")) === 1);

  await expectError("kitchen cannot start billing",
    () => as(kitchen, "select public.generate_invoice($1)", [s5.id]), "forbidden");
  const { rows: [{ id: invId }] } = await as(waiter, "select public.generate_invoice($1) id", [s5.id]);
  let i = await inv(invId);
  check("invoice numbered and linked to the session", /^INV-\d{6}-\d{4}$/.test(i.invoice_number) && i.session_id === s5.id);
  check("same totals as the customer's cart estimate (35.50 → 40.12)",
    Number(i.subtotal) === 35.5 && Number(i.tax_total) === 2.84 && Number(i.service_charge_total) === 1.78 && Number(i.total) === 40.12,
    JSON.stringify([i.subtotal, i.tax_total, i.service_charge_total, i.total]));
  check("tax breakdown stored", i.tax_breakdown.length === 1 && i.tax_breakdown[0].name === "Sales tax");
  const sess = await su("select s.status ss, t.status ts from public.table_sessions s join public.restaurant_tables t on t.id = s.table_id where s.id = $1", [s5.id]);
  check("session and table move to billing", sess.rows[0].ss === "billing" && sess.rows[0].ts === "billing");
  const { rows: [{ id: again }] } = await as(till, "select public.generate_invoice($1) id", [s5.id]);
  check("one invoice per session", again === invId);

  const pending = await order([{ menu_item_id: LEMONADE, quantity: 5 }]);
  await as(till, "select public.generate_invoice($1)", [s5.id]);
  check("unconfirmed orders are not billed", Number((await inv(invId)).subtotal) === 35.5);
  await expectError("bill can't be finalized while an order waits for the waiter",
    () => as(till, "select public.finalize_invoice($1)", [invId]), "orders_pending");
  await as(waiter, "select public.reject_order($1, 'Duplicate')", [pending.order_id]);
  const o2 = await order([{ menu_item_id: LEMONADE, quantity: 2 }]);
  await as(waiter, "select public.confirm_order($1)", [o2.order_id]);
  await as(till, "select public.generate_invoice($1)", [s5.id]);
  i = await inv(invId);
  check("later confirmed orders are added to the bill", Number(i.subtotal) === 42.5);

  // Discounts
  await expectError("discount needs a reason",
    () => as(till, "select public.apply_manual_discount($1, 'percentage', 5, '')", [invId]), "reason_required");
  await as(till, "select public.apply_manual_discount($1, 'percentage', 5, 'Regular customer')", [invId]);
  await expectError("cashier can't go over the discount limit",
    () => as(till, "select public.apply_manual_discount($1, 'percentage', 10, 'More')", [invId]), "discount_needs_manager");
  await expectError("waiter can't apply discounts",
    () => as(server, "select public.apply_manual_discount($1, 'percentage', 1, 'x')", [invId]), "forbidden");
  await su(`insert into public.discounts (restaurant_id, name, code, type, value, scope, target_item_id, max_uses)
            values ($1, 'Lemonade BOGO', 'LEMON2', 'bogo', 0, 'item', $2, 1),
                   ($1, 'Old promo', 'OLD', 'percentage', 50, 'order', null, null)`, [R1, LEMONADE]);
  await su("update public.discounts set ends_at = now() - interval '1 day' where code = 'OLD'");
  await expectError("unknown coupon rejected", () => as(till, "select public.apply_coupon($1, 'NOPE')", [invId]), "coupon_invalid");
  await expectError("expired coupon rejected", () => as(till, "select public.apply_coupon($1, 'old')", [invId]), "coupon_expired");
  await as(till, "select public.apply_coupon($1, ' lemon2 ')", [invId]);
  await expectError("coupon can't be applied twice", () => as(till, "select public.apply_coupon($1, 'LEMON2')", [invId]), "coupon_already_applied");
  i = await inv(invId);
  // 5% of 42.50 = 2.13; BOGO on 3 lemonades = 1 free × 3.50
  const disc = 2.13 + 3.5;
  const net = 42.5 - disc;
  const expectTotal = r2(net + r2(net * 0.08) + r2(net * 0.05));
  check("percentage + BOGO coupon discounts", Number(i.discount_total) === r2(disc), String(i.discount_total));
  check("tax and service charge computed after discounts", Number(i.total) === expectTotal, `${i.total} vs ${expectTotal}`);
  check("coupon use counted", (await su("select used_count from public.discounts where code = 'LEMON2'")).rows[0].used_count === 1);
  const { rows: [coupon] } = await su("select id from public.discount_applications where invoice_id = $1 and discount_id is not null", [invId]);
  await as(till, "select public.remove_discount($1)", [coupon.id]);
  check("removing a coupon releases its use", (await su("select used_count from public.discounts where code = 'LEMON2'")).rows[0].used_count === 0);
  await as(manager, "select public.apply_manual_discount($1, 'fixed_amount', 2.37, 'Manager comp')", [invId]);
  i = await inv(invId);
  check("manager can exceed the limit", Number(i.discount_total) === 4.5, String(i.discount_total));
  const total = Number(i.total);

  // Payments
  await expectError("waiter can't take payments",
    () => as(server, "select public.record_payment($1, 'card', gen_random_uuid(), 5)", [invId]), "forbidden");
  await expectError("cash needs an open register",
    () => as(till, "select public.record_payment($1, 'cash', gen_random_uuid(), 5)", [invId]), "register_not_open");
  const { rows: [{ id: reg }] } = await as(till, "select public.open_register_session($1, 100) id", [register]);
  await expectError("register can't be opened twice",
    () => as(manager, "select public.open_register_session($1, 50)", [register]), "register_in_use");

  const declined = (await as(till, "select public.record_payment($1, 'card', gen_random_uuid(), 10, null, null, null, 'Ana', true, 'Card declined') r", [invId])).rows[0].r;
  i = await inv(invId);
  check("declined card is recorded but not counted", declined.status === "failed" && Number(i.amount_paid) === 0 && i.status === "payment_failed");
  check("first payment attempt finalizes the bill", i.finalized_at !== null);
  await expectError("final bill can't get more discounts",
    () => as(manager, "select public.apply_manual_discount($1, 'percentage', 1, 'late')", [invId]), "invoice_finalized");
  await expectError("no new orders once the bill is final",
    () => order([{ menu_item_id: LEMONADE, quantity: 1 }]), "bill_in_progress");

  const burgerLine = (await su("select id, line_total from public.invoice_items where invoice_id = $1 and menu_item_id = $2", [invId, BURGER])).rows[0];
  const byItems = (await as(till, "select public.record_payment($1, 'card', gen_random_uuid(), null, 'AUTH123', null, $2, 'Ana') r", [invId, [burgerLine.id]])).rows[0].r;
  const share = r2(Number(burgerLine.line_total) * total / Number(i.subtotal));
  check("split by items charges the items' share incl. tax and service", Number(byItems.amount) === share, `${byItems.amount} vs ${share}`);
  await expectError("an item can't be paid twice",
    () => as(till, "select public.record_payment($1, 'card', gen_random_uuid(), null, null, null, $2)", [invId, [burgerLine.id]]), "items_already_paid");

  const key = crypto.randomUUID();
  const cash = (await as(till, "select public.record_payment($1, 'cash', $2, 5, null, 20, null, 'Ben') r", [invId, key])).rows[0].r;
  check("cash payment gives change", Number(cash.amount) === 5 && Number(cash.change) === 15 && cash.invoice_status === "partially_paid");
  const dup = (await as(till, "select public.record_payment($1, 'cash', $2, 5, null, 20) r", [invId, key])).rows[0].r;
  check("retrying a payment doesn't charge twice", dup.duplicate === true && Number((await inv(invId)).amount_paid) === r2(share + 5));
  await expectError("can't pay more than is owed",
    () => as(till, "select public.record_payment($1, 'card', gen_random_uuid(), 1000)", [invId]), "amount_exceeds_balance");
  await expectError("cash tendered must cover the amount",
    () => as(till, "select public.record_payment($1, 'cash', gen_random_uuid(), 3, null, 2)", [invId]), "tendered_too_low");
  const rest = (await as(till, "select public.record_payment($1, 'card', gen_random_uuid()) r", [invId])).rows[0].r;
  i = await inv(invId);
  check("paying the rest settles the invoice exactly",
    rest.invoice_status === "paid" && Number(i.amount_paid) === total && Number(rest.outstanding) === 0, `${i.amount_paid} vs ${total}`);
  await expectError("paid invoice takes no more payments",
    () => as(till, "select public.record_payment($1, 'card', gen_random_uuid(), 1)", [invId]), "invoice_already_paid");
  await expectError("invoice with payments can't be voided",
    () => as(manager, "select public.void_invoice($1, 'oops')", [invId]), "invoice_has_payments");

  const guestBill = await as(g5, "select total from public.invoices where id = $1", [invId]);
  check("customer can see their bill", Number(guestBill.rows[0]?.total) === total);
  const guestPays = await as(g5, "select count(*)::int n from public.payments");
  check("customer can't see payment records", guestPays.rows[0].n === 0);

  // Refunds
  const cashPay = (await su("select id from public.payments where idempotency_key = $1", [key])).rows[0].id;
  await expectError("refund can't exceed the payment",
    () => as(till, "select public.request_refund($1, 6, 'Too much')", [cashPay]), "refund_exceeds_payment");
  const req = (await as(till, "select public.request_refund($1, 2, 'Cold fries') r", [cashPay])).rows[0].r;
  check("cashier refund waits for a manager", req === "pending" && (await inv(invId)).status === "refund_pending");
  check("manager notified of the refund request", (await unread(manager, "refund.requested")) >= 1);
  const { rows: [refund] } = await su("select id from public.refunds where payment_id = $1", [cashPay]);
  await expectError("cashier can't approve refunds",
    () => as(till, "select public.review_refund($1, true)", [refund.id]), "forbidden");
  await as(manager, "select public.review_refund($1, true)", [refund.id]);
  i = await inv(invId);
  check("approved refund recorded against the invoice", Number(i.amount_refunded) === 2 && i.status === "partially_refunded");
  const cardPay = (await su("select id from public.payments where reference = 'AUTH123'")).rows[0].id;
  const mgrRefund = (await as(manager, "select public.request_refund($1, 1, 'Goodwill') r", [cardPay])).rows[0].r;
  check("manager's own refund is approved immediately", mgrRefund === "approved" && Number((await inv(invId)).amount_refunded) === 3);
  check("refund linked to its payment and invoice",
    (await su("select count(*)::int n from public.refunds where invoice_id = $1 and payment_id is not null", [invId])).rows[0].n === 2);

  // Receipt
  i = await inv(invId);
  await db.exec("set role service_role");
  const receipt = (await db.query("select public.get_receipt($1) r", [i.receipt_token])).rows[0].r;
  await db.exec("reset role");
  check("digital receipt by token", receipt.invoice.invoice_number === i.invoice_number && receipt.items.length === 3 && receipt.payments.length === 3);
  await expectError("receipts aren't readable by signed-in users directly",
    () => as(g5, "select public.get_receipt($1)", [i.receipt_token]), "permission denied");

  // Close the table
  const { rows: [closed] } = await as(till, "select * from public.close_table_session($1)", [s5.id]);
  check("paid table closes without a manager", closed.status === "closed");

  // Register close-out
  await expectError("closing needs a counted amount",
    () => as(till, "select public.close_register_session($1, null)", [reg]), "invalid_amount");
  const { rows: [closedReg] } = await as(till, "select * from public.close_register_session($1, 102, 'busy night')", [reg]);
  check("expected cash = opening + cash taken − cash refunded (100 + 5 − 2)", Number(closedReg.expected_cash) === 103);
  check("discrepancy recorded", Number(closedReg.discrepancy) === -1);
  check("manager told about the cash difference", (await unread(manager, "register.discrepancy")) === 1);
  await expectError("cashier can't sign off their own count",
    () => as(till, "select public.review_register_session($1, 'ok')", [reg]), "forbidden");
  await as(manager, "select public.review_register_session($1, 'Counted twice, fine')", [reg]);
  check("manager review recorded",
    (await su("select reviewed_by from public.cash_register_sessions where id = $1", [reg])).rows[0].reviewed_by === manager);

  // Void & reopen
  const t6 = await tableId("6");
  const { rows: [s6] } = await as(waiter, "select * from public.open_table_session($1)", [t6.id]);
  const { rows: [{ id: emptyInv }] } = await as(till, "select public.generate_invoice($1) id", [s6.id]);
  await expectError("empty bill can't be finalized",
    () => as(till, "select public.finalize_invoice($1)", [emptyInv]), "invoice_empty");
  const w6 = (await as(waiter, "select public.submit_order($1, $2::jsonb, gen_random_uuid()) r",
    [s6.id, JSON.stringify([{ menu_item_id: LEMONADE, quantity: 1 }])])).rows[0].r;
  await as(waiter, "select public.confirm_order($1)", [w6.order_id]);
  await as(till, "select public.finalize_invoice($1)", [emptyInv]);
  await expectError("cashier can't void invoices",
    () => as(till, "select public.void_invoice($1, 'customer wants more')", [emptyInv]), "forbidden");
  await as(manager, "select public.void_invoice($1, 'Customer wants dessert')", [emptyInv]);
  const reopened = await su("select s.status ss, t.status ts from public.table_sessions s join public.restaurant_tables t on t.id = s.table_id where s.id = $1", [s6.id]);
  check("voiding reopens the table for orders", reopened.rows[0].ss === "active" && reopened.rows[0].ts === "occupied");
  await as(waiter, "select public.submit_order($1, $2::jsonb, gen_random_uuid())", [s6.id, JSON.stringify([{ menu_item_id: LEMONADE, quantity: 1 }])]);
  const { rows: [{ id: newInv }] } = await as(till, "select public.generate_invoice($1) id", [s6.id]);
  check("a fresh invoice replaces the void one", newInv !== emptyInv && (await inv(emptyInv)).status === "void");
}

// ---------------------------------------------------------------------------
console.log("Operations (Phase 5)");
// ---------------------------------------------------------------------------
{
  const LEMONADE = "44444444-0000-0000-0000-000000000004";
  const host = await staff("host@demo.test", "waiter"); // waiter role only
  const tbl = async (n) => (await su("select id, qr_token, status from public.restaurant_tables where restaurant_id = $1 and table_number = $2", [R1, n])).rows[0];
  const tstatus = async (id) => (await su("select status from public.restaurant_tables where id = $1", [id])).rows[0].status;
  const count = async (uid, type) =>
    (await as(uid, `select count(*)::int n from public.notifications n join public.notification_recipients r on r.notification_id = n.id
                    where r.user_id = auth.uid() and n.type = $1`, [type])).rows[0].n;
  const orderAs = async (uid, session, qty = 1) =>
    (await as(uid, "select public.submit_order($1, $2::jsonb, gen_random_uuid()) r", [session, JSON.stringify([{ menu_item_id: LEMONADE, quantity: qty }])])).rows[0].r;

  // --- Service requests ---------------------------------------------------
  const t7 = await tbl("7");
  const { rows: [s7] } = await as(host, "select * from public.open_table_session($1, 2)", [t7.id]);
  const g7 = await user(null, true);
  await as(g7, "select public.join_table_session($1)", [t7.qr_token]);

  const { rows: [{ id: water }] } = await as(g7, "select public.create_service_request($1, 'water') id", [s7.id]);
  const { rows: [{ id: water2 }] } = await as(g7, "select public.create_service_request($1, 'water', 'sparkling please') id", [s7.id]);
  check("repeated request reuses the open one", water === water2);
  check("waiter notified once", (await count(host, "service.water")) === 1);
  check("note updated on the open request",
    (await su("select note from public.customer_service_requests where id = $1", [water])).rows[0].note === "sparkling please");
  await expectError("reporting a problem needs a description",
    () => as(g7, "select public.create_service_request($1, 'problem')", [s7.id]), "message_required");
  await expectError("other customers can't raise requests for this table",
    () => as(stranger, "select public.create_service_request($1, 'call_waiter')", [s7.id]), "forbidden");
  await as(g7, "select public.create_service_request($1, 'problem', 'Wobbly table')", [s7.id]);
  check("problems also go to the manager", (await count(manager, "service.problem")) >= 1);
  const seen = await as(g7, "select status from public.customer_service_requests where id = $1", [water]);
  check("customer sees their request's status", seen.rows[0].status === "open");
  await expectError("customers can't accept requests",
    () => as(g7, "select public.accept_service_request($1)", [water]), "forbidden");
  await as(host, "select public.accept_service_request($1)", [water]);
  await as(host, "select public.complete_service_request($1)", [water]);
  const done = await su("select status, accepted_by, completed_by, accepted_at, completed_at from public.customer_service_requests where id = $1", [water]);
  check("request handled with employee and timestamps",
    done.rows[0].status === "completed" && done.rows[0].accepted_by === host && done.rows[0].completed_by === host && done.rows[0].completed_at);
  await expectError("completed request can't be completed again",
    () => as(host, "select public.complete_service_request($1)", [water]), "request_not_open");
  const { rows: [{ id: water3 }] } = await as(g7, "select public.create_service_request($1, 'water') id", [s7.id]);
  check("a new request is possible once the last one is done", water3 !== water);
  await as(g7, "select public.cancel_service_request($1)", [water3]);
  await as(g7, "select public.create_service_request($1, 'bill')", [s7.id]);
  check("asking for the bill through assistance marks the bill requested",
    (await su("select bill_requested_at from public.table_sessions where id = $1", [s7.id])).rows[0].bill_requested_at !== null);

  // --- Feedback -------------------------------------------------------------
  await expectError("rating must be 1–5", () => as(g7, "select public.submit_feedback($1, 6)", [s7.id]), "invalid_rating");
  await as(g7, "select public.submit_feedback($1, 4, 'Nice')", [s7.id]);
  await as(g7, "select public.submit_feedback($1, 5, 'Great actually')", [s7.id]);
  const fb = await su("select count(*)::int n, max(rating) r from public.customer_feedback where session_id = $1", [s7.id]);
  check("one feedback per guest, updatable", fb.rows[0].n === 1 && fb.rows[0].r === 5);
  await expectError("strangers can't leave feedback", () => as(stranger, "select public.submit_feedback($1, 1)", [s7.id]), "forbidden");
  check("manager reads feedback", (await as(manager, "select count(*)::int n from public.customer_feedback")).rows[0].n >= 1);
  check("waiter can't read feedback", (await as(host, "select count(*)::int n from public.customer_feedback")).rows[0].n === 0);

  // --- Transfer -------------------------------------------------------------
  const o7 = await orderAs(g7, s7.id);
  const t8 = await tbl("8");
  await expectError("waiters can't move parties", () => as(host, "select public.transfer_session($1, $2)", [s7.id, t8.id]), "forbidden");
  await expectError("can't move to the same table", () => as(manager, "select public.transfer_session($1, $2)", [s7.id, t7.id]), "same_table");
  await as(manager, "select public.transfer_session($1, $2, 'Window seat')", [s7.id, t8.id]);
  const moved = await su("select table_id from public.table_sessions where id = $1", [s7.id]);
  const movedOrder = await su("select table_id from public.orders where id = $1", [o7.order_id]);
  check("session and orders move to the new table", moved.rows[0].table_id === t8.id && movedOrder.rows[0].table_id === t8.id);
  check("old table goes to cleaning, new one is occupied", (await tstatus(t7.id)) === "cleaning" && (await tstatus(t8.id)) === "occupied");
  check("transfer history kept",
    (await su("select count(*)::int n from public.table_transfers where session_id = $1 and from_table_id = $2 and to_table_id = $3", [s7.id, t7.id, t8.id])).rows[0].n === 1);
  check("customer keeps their session after the move", (await as(g7, "select count(*)::int n from public.orders")).rows[0].n === 1);
  await as(host, "select public.mark_table_cleaned($1)", [t7.id]);

  // --- Merge ----------------------------------------------------------------
  const t9 = await tbl("9");
  const { rows: [s9] } = await as(host, "select * from public.open_table_session($1, 3)", [t9.id]);
  const g9 = await user(null, true);
  await as(g9, "select public.join_table_session($1)", [t9.qr_token]);
  const o9 = await orderAs(g9, s9.id, 2);
  await as(host, "select public.confirm_order($1)", [o9.order_id]);
  const { rows: [{ id: inv9 }] } = await as(host, "select public.generate_invoice($1) id", [s9.id]);
  await expectError("can't occupy a table that's in use",
    () => as(manager, "select public.transfer_session($1, $2)", [s7.id, t9.id]), "table_not_available");

  await as(host, "select public.merge_sessions($1, $2)", [s7.id, s9.id]);
  const m9 = await su("select status, exceptional_close_reason r from public.table_sessions where id = $1", [s9.id]);
  check("merged session closes with a reason", m9.rows[0].status === "closed" && m9.rows[0].r === "Merged into table 8");
  check("its orders join the primary bill", (await su("select session_id from public.orders where id = $1", [o9.order_id])).rows[0].session_id === s7.id);
  check("its draft invoice is voided", (await su("select status from public.invoices where id = $1", [inv9])).rows[0].status === "void");
  check("merged table stays occupied", (await tstatus(t9.id)) === "occupied");
  check("merged customer sees the combined orders", (await as(g9, "select count(*)::int n from public.orders")).rows[0].n === 2);
  const rescan = (await as(g9, "select public.join_table_session($1) j", [t9.qr_token])).rows[0].j;
  check("scanning the merged table joins the combined party", rescan.status === "joined" && rescan.session.id === s7.id);
  check("merge recorded", (await su("select count(*)::int n from public.table_merges where primary_session_id = $1 and merged_session_id = $2", [s7.id, s9.id])).rows[0].n === 1);
  await expectError("can't merge a closed session",
    () => as(host, "select public.merge_sessions($1, $2)", [s7.id, s9.id]), "session_closed");

  await as(manager, "select * from public.close_table_session($1, 'test')", [s7.id]);
  check("closing the party releases every table", (await tstatus(t8.id)) === "cleaning" && (await tstatus(t9.id)) === "cleaning");
  check("open service requests are cancelled on close",
    (await su("select count(*)::int n from public.customer_service_requests where session_id = $1 and status in ('open','accepted')", [s7.id])).rows[0].n === 0);

  // --- Reservations ---------------------------------------------------------
  const t10 = await tbl("10");
  const reserve = (uid, table, minsFromNow, guests = 4, duration = 90) =>
    as(uid, `insert into public.reservations (restaurant_id, table_id, customer_name, contact_number, reserved_for, guest_count, duration_minutes)
             values ($1, $2, 'Dana', '+1 555 0101', now() + make_interval(mins => $3::int), $4, $5) returning id`,
      [R1, table, minsFromNow, guests, duration]).then((r) => r.rows[0].id);
  const res1 = await reserve(host, t10.id, 60);
  check("staff create a reservation", !!res1);
  check("managers told about new reservations", (await count(manager, "reservation.created")) >= 1);
  await expectError("overlapping booking for the same table is refused", () => reserve(host, t10.id, 120), "reservation_conflict");
  const res2 = await reserve(host, t10.id, 200);
  check("non-overlapping booking is fine", !!res2);
  await expectError("party too big for the table", () => reserve(host, t10.id, 400, 8), "table_too_small");
  await expectError("bookings can't be in the past", () => reserve(host, t10.id, -60), "reservation_in_past");
  await expectError("moving a booking into a clash is refused",
    () => as(host, "update public.reservations set reserved_for = now() + interval '90 minutes' where id = $1", [res2]), "reservation_conflict");
  await expectError("kitchen staff can't take bookings", () => reserve(kitchen, t10.id, 600), "row-level security");
  await as(host, "update public.reservations set status = 'cancelled' where id = $1", [res2]);
  await expectError("cancelled bookings can't be reopened",
    () => as(host, "update public.reservations set status = 'confirmed' where id = $1", [res2]), "reservation_closed");
  const res3 = await reserve(host, t10.id, 200);
  check("a cancelled slot can be booked again", !!res3);

  const t1 = await tbl("1");
  const soon = await reserve(host, t1.id, 20, 2);
  const { rows: [{ n: reminded }] } = await su("select app.remind_reservations() n");
  const { rows: [{ n: again }] } = await su("select app.remind_reservations() n");
  check("staff reminded once about an arrival within 30 minutes", reminded === 1 && again === 0);
  check("table held as reserved", (await tstatus(t1.id)) === "reserved");
  check("manager gets the reminder", (await count(manager, "reservation.soon")) === 1);
  await as(host, "update public.reservations set status = 'no_show' where id = $1", [soon]);
  check("no-show releases the held table", (await tstatus(t1.id)) === "available");

  const { rows: [s10] } = await as(host, "select * from public.open_table_session($1, 4, $2)", [t10.id, res1]);
  check("seating a reservation marks it arrived",
    (await su("select status from public.reservations where id = $1", [res1])).rows[0].status === "arrived" && s10.reservation_id === res1);
  await as(manager, "select * from public.close_table_session($1)", [s10.id]);
  check("closing the visit completes the reservation",
    (await su("select status from public.reservations where id = $1", [res1])).rows[0].status === "completed");
  await as(host, "select public.mark_table_cleaned($1)", [t10.id]);

  // --- Automatic promotions -------------------------------------------------
  await su(`insert into public.discounts (restaurant_id, name, type, value, scope) values ($1, 'Happy hour', 'percentage', 10, 'order')`, [R1]);
  await su(`insert into public.discounts (restaurant_id, name, type, value, scope, active_days)
            values ($1, 'Not today', 'percentage', 50, 'order', array[(extract(dow from now() at time zone 'UTC')::int + 1) % 7])`, [R1]);
  const { rows: [s10b] } = await as(host, "select * from public.open_table_session($1, 2)", [t10.id]);
  const ob = await orderAs(host, s10b.id, 2);
  await as(host, "select public.confirm_order($1)", [ob.order_id]);
  const { rows: [{ id: invB }] } = await as(host, "select public.generate_invoice($1) id", [s10b.id]);
  const apps = await su("select reason, amount::float a from public.discount_applications where invoice_id = $1", [invB]);
  check("automatic promotion applies itself (10% of 7.00)", apps.rows.length === 1 && apps.rows[0].reason === "Happy hour" && apps.rows[0].a === 0.7,
    JSON.stringify(apps.rows));
  await su("update public.discounts set is_active = false where name = 'Happy hour'");
  await as(host, "select public.generate_invoice($1)", [s10b.id]);
  check("expired promotion drops off the draft bill",
    (await su("select count(*)::int n from public.discount_applications where invoice_id = $1", [invB])).rows[0].n === 0);
  await su("delete from public.discounts where code is null");

  // Audit entries for child records resolve their restaurant
  const { rows: [pay] } = await su("select id from public.payments limit 1");
  await su("update public.payments set reference = 'AUDIT-CHECK' where id = $1", [pay.id]);
  const seenPay = await as(admin, "select count(*)::int n from public.audit_logs where table_name = 'payments' and record_id = $1", [pay.id]);
  check("admins can see audit entries for payments", seenPay.rows[0].n >= 1);
}

// ---------------------------------------------------------------------------
console.log("Security & performance audit (Phase 6)");
// ---------------------------------------------------------------------------
{
  const list = async (sql) => (await su(sql)).rows.map((r) => r.name);

  const noRls = await list(`select c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  check("every public table has row level security", noRls.length === 0, noRls.join(", "));

  const noPolicy = await list(`select c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               where n.nspname = 'public' and c.relkind = 'r'
                                 and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
                                 and c.relname not in ('document_counters')`);
  check("every table clients use has at least one policy", noPolicy.length === 0, noPolicy.join(", "));

  const unpinned = await list(`select n.nspname || '.' || p.proname name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname in ('public','app') and p.prosecdef
                                 and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  check("every SECURITY DEFINER function pins search_path", unpinned.length === 0, unpinned.join(", "));

  const anonExec = await list(`select n.nspname || '.' || p.proname name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname in ('public','app') and has_function_privilege('anon', p.oid, 'EXECUTE')`);
  check("anonymous (signed-out) role can't execute any function", anonExec.length === 0, anonExec.join(", "));

  const internal = await list(`select n.nspname || '.' || p.proname name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                 and ((n.nspname = 'public' and p.proname in ('get_receipt', 'custom_access_token_hook'))
                                   or (n.nspname = 'app' and p.proname in ('notify', 'cancel_items', 'recompute_invoice',
                                       'apply_refund', 'finalize_invoice', 'require_role', 'require_ticket', 'require_draft',
                                       'next_document_number', 'refresh_order_status', 'refresh_ticket_status',
                                       'refresh_invoice_status', 'alert_stale_orders', 'remind_reservations',
                                       'sync_auto_promotions', 'audit_row', 'table_waiter_user_ids', 'role_user_ids',
                                       'station_user_ids', 'expected_cash')))`);
  check("signed-in users can't call internal functions directly", internal.length === 0, internal.join(", "));

  const writable = await list(`select table_name name from information_schema.role_table_grants
                               where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT','UPDATE','DELETE')
                                 and table_name in ('orders','order_items','payments','refunds','invoices','kitchen_tickets','table_sessions')
                               group by table_name`);
  // Grants exist (Supabase defaults) but RLS has no write policy: prove it by trying.
  const tryWrite = await as(admin, "update public.payments set amount = 1 returning id");
  check("no client can write payments, even an admin", tryWrite.rows.length === 0, writable.join(","));

  const fkNoIndex = await list(`
    select c.conrelid::regclass || '(' || a.attname || ')' name
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and array_length(c.conkey, 1) = 1
       and c.connamespace = 'public'::regnamespace
       and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
     order by 1`);
  check("every foreign key is indexed", fkNoIndex.length === 0, `\n      missing: ${fkNoIndex.join(", ")}`);

  // Rough timing (NFR-001). PGlite runs in WebAssembly, so a real Postgres is faster.
  const t = (await su("select id, qr_token from public.restaurant_tables where restaurant_id = $1 and table_number = '2'", [R1])).rows[0];
  await su("update public.restaurant_tables set status = 'available' where id = $1", [t.id]);
  const { rows: [s] } = await as(manager, "select * from public.open_table_session($1)", [t.id]);
  const runs = 50;
  let submitMs = 0;
  let confirmMs = 0;
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    const o = (await as(manager, "select public.submit_order($1, $2::jsonb, gen_random_uuid()) r",
      [s.id, JSON.stringify([{ menu_item_id: "44444444-0000-0000-0000-000000000004", quantity: 1 },
                             { menu_item_id: "44444444-0000-0000-0000-000000000002", quantity: 2 }])])).rows[0].r;
    const b = performance.now();
    await as(manager, "select public.confirm_order($1)", [o.order_id]);
    confirmMs += performance.now() - b;
    submitMs += b - a;
  }
  const { rows: [{ id: invId }] } = await as(manager, "select public.generate_invoice($1) id", [s.id]);
  const c = performance.now();
  await as(manager, "select public.generate_invoice($1)", [s.id]);
  const billMs = performance.now() - c;
  console.log(`       avg submit ${(submitMs / runs).toFixed(1)} ms · confirm ${(confirmMs / runs).toFixed(1)} ms · bill of ${runs * 2} lines ${billMs.toFixed(1)} ms`);
  check("orders submit and confirm well under the 2 s target", submitMs / runs < 500 && confirmMs / runs < 500);
  check("a 100-line bill recomputes well under the 2 s target", billMs < 2000 && !!invId);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

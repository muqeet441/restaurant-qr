# TableQR: QR restaurant management

A QR-ordering and restaurant-operations system built with **Next.js on Vercel** and
**Supabase** (Postgres, Auth, Realtime). Both can run on their free tiers.

This repository holds all six phases of the PRD roadmap: **Foundation**, **Customer
Ordering**, **Waiter & Kitchen**, **Billing & POS**, **Additional Operations**, and
**Testing & Deployment**.

**Going live?** Follow [docs/DEPLOY.md](docs/DEPLOY.md). Then test with
[docs/UAT.md](docs/UAT.md) and train staff with [docs/STAFF-GUIDE.md](docs/STAFF-GUIDE.md).

| Area | Status |
|---|---|
| Full database schema (every PRD entity), RLS on every table | ✅ |
| Auth: staff email/password, anonymous customers, role claims in the JWT | ✅ |
| Roles & permissions catalogue, audit log, status history | ✅ |
| Restaurant configuration, taxes, service charges, operating rules | ✅ |
| Employee management: create, roles, kitchen stations, password reset, deactivate | ✅ |
| Tables: create, edit, deactivate, waiter assignment | ✅ |
| QR codes: generate, regenerate (old code stops working), print sheet | ✅ |
| Table sessions: seat guests, close (with unpaid-balance rule), cleaning → available | ✅ |
| Live floor view (Supabase Realtime) | ✅ |
| Customer QR landing: validates the code and joins the session | ✅ |
| Menu management: categories (order, photos, hide), items (price, photo, station, tax, allergens, availability) | ✅ Phase 2 |
| Customizations: options with price changes, extra groups with min/max rules | ✅ Phase 2 |
| Kitchen stations, item routing | ✅ Phase 2 |
| Customer menu, item customization, cart with estimated tax and service charge | ✅ Phase 2 |
| Order submission: server-side prices, snapshots, duplicate protection, waiter notification | ✅ Phase 2 |
| Live order tracking for customers; cancel before confirmation; staff order list | ✅ Phase 2 |
| Waiter dashboard: my tables / all, confirm, reject with reason, ask the customer a question | ✅ Phase 3 |
| Kitchen display: one ticket per station, accept, start, per-item and whole-ticket ready | ✅ Phase 3 |
| Serving: individual items or whole order (only when ready) | ✅ Phase 3 |
| Cancellations: direct before cooking starts, manager approval after | ✅ Phase 3 |
| Kitchen reports out-of-stock (item comes off the menu) and messages the waiter | ✅ Phase 3 |
| Live notifications with sound; manager alert for orders waiting too long (pg_cron) | ✅ Phase 3 |
| Invoices: consolidated per table, tax per item (inclusive or added), service charges | ✅ Phase 4 |
| Discounts: manual % or amount with manager limit; coupon codes (order, item, category, BOGO, time rules) | ✅ Phase 4 |
| Payments: cash with change, card, transfer, wallet; split equally, by items or custom; partial; declined attempts | ✅ Phase 4 |
| Refunds with manager approval; void invoice to reopen a table | ✅ Phase 4 |
| Printed 80 mm receipt and digital receipt link (QR on the receipt) | ✅ Phase 4 |
| Cash register: open with float, expected vs counted on close, manager sign-off | ✅ Phase 4 |
| Customer: request the bill, see it, open the receipt | ✅ Phase 4 |
| Customer help requests (waiter, water, assistance, problem) with live status; waiter handling | ✅ Phase 5 |
| Customer feedback (stars + comment) and admin feedback list | ✅ Phase 5 |
| Reservations: by day, table assignment, double-booking and capacity checks, confirm / seat / no-show / cancel | ✅ Phase 5 |
| Reservation reminders 30 min ahead (table held as Reserved) via pg_cron | ✅ Phase 5 |
| Move a party to another table; merge tables onto one bill (merged QR joins the party) | ✅ Phase 5 |
| Promotions admin: coupons and automatic promotions (days, hours, dates, minimums, use limits) | ✅ Phase 5 |
| Audit log viewer with filters and field-level changes | ✅ Phase 5 |
| Security audit tests: RLS on every table, pinned search_path, no anon/internal function access | ✅ Phase 6 |
| Every foreign key indexed; timing checks for orders and bills | ✅ Phase 6 |
| Security headers (CSP, HSTS, frame-deny), no-store on table/receipt links, installable PWA | ✅ Phase 6 |
| Live end-to-end check against the real project (`npm run e2e:live`) | ✅ Phase 6 |
| GitHub Actions: CI, production migrations, nightly encrypted backups | ✅ Phase 6 |
| Go-live runbook, UAT checklist, staff guide | ✅ Phase 6 |

The schema for later phases already exists, so later phases add functions and screens,
not tables.

---

## Setup

### 1. Create a Supabase project
1. Create a free project at [supabase.com](https://supabase.com).
2. **Authentication → Sign In / Providers**: turn on **Allow anonymous sign-ins**.
   Customers get an anonymous user when they scan a QR code.
3. **Authentication → Hooks**: add a **Customize Access Token (JWT) Claims** hook of type
   *Postgres function* → `public.custom_access_token_hook`. (Create it after step 2 below,
   once the function exists.)
4. **Database → Extensions**: enable **pg_cron** *before* pushing migrations. It runs
   the once-a-minute "order waiting too long" alert for managers. Without it,
   everything else still works.
5. Recommended: **Authentication → Attack Protection**: enable CAPTCHA so the anonymous
   sign-in endpoint can't be abused.

### 2. Apply the database migrations
```bash
npm install
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db push --include-seed     # omit --include-seed to skip the demo restaurant
```
`supabase/seed.sql` creates a demo restaurant (`demo-bistro`) with 10 tables, 4 kitchen
stations, a small menu, a tax and a service charge.

### 3. Environment variables
```bash
cp .env.example .env.local
```
Fill these in from **Project Settings → API**:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Used only to create staff logins. Never expose it. |
| `NEXT_PUBLIC_SITE_URL` | The URL printed inside QR codes, e.g. `https://your-app.vercel.app` |

### 4. Create the first administrator
```bash
# Admin of the seeded demo restaurant
npm run create-admin -- --email you@example.com --password "choose-a-password" --name "Your Name"

# …or create your own restaurant at the same time
npm run create-admin -- --email you@example.com --password "…" --name "…" --restaurant "My Restaurant"
```

### 5. Run it
```bash
npm run dev
```
Open http://localhost:3000/login, sign in, then go to **Admin → Tables & QR → Print all
QR codes**. To try the customer side, seat guests on a table under **Floor**, then open
that table's customer link (shown under *Edit, QR and status*) on your phone or in a
private window.

---

## Deploy to Vercel
1. Push this folder to a GitHub repository.
2. In Vercel, import the repo. The framework is detected as Next.js.
3. Add the four environment variables above. Set `NEXT_PUBLIC_SITE_URL` to the
   production domain.
4. Deploy. Then in Supabase **Authentication → URL Configuration**, set the Site URL
   to the same domain.

**Free-tier caveats**
- Vercel's free *Hobby* plan is for non-commercial use. For a live restaurant, use
  Vercel Pro or host on Cloudflare Pages or Netlify. No code changes are needed.
- Supabase free projects pause after 7 days without activity and have no downloadable
  backups. Schedule your own `pg_dump`, for example from a nightly GitHub Action.

---

## Development

```bash
npm test            # both suites below
npm run test:db     # runs every migration + seed in PGlite and checks RLS/RPC rules (278 checks)
npm run e2e:live    # full visit against your real Supabase project (needs both keys in .env.local)
npm run test:pricing # cart maths in src/lib/menu.ts agrees with submit_order
npm run typecheck
npm run lint
npm run build
npm run gen:types   # after `supabase link`: generate src/lib/database.types.ts
```

`test:db` needs neither Docker nor a Supabase project. It stubs Supabase's `auth`
schema and runs as different users (admin, manager, waiter, cashier, kitchen,
anonymous guest, another restaurant's admin) to check the security rules.

### Project layout
```
supabase/
  migrations/
    …01_enums_and_helpers.sql         enums, private `app` schema
    …02_schema.sql                    all tables, constraints, indexes
    …03_auth_and_rls.sql              role helpers, JWT hook, RLS policies
    …04_tables_sessions_functions.sql roles catalogue, audit/history triggers, RPCs
    …05_ordering.sql                  submit_order, cancel_pending_order, notifications, image bucket
    …06_waiter_kitchen.sql            confirm/reject, tickets, ready/serve, cancellations, stale alerts
    …07_billing.sql                   invoices, discounts, payments, refunds, registers, receipts
    …08_operations.sql                service requests, feedback, reservations, transfer/merge, auto promotions
    …09_performance.sql               indexes on every foreign key + dashboard hot paths
  seed.sql                            demo restaurant
scripts/
  test-db.mjs                         database test harness
  create-admin.mjs                    first-admin bootstrap
src/
  middleware.ts                       session refresh + role-based route guard
  lib/supabase/                       browser, server and service-role clients
  lib/staff.ts                        requireStaff(): signed-in staff + restaurant
  app/login, app/staff                sign-in and staff home
  lib/menu.ts                         menu types + cart price maths
  app/admin/…                         overview, orders, menu, extras, stations, tables & QR, employees, settings
  app/floor                           live table board
  app/waiter                          waiter dashboard
  app/kitchen                         kitchen display (KDS)
  app/pos                             POS: tables & bills, bill + payments, register, printable receipt
  app/r/[token]                       public digital receipt
  app/reservations                    reservations by day
  app/t/[token]                       customer app: menu, item sheet, cart, order tracking
```

### Billing rules
- **Bill contents:** the bill holds every confirmed, non-cancelled item at the table.
- **Totals:** subtotal − discounts + taxes added at checkout + service charges. Discounts are
  spread across the lines before tax. Taxes already included in prices are shown but not added
  again. The customer's cart estimate uses the same maths (`npm run test:pricing`).
- **Finalizing:** the first payment attempt finalizes the bill. After that, no discounts or new
  orders can be added. A manager can void a bill that has no money on it, which reopens the table.
- **Payments:** a payment can never exceed what is owed. Each one has an idempotency key, so a
  retry can't charge twice. Declined cards are recorded but never counted.
- **Cash:** taking cash requires an open register. When a cashier closes their register, the
  expected amount is opening float + cash taken − cash refunded. Any difference is sent to managers.
- **Refunds:** a cashier's refund waits for a manager. A manager's own refunds apply immediately.
- **Digital receipts** live at `/r/<token>`. The page reads them on the server with the service
  role; signed-in users cannot query receipts directly.

### How security works
- **The database enforces the rules.** Every table has Row Level Security. Roles are
  read from `user_roles`, never from client-supplied data. Deactivating an employee
  removes their access immediately and blocks their sign-in.
- **Writes to operational data go through functions.** Sessions, orders and payments
  can only be changed through `SECURITY DEFINER` functions such as
  `open_table_session`, `join_table_session` and `close_table_session`. Each one
  checks the caller's role and the current state inside one transaction. Clients
  cannot write those tables directly.
- **Customers are anonymous Supabase users.** Scanning a QR code calls
  `join_table_session(token)`. After that, RLS lets the customer read only their own
  session, table and the restaurant's active menu. Once the session closes, that
  access ends.
- **Orders are priced by the database.** `submit_order` ignores any price the
  client sends. It checks that every item, option and extra belongs to the
  restaurant and is active and available, enforces each extra group's min/max, and
  stores the result as price snapshots in one transaction. Re-sending the same
  idempotency key returns the original order. A table can have at most 5 orders
  waiting for the waiter at once.
- **Menu photos** live in the public `menu-images` Storage bucket under
  `<restaurant_id>/…`. Only that restaurant's admins can upload or delete them.
  The browser shrinks photos to 1200px WebP before upload.
- **QR tokens** are random 40-character values with no table number in them.
  Regenerating a code invalidates the printed one.
- **The service-role key is used in one place only:** creating and updating staff
  auth accounts, after the server has checked that the caller is an admin.
- `audit_logs` records changes to sensitive tables with the actor and before/after
  data. Session, order and kitchen-ticket status changes are also kept in their own
  history tables.

### Conventions for the next phases
- New business operations become `public.<verb>_<noun>(…)` functions in a new
  migration. Check permissions with `app.require_role(...)`, lock rows with
  `for update`, and raise snake_case error codes. Map those codes in
  `src/lib/errors.ts`.
- Add a test for each rule in `scripts/test-db.mjs`.
- Prices are copied onto `order_items` when an order is placed, as snapshots.
  `orders.idempotency_key` and `payments.idempotency_key` prevent duplicate
  submissions.

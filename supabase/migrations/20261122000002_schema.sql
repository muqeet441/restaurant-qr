-- =============================================================================
-- 0002  Full schema (PRD section 10)
-- Money is numeric(12,2). Prices on orders are snapshots (BR-007, BR-008).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 10.1 Restaurant and configuration
-- ---------------------------------------------------------------------------
create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  description text,
  address     text,
  phone       text,
  email       text,
  currency    char(3) not null default 'USD',
  timezone    text not null default 'UTC',
  logo_path   text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.branches (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  address       text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.restaurant_settings (
  restaurant_id                uuid primary key references public.restaurants(id) on delete cascade,
  customer_can_open_session    boolean not null default false,
  require_cleaning             boolean not null default true,
  pending_order_alert_minutes  int not null default 5 check (pending_order_alert_minutes > 0),
  manager_discount_limit_pct   numeric(5,2) not null default 10 check (manager_discount_limit_pct between 0 and 100),
  updated_at                   timestamptz not null default now()
);

create table public.tax_configurations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  rate_pct      numeric(5,2) not null check (rate_pct between 0 and 100),
  is_inclusive  boolean not null default false,
  is_default    boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index tax_one_default_per_restaurant
  on public.tax_configurations (restaurant_id) where is_default and is_active;

create table public.service_charges (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  rate_pct      numeric(5,2) check (rate_pct between 0 and 100),
  fixed_amount  numeric(12,2) check (fixed_amount >= 0),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  check (rate_pct is not null or fixed_amount is not null)
);

-- Per-restaurant, per-day document counters (order numbers, invoice numbers).
create table public.document_counters (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind          text not null,
  day           date not null,
  last_value    int not null default 0,
  primary key (restaurant_id, kind, day)
);

-- ---------------------------------------------------------------------------
-- 10.6 Users, roles, permissions, employees
-- (auth.users is managed by Supabase Auth)
-- ---------------------------------------------------------------------------
create table public.roles (
  code        public.app_role primary key,
  name        text not null,
  description text
);

create table public.permissions (
  code        text primary key,
  description text not null
);

create table public.role_permissions (
  role       public.app_role not null references public.roles(code) on delete cascade,
  permission text not null references public.permissions(code) on delete cascade,
  primary key (role, permission)
);

create table public.user_roles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  role          public.app_role not null references public.roles(code),
  created_at    timestamptz not null default now(),
  -- super_admin is global, every other role is scoped to a restaurant
  check ((role = 'super_admin') = (restaurant_id is null))
);
create unique index user_roles_unique
  on public.user_roles (user_id, coalesce(restaurant_id, '00000000-0000-0000-0000-000000000000'::uuid), role);
create index user_roles_restaurant on public.user_roles (restaurant_id);

create table public.employees (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id       uuid not null unique references auth.users(id) on delete cascade,
  full_name     text not null,
  email         text not null,
  phone         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index employees_restaurant on public.employees (restaurant_id);

create table public.login_history (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  event      text not null check (event in ('login', 'logout', 'login_failed')),
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index login_history_user on public.login_history (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 10.3 Kitchen stations (needed before menu items)
-- ---------------------------------------------------------------------------
create table public.kitchen_stations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (restaurant_id, name)
);

create table public.employee_station_assignments (
  employee_id uuid not null references public.employees(id) on delete cascade,
  station_id  uuid not null references public.kitchen_stations(id) on delete cascade,
  primary key (employee_id, station_id)
);

-- ---------------------------------------------------------------------------
-- 10.2 Tables, sessions, reservations
-- ---------------------------------------------------------------------------
create table public.restaurant_tables (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  branch_id       uuid references public.branches(id) on delete set null,
  table_number    text not null,
  name            text,
  capacity        int not null default 4 check (capacity > 0),
  location        text,
  status          public.table_status not null default 'available',
  is_active       boolean not null default true,
  qr_token        text unique,
  qr_generated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (restaurant_id, table_number)
);

create table public.reservations (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants(id) on delete cascade,
  table_id             uuid references public.restaurant_tables(id) on delete set null,
  customer_name        text not null,
  contact_number       text not null,
  reserved_for         timestamptz not null,
  duration_minutes     int not null default 90 check (duration_minutes > 0),
  guest_count          int not null check (guest_count > 0),
  special_instructions text,
  status               public.reservation_status not null default 'pending',
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index reservations_lookup on public.reservations (restaurant_id, reserved_for);

create table public.table_sessions (
  id                       uuid primary key default gen_random_uuid(),
  restaurant_id            uuid not null references public.restaurants(id) on delete cascade,
  table_id                 uuid not null references public.restaurant_tables(id),
  reservation_id           uuid references public.reservations(id) on delete set null,
  status                   public.session_status not null default 'open',
  guest_count              int check (guest_count > 0),
  opened_by                uuid references auth.users(id),
  opened_at                timestamptz not null default now(),
  closed_by                uuid references auth.users(id),
  closed_at                timestamptz,
  exceptional_close_reason text,
  check ((status = 'closed') = (closed_at is not null))
);
-- One live session per table.
create unique index table_sessions_one_live
  on public.table_sessions (table_id) where status <> 'closed';
create index table_sessions_restaurant on public.table_sessions (restaurant_id, status);

create table public.table_session_history (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.table_sessions(id) on delete cascade,
  from_status public.session_status,
  to_status   public.session_status not null,
  changed_by  uuid,
  note        text,
  created_at  timestamptz not null default now()
);

-- Anonymous customer users who scanned the table QR during a session.
create table public.session_guests (
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index session_guests_user on public.session_guests (user_id);

create table public.table_transfers (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.table_sessions(id),
  from_table_id  uuid not null references public.restaurant_tables(id),
  to_table_id    uuid not null references public.restaurant_tables(id),
  transferred_by uuid references auth.users(id),
  reason         text,
  created_at     timestamptz not null default now()
);

create table public.table_merges (
  id                 uuid primary key default gen_random_uuid(),
  primary_session_id uuid not null references public.table_sessions(id),
  merged_session_id  uuid not null references public.table_sessions(id),
  merged_by          uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  check (primary_session_id <> merged_session_id)
);

create table public.employee_table_assignments (
  id            uuid primary key default gen_random_uuid(),
  table_id      uuid not null references public.restaurant_tables(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  assigned_by   uuid references auth.users(id),
  assigned_at   timestamptz not null default now(),
  unassigned_at timestamptz
);
-- One current waiter per table.
create unique index table_assignment_one_current
  on public.employee_table_assignments (table_id) where unassigned_at is null;

-- ---------------------------------------------------------------------------
-- 10.3 Menu
-- ---------------------------------------------------------------------------
create table public.menu_categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  description   text,
  image_path    text,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.menu_items (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants(id) on delete cascade,
  category_id          uuid not null references public.menu_categories(id),
  station_id           uuid references public.kitchen_stations(id) on delete set null,
  tax_configuration_id uuid references public.tax_configurations(id) on delete set null,
  name                 text not null,
  description          text,
  base_price           numeric(12,2) not null check (base_price >= 0),
  prep_instructions    text,
  allergens            text[] not null default '{}',
  dietary_tags         text[] not null default '{}',
  is_available         boolean not null default true,
  is_active            boolean not null default true,
  sort_order           int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index menu_items_category on public.menu_items (category_id, sort_order);

create table public.menu_item_images (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.menu_items(id) on delete cascade,
  path       text not null,
  sort_order int not null default 0
);

-- Mutually exclusive variants (size etc.).
create table public.item_variations (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.menu_items(id) on delete cascade,
  name        text not null,
  price_delta numeric(12,2) not null default 0,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  sort_order  int not null default 0
);

-- Add-on groups carry the min/max selection rules (FR-131, FR-132).
create table public.add_on_groups (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  min_select    int not null default 0 check (min_select >= 0),
  max_select    int check (max_select is null or max_select >= 1),
  created_at    timestamptz not null default now(),
  check (max_select is null or max_select >= min_select)
);

create table public.add_ons (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.add_on_groups(id) on delete cascade,
  name       text not null,
  price      numeric(12,2) not null default 0 check (price >= 0),
  is_active  boolean not null default true,
  sort_order int not null default 0
);

create table public.item_add_on_groups (
  item_id    uuid not null references public.menu_items(id) on delete cascade,
  group_id   uuid not null references public.add_on_groups(id) on delete cascade,
  sort_order int not null default 0,
  primary key (item_id, group_id)
);

-- ---------------------------------------------------------------------------
-- 10.4 Ordering
-- ---------------------------------------------------------------------------
create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id),
  session_id       uuid not null references public.table_sessions(id),
  table_id         uuid not null references public.restaurant_tables(id),
  order_number     text not null,
  status           public.order_status not null default 'pending_confirmation',
  idempotency_key  uuid not null,
  customer_user_id uuid references auth.users(id),
  customer_note    text,
  subtotal         numeric(12,2) not null default 0,
  confirmed_by     uuid references auth.users(id),
  confirmed_at     timestamptz,
  rejected_by      uuid references auth.users(id),
  rejected_at      timestamptz,
  rejection_reason text,
  served_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (restaurant_id, order_number),
  unique (session_id, idempotency_key),
  check (status <> 'rejected' or rejection_reason is not null)
);
create index orders_session on public.orders (session_id);
create index orders_status on public.orders (restaurant_id, status, created_at);

create table public.order_items (
  id                      uuid primary key default gen_random_uuid(),
  order_id                uuid not null references public.orders(id) on delete cascade,
  menu_item_id            uuid not null references public.menu_items(id),
  variation_id            uuid references public.item_variations(id),
  station_id              uuid references public.kitchen_stations(id),
  item_name_snapshot      text not null,
  variation_name_snapshot text,
  unit_price_snapshot     numeric(12,2) not null check (unit_price_snapshot >= 0),
  quantity                int not null check (quantity > 0),
  line_total              numeric(12,2) not null check (line_total >= 0),
  special_instructions    text,
  status                  public.order_item_status not null default 'pending',
  served_by               uuid references auth.users(id),
  served_at               timestamptz,
  cancelled_reason        text
);
create index order_items_order on public.order_items (order_id);

create table public.order_item_add_ons (
  id             uuid primary key default gen_random_uuid(),
  order_item_id  uuid not null references public.order_items(id) on delete cascade,
  add_on_id      uuid references public.add_ons(id) on delete set null,
  name_snapshot  text not null,
  price_snapshot numeric(12,2) not null check (price_snapshot >= 0),
  quantity       int not null default 1 check (quantity > 0)
);

create table public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status public.order_status,
  to_status   public.order_status not null,
  changed_by  uuid,
  reason      text,
  created_at  timestamptz not null default now()
);

create table public.order_cancellation_requests (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete cascade,
  requested_by  uuid references auth.users(id),
  reason        text not null,
  status        public.approval_status not null default 'pending',
  reviewed_by   uuid references auth.users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10.5 Kitchen
-- ---------------------------------------------------------------------------
create table public.kitchen_tickets (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  order_id      uuid not null references public.orders(id) on delete cascade,
  station_id    uuid references public.kitchen_stations(id),
  status        public.ticket_status not null default 'new',
  accepted_by   uuid references auth.users(id),
  accepted_at   timestamptz,
  started_at    timestamptz,
  ready_at      timestamptz,
  created_at    timestamptz not null default now(),
  unique (order_id, station_id)
);
create index kitchen_tickets_station on public.kitchen_tickets (station_id, status);

create table public.kitchen_ticket_items (
  id            uuid primary key default gen_random_uuid(),
  ticket_id     uuid not null references public.kitchen_tickets(id) on delete cascade,
  order_item_id uuid not null unique references public.order_items(id) on delete cascade,
  status        public.order_item_status not null default 'confirmed',
  ready_at      timestamptz
);

create table public.kitchen_ticket_status_history (
  id          bigint generated always as identity primary key,
  ticket_id   uuid not null references public.kitchen_tickets(id) on delete cascade,
  from_status public.ticket_status,
  to_status   public.ticket_status not null,
  changed_by  uuid,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10.7 Billing and payments
-- ---------------------------------------------------------------------------
create table public.discounts (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants(id) on delete cascade,
  name               text not null,
  code               text,
  type               public.discount_type not null,
  value              numeric(12,2) not null check (value >= 0),
  scope              public.discount_scope not null default 'order',
  target_item_id     uuid references public.menu_items(id) on delete cascade,
  target_category_id uuid references public.menu_categories(id) on delete cascade,
  min_order_amount   numeric(12,2),
  starts_at          timestamptz,
  ends_at            timestamptz,
  active_days        int[],          -- 0 = Sunday … 6 = Saturday
  start_time         time,
  end_time           time,
  max_uses           int,
  used_count         int not null default 0,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  check (type <> 'percentage' or value <= 100)
);
create unique index discounts_code
  on public.discounts (restaurant_id, upper(code)) where code is not null;

create table public.invoices (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants(id),
  session_id           uuid not null references public.table_sessions(id),
  invoice_number       text not null,
  status               public.invoice_status not null default 'unpaid',
  subtotal             numeric(12,2) not null default 0,
  discount_total       numeric(12,2) not null default 0,
  tax_total            numeric(12,2) not null default 0,
  service_charge_total numeric(12,2) not null default 0,
  total                numeric(12,2) not null default 0,
  amount_paid          numeric(12,2) not null default 0,
  amount_refunded      numeric(12,2) not null default 0,
  finalized_by         uuid references auth.users(id),
  finalized_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (restaurant_id, invoice_number)
);
-- One live billing context per session (BR-011).
create unique index invoices_one_per_session
  on public.invoices (session_id) where status <> 'void';

create table public.invoice_items (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  order_item_id uuid references public.order_items(id),
  description   text not null,
  quantity      int not null check (quantity > 0),
  unit_price    numeric(12,2) not null,
  line_total    numeric(12,2) not null
);

create table public.cash_registers (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  is_active     boolean not null default true
);

create table public.cash_register_sessions (
  id              uuid primary key default gen_random_uuid(),
  register_id     uuid not null references public.cash_registers(id),
  opened_by       uuid not null references auth.users(id),
  opening_balance numeric(12,2) not null check (opening_balance >= 0),
  opened_at       timestamptz not null default now(),
  closed_by       uuid references auth.users(id),
  closed_at       timestamptz,
  counted_cash    numeric(12,2),
  expected_cash   numeric(12,2),
  discrepancy     numeric(12,2),
  reviewed_by     uuid references auth.users(id),
  notes           text
);
create unique index register_one_open
  on public.cash_register_sessions (register_id) where closed_at is null;

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references public.invoices(id),
  amount              numeric(12,2) not null check (amount > 0),
  method              public.payment_method not null,
  status              public.payment_txn_status not null default 'pending',
  reference           text,
  idempotency_key     uuid not null unique,
  received_by         uuid references auth.users(id),
  register_session_id uuid references public.cash_register_sessions(id),
  created_at          timestamptz not null default now()
);
create index payments_invoice on public.payments (invoice_id);

create table public.payment_transactions (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid references public.payments(id),
  gateway           text not null,
  gateway_reference text not null,
  event             text not null,
  status            public.payment_txn_status not null,
  payload           jsonb,
  created_at        timestamptz not null default now(),
  unique (gateway, gateway_reference, event)
);

create table public.refunds (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references public.payments(id),
  invoice_id   uuid not null references public.invoices(id),
  amount       numeric(12,2) not null check (amount > 0),
  reason       text not null,
  status       public.approval_status not null default 'pending',
  requested_by uuid references auth.users(id),
  approved_by  uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create table public.discount_applications (
  id          uuid primary key default gen_random_uuid(),
  discount_id uuid references public.discounts(id),
  invoice_id  uuid references public.invoices(id) on delete cascade,
  order_id    uuid references public.orders(id) on delete cascade,
  amount      numeric(12,2) not null check (amount >= 0),
  reason      text,
  applied_by  uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  check (invoice_id is not null or order_id is not null)
);

-- ---------------------------------------------------------------------------
-- 10.8 Customer service and notifications
-- ---------------------------------------------------------------------------
create table public.customer_service_requests (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants(id),
  session_id        uuid not null references public.table_sessions(id),
  table_id          uuid not null references public.restaurant_tables(id),
  type              public.service_request_type not null,
  status            public.service_request_status not null default 'open',
  note              text,
  requested_by_user uuid references auth.users(id),
  accepted_by       uuid references auth.users(id),
  accepted_at       timestamptz,
  completed_by      uuid references auth.users(id),
  completed_at      timestamptz,
  created_at        timestamptz not null default now()
);
-- Duplicate requests collapse onto the open one (FR-090).
create unique index service_requests_no_dupes
  on public.customer_service_requests (session_id, type) where status in ('open', 'accepted');

create table public.customer_feedback (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.table_sessions(id),
  user_id    uuid references auth.users(id),
  rating     int not null check (rating between 1 and 5),
  comment    text,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  type          text not null,
  title         text not null,
  body          text,
  payload       jsonb not null default '{}',
  order_id      uuid references public.orders(id) on delete cascade,
  session_id    uuid references public.table_sessions(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create table public.notification_recipients (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  read_at         timestamptz,
  primary key (notification_id, user_id)
);
create index notification_recipients_unread
  on public.notification_recipients (user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- 10.9 System administration
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id            bigint generated always as identity primary key,
  restaurant_id uuid,
  actor_id      uuid,
  table_name    text not null,
  record_id     text,
  action        text not null,
  old_data      jsonb,
  new_data      jsonb,
  created_at    timestamptz not null default now()
);
create index audit_logs_lookup on public.audit_logs (restaurant_id, created_at desc);

create table public.system_configurations (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'restaurants', 'restaurant_settings', 'employees', 'restaurant_tables',
    'reservations', 'menu_categories', 'menu_items', 'orders', 'invoices'
  ] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

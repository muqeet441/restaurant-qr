-- =============================================================================
-- 0001  Enums, private helper schema, generic triggers
-- =============================================================================

create schema if not exists app;
comment on schema app is 'Private helpers used by RLS policies and RPC functions. Not exposed through the API.';

-- ---------------------------------------------------------------------------
-- Enums (PRD section 5)
-- ---------------------------------------------------------------------------
create type public.app_role as enum (
  'super_admin', 'admin', 'manager', 'waiter', 'kitchen', 'cashier'
);

create type public.table_status as enum (
  'available', 'reserved', 'occupied', 'ordering', 'billing', 'cleaning'
);

create type public.session_status as enum (
  'open', 'active', 'billing', 'payment_pending', 'closed'
);

create type public.order_status as enum (
  'pending_confirmation', 'confirmed', 'sent_to_kitchen', 'preparing',
  'partially_ready', 'ready', 'partially_served', 'served', 'completed',
  'rejected', 'cancelled', 'on_hold'
);

create type public.order_item_status as enum (
  'pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled'
);

create type public.ticket_status as enum (
  'new', 'accepted', 'preparing', 'partially_ready', 'ready', 'cancelled'
);

create type public.invoice_status as enum (
  'unpaid', 'partially_paid', 'paid', 'payment_failed',
  'refund_pending', 'partially_refunded', 'refunded', 'void'
);

create type public.payment_txn_status as enum ('pending', 'succeeded', 'failed');

create type public.payment_method as enum (
  'cash', 'card', 'bank_transfer', 'digital_wallet', 'online_gateway'
);

create type public.reservation_status as enum (
  'pending', 'confirmed', 'arrived', 'completed', 'cancelled', 'no_show'
);

create type public.service_request_type as enum (
  'call_waiter', 'water', 'bill', 'assistance', 'problem'
);

create type public.service_request_status as enum (
  'open', 'accepted', 'completed', 'cancelled'
);

create type public.approval_status as enum ('pending', 'approved', 'denied');

create type public.discount_type as enum ('percentage', 'fixed_amount', 'bogo');

create type public.discount_scope as enum ('order', 'item', 'category');

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Random, URL-safe, unguessable token (~150 bits of entropy).
create or replace function app.random_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 40);
$$;

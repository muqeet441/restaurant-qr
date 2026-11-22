-- =============================================================================
-- 0004  Reference data, audit + history triggers, table / QR / session RPCs
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles & permissions catalogue (PRD section 3)
-- ---------------------------------------------------------------------------
insert into public.roles (code, name, description) values
  ('super_admin', 'Super Administrator',      'Overall system configuration'),
  ('admin',       'Restaurant Administrator', 'Manages restaurant configuration and staff'),
  ('manager',     'Restaurant Manager',       'Daily operations, approvals, assignments'),
  ('waiter',      'Waiter',                   'Customer service and order handling'),
  ('kitchen',     'Kitchen Staff',            'Food preparation'),
  ('cashier',     'Cashier',                  'Billing and payments');

insert into public.permissions (code, description) values
  ('restaurant.configure',  'Edit restaurant configuration, taxes and charges'),
  ('menu.manage',           'Manage categories, items, variations and add-ons'),
  ('tables.manage',         'Create, edit and deactivate tables and QR codes'),
  ('tables.assign',         'Assign waiters to tables'),
  ('sessions.open',         'Open table sessions'),
  ('sessions.close',        'Close paid table sessions'),
  ('sessions.force_close',  'Close sessions with an outstanding balance'),
  ('sessions.transfer',     'Transfer and merge table sessions'),
  ('employees.manage',      'Create and manage employee accounts and roles'),
  ('stations.manage',       'Manage kitchen stations'),
  ('reservations.manage',   'Create, update and cancel reservations'),
  ('promotions.manage',     'Manage promotions and discounts'),
  ('orders.view_all',       'Monitor all active orders'),
  ('orders.confirm',        'Confirm or reject customer orders'),
  ('orders.serve',          'Mark items and orders as served'),
  ('orders.cancel_approve', 'Approve cancellations after preparation started'),
  ('kitchen.tickets',       'Accept and prepare kitchen tickets'),
  ('billing.invoice',       'Generate invoices and split bills'),
  ('billing.payment',       'Record payments'),
  ('billing.discount',      'Apply discounts within the configured limit'),
  ('billing.discount_high', 'Approve discounts above the configured limit'),
  ('billing.refund',        'Process authorized refunds'),
  ('billing.refund_approve','Approve refunds and void transactions'),
  ('register.operate',      'Open and close cash register sessions'),
  ('register.review',       'Review cash register discrepancies'),
  ('service.handle',        'Accept and complete customer service requests'),
  ('audit.view',            'View audit logs');

insert into public.role_permissions (role, permission)
select 'admin'::public.app_role, code from public.permissions
union all
select 'manager'::public.app_role, unnest(array[
  'tables.assign','sessions.open','sessions.close','sessions.force_close','sessions.transfer',
  'reservations.manage','orders.view_all','orders.confirm','orders.serve','orders.cancel_approve',
  'billing.discount','billing.discount_high','billing.refund','billing.refund_approve',
  'register.review','service.handle','audit.view'])
union all
select 'waiter'::public.app_role, unnest(array[
  'sessions.open','orders.confirm','orders.serve','service.handle','reservations.manage'])
union all
select 'kitchen'::public.app_role, unnest(array['kitchen.tickets'])
union all
select 'cashier'::public.app_role, unnest(array[
  'sessions.open','sessions.close','billing.invoice','billing.payment','billing.discount',
  'billing.refund','register.operate','reservations.manage']);

-- ---------------------------------------------------------------------------
-- Audit trigger (NFR-012)
-- ---------------------------------------------------------------------------
create or replace function app.audit_row()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
begin
  if tg_op = 'UPDATE' and v_new = v_old then
    return new;
  end if;
  insert into public.audit_logs (restaurant_id, actor_id, table_name, record_id, action, old_data, new_data)
  values (
    nullif(coalesce(v_row ->> 'restaurant_id', ''), '')::uuid,
    auth.uid(),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'restaurant_id'),
    lower(tg_op),
    v_old,
    v_new
  );
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'restaurants', 'restaurant_settings', 'tax_configurations', 'service_charges',
    'user_roles', 'employees', 'restaurant_tables', 'table_sessions', 'menu_items',
    'discounts', 'invoices', 'payments', 'refunds', 'discount_applications',
    'cash_register_sessions', 'order_cancellation_requests'
  ] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I
         for each row execute function app.audit_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Status history triggers (BR-022)
-- ---------------------------------------------------------------------------
create or replace function app.log_session_status()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.table_session_history (session_id, from_status, to_status, changed_by, note)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(),
            case when new.status = 'closed' then new.exceptional_close_reason end);
  end if;
  return new;
end;
$$;
create trigger log_status after insert or update of status on public.table_sessions
  for each row execute function app.log_session_status();

create or replace function app.log_order_status()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(),
            case when new.status = 'rejected' then new.rejection_reason end);
  end if;
  return new;
end;
$$;
create trigger log_status after insert or update of status on public.orders
  for each row execute function app.log_order_status();

create or replace function app.log_ticket_status()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.kitchen_ticket_status_history (ticket_id, from_status, to_status, changed_by)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid());
  end if;
  return new;
end;
$$;
create trigger log_status after insert or update of status on public.kitchen_tickets
  for each row execute function app.log_ticket_status();

-- ---------------------------------------------------------------------------
-- Restaurant bootstrap: every restaurant gets a settings row.
-- ---------------------------------------------------------------------------
create or replace function app.create_restaurant_settings()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.restaurant_settings (restaurant_id) values (new.id)
  on conflict do nothing;
  return new;
end;
$$;
create trigger create_settings after insert on public.restaurants
  for each row execute function app.create_restaurant_settings();

-- ---------------------------------------------------------------------------
-- Table guards: QR token on insert, no deactivation with a live session.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_tables_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.qr_token := app.random_token();
    new.qr_generated_at := now();
    new.status := 'available';
  elsif old.is_active and not new.is_active and exists (
    select 1 from public.table_sessions s where s.table_id = new.id and s.status <> 'closed'
  ) then
    raise exception 'table_has_live_session'
      using errcode = 'P0001', hint = 'Close or transfer the session before deactivating the table.';
  end if;
  return new;
end;
$$;
create trigger guard before insert or update on public.restaurant_tables
  for each row execute function app.restaurant_tables_guard();

-- ---------------------------------------------------------------------------
-- Document numbers: ORD-261122-0001, INV-261122-0001 (BR-005, FR-096)
-- ---------------------------------------------------------------------------
create or replace function app.next_document_number(p_restaurant uuid, p_kind text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_day date;
  v_n   int;
begin
  select (now() at time zone r.timezone)::date into v_day
  from public.restaurants r where r.id = p_restaurant;

  insert into public.document_counters as c (restaurant_id, kind, day, last_value)
  values (p_restaurant, p_kind, v_day, 1)
  on conflict (restaurant_id, kind, day)
    do update set last_value = c.last_value + 1
  returning last_value into v_n;

  return upper(p_kind) || '-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal: raise unless the caller has one of the roles.
-- ---------------------------------------------------------------------------
create or replace function app.require_role(p_restaurant uuid, p_roles public.app_role[])
returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not app.has_role(p_restaurant, p_roles) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- =============================================================================
-- Public RPCs
-- =============================================================================

-- FR-006: new QR token; the old printed code stops working immediately.
create or replace function public.regenerate_table_qr(p_table_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_restaurant uuid;
  v_token text := app.random_token();
begin
  select restaurant_id into v_restaurant from public.restaurant_tables where id = p_table_id;
  if v_restaurant is null then
    raise exception 'table_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_restaurant, array['admin']::public.app_role[]);

  update public.restaurant_tables
     set qr_token = v_token, qr_generated_at = now()
   where id = p_table_id;
  return v_token;
end;
$$;

-- FR-080: staff seat customers and open a session.
create or replace function public.open_table_session(
  p_table_id       uuid,
  p_guest_count    int  default null,
  p_reservation_id uuid default null
)
returns public.table_sessions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table   public.restaurant_tables;
  v_session public.table_sessions;
begin
  select * into v_table from public.restaurant_tables where id = p_table_id for update;
  if not found then
    raise exception 'table_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_table.restaurant_id,
    array['admin','manager','waiter','cashier']::public.app_role[]);

  if not v_table.is_active then
    raise exception 'table_inactive' using errcode = 'P0001';
  end if;
  if v_table.status not in ('available', 'reserved') then
    raise exception 'table_not_available'
      using errcode = 'P0001', detail = 'Table status is ' || v_table.status;
  end if;

  if p_reservation_id is not null then
    update public.reservations
       set status = 'arrived', table_id = p_table_id
     where id = p_reservation_id
       and restaurant_id = v_table.restaurant_id
       and status in ('pending', 'confirmed');
    if not found then
      raise exception 'reservation_not_found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.table_sessions (restaurant_id, table_id, reservation_id, guest_count, opened_by)
  values (v_table.restaurant_id, p_table_id, p_reservation_id, p_guest_count, auth.uid())
  returning * into v_session;

  update public.restaurant_tables set status = 'occupied' where id = p_table_id;
  return v_session;
end;
$$;

-- FR-002..005, FR-007: customer (anonymous auth user) scans a QR code.
-- Returns restaurant + table info and, when a live session exists, joins it.
create or replace function public.join_table_session(p_qr_token text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_table      public.restaurant_tables;
  v_restaurant public.restaurants;
  v_settings   public.restaurant_settings;
  v_session    public.table_sessions;
  v_info       jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select t.* into v_table
  from public.restaurant_tables t
  where t.qr_token = p_qr_token and t.is_active
  for update;
  if not found then
    raise exception 'invalid_qr' using errcode = 'P0002';
  end if;

  select * into v_restaurant from public.restaurants where id = v_table.restaurant_id and is_active;
  if not found then
    raise exception 'invalid_qr' using errcode = 'P0002';
  end if;
  select * into v_settings from public.restaurant_settings where restaurant_id = v_restaurant.id;

  v_info := jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id, 'name', v_restaurant.name, 'slug', v_restaurant.slug,
      'description', v_restaurant.description, 'address', v_restaurant.address,
      'phone', v_restaurant.phone, 'currency', v_restaurant.currency,
      'logo_path', v_restaurant.logo_path),
    'table', jsonb_build_object(
      'id', v_table.id, 'table_number', v_table.table_number, 'name', v_table.name));

  select * into v_session
  from public.table_sessions
  where table_id = v_table.id and status <> 'closed';

  if not found then
    if coalesce(v_settings.customer_can_open_session, false) and v_table.status = 'available' then
      insert into public.table_sessions (restaurant_id, table_id, opened_by)
      values (v_table.restaurant_id, v_table.id, v_uid)
      returning * into v_session;
      update public.restaurant_tables set status = 'occupied' where id = v_table.id;
    else
      return v_info || jsonb_build_object('status', 'waiting_for_staff');
    end if;
  end if;

  insert into public.session_guests (session_id, user_id)
  values (v_session.id, v_uid)
  on conflict do nothing;

  return v_info || jsonb_build_object(
    'status', 'joined',
    'session', jsonb_build_object(
      'id', v_session.id, 'status', v_session.status, 'opened_at', v_session.opened_at));
end;
$$;

-- FR-084, BR-020: close a session. Outstanding balance requires a manager
-- (or admin) and a recorded reason.
create or replace function public.close_table_session(
  p_session_id       uuid,
  p_exception_reason text default null
)
returns public.table_sessions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_session     public.table_sessions;
  v_settings    public.restaurant_settings;
  v_invoice     public.invoices;
  v_outstanding boolean;
  v_reason      text := nullif(trim(p_exception_reason), '');
begin
  select * into v_session from public.table_sessions where id = p_session_id for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_session.restaurant_id,
    array['admin','manager','cashier']::public.app_role[]);
  if v_session.status = 'closed' then
    raise exception 'session_already_closed' using errcode = 'P0001';
  end if;

  select * into v_invoice from public.invoices
  where session_id = p_session_id and status <> 'void';

  v_outstanding := exists (
      select 1 from public.orders
      where session_id = p_session_id
        and status not in ('pending_confirmation', 'rejected', 'cancelled'))
    and (v_invoice.id is null
         or v_invoice.status not in ('paid', 'partially_refunded', 'refunded'));

  if v_outstanding then
    if v_reason is null then
      raise exception 'outstanding_balance'
        using errcode = 'P0001', hint = 'Collect payment, or a manager can close with a reason.';
    end if;
    perform app.require_role(v_session.restaurant_id, array['admin','manager']::public.app_role[]);
  end if;

  -- Orders nobody confirmed die with the session.
  update public.orders
     set status = 'cancelled', rejection_reason = coalesce(rejection_reason, 'Session closed')
   where session_id = p_session_id and status = 'pending_confirmation';

  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(),
         exceptional_close_reason = case when v_outstanding then v_reason end
   where id = p_session_id
  returning * into v_session;

  select * into v_settings from public.restaurant_settings where restaurant_id = v_session.restaurant_id;
  update public.restaurant_tables
     set status = case when coalesce(v_settings.require_cleaning, true)
                       then 'cleaning'::public.table_status
                       else 'available'::public.table_status end
   where id = v_session.table_id;

  return v_session;
end;
$$;

-- FR-079: table is available only after cleaning.
create or replace function public.mark_table_cleaned(p_table_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table public.restaurant_tables;
begin
  select * into v_table from public.restaurant_tables where id = p_table_id for update;
  if not found then
    raise exception 'table_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_table.restaurant_id,
    array['admin','manager','waiter','cashier']::public.app_role[]);
  if v_table.status <> 'cleaning' then
    raise exception 'table_not_cleaning' using errcode = 'P0001';
  end if;
  update public.restaurant_tables set status = 'available' where id = p_table_id;
end;
$$;

-- Manager override for idle tables (e.g. hold a table as Reserved).
create or replace function public.set_table_status(p_table_id uuid, p_status public.table_status)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table public.restaurant_tables;
begin
  select * into v_table from public.restaurant_tables where id = p_table_id for update;
  if not found then
    raise exception 'table_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_table.restaurant_id, array['admin','manager']::public.app_role[]);
  if p_status not in ('available', 'reserved', 'cleaning') then
    raise exception 'status_requires_session' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.table_sessions where table_id = p_table_id and status <> 'closed') then
    raise exception 'table_has_live_session' using errcode = 'P0001';
  end if;
  update public.restaurant_tables set status = p_status where id = p_table_id;
end;
$$;

-- FR-039, FR-075: assign (or clear, with null) the waiter for a table.
create or replace function public.assign_table_waiter(p_table_id uuid, p_employee_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_restaurant uuid;
begin
  select restaurant_id into v_restaurant from public.restaurant_tables where id = p_table_id;
  if v_restaurant is null then
    raise exception 'table_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_restaurant, array['admin','manager']::public.app_role[]);

  if p_employee_id is not null and not exists (
    select 1 from public.employees e
    join public.user_roles ur on ur.user_id = e.user_id and ur.restaurant_id = e.restaurant_id
    where e.id = p_employee_id and e.restaurant_id = v_restaurant and e.is_active
      and ur.role in ('waiter', 'manager')
  ) then
    raise exception 'employee_not_waiter' using errcode = 'P0001';
  end if;

  update public.employee_table_assignments
     set unassigned_at = now()
   where table_id = p_table_id and unassigned_at is null;

  if p_employee_id is not null then
    insert into public.employee_table_assignments (table_id, employee_id, assigned_by)
    values (p_table_id, p_employee_id, auth.uid());
  end if;
end;
$$;

-- FR-158
create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.notification_recipients
     set read_at = coalesce(read_at, now())
   where notification_id = p_notification_id and user_id = auth.uid();
$$;

-- FR-145: record staff logins.
create or replace function public.record_login(p_ip text default null, p_user_agent text default null)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.login_history (user_id, event, ip, user_agent)
  select auth.uid(), 'login', left(p_ip, 64), left(p_user_agent, 512)
  where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: authenticated only (customers are anonymous-auth users).
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.regenerate_table_qr(uuid),
  public.open_table_session(uuid, int, uuid),
  public.join_table_session(text),
  public.close_table_session(uuid, text),
  public.mark_table_cleaned(uuid),
  public.set_table_status(uuid, public.table_status),
  public.assign_table_waiter(uuid, uuid),
  public.mark_notification_read(uuid),
  public.record_login(text, text)
to authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- Internal helpers are not callable directly.
revoke execute on function app.next_document_number(uuid, text) from authenticated, anon, public;
revoke execute on function app.audit_row() from authenticated, anon, public;

-- ---------------------------------------------------------------------------
-- Realtime: stream operational tables (RLS still filters rows per client).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.restaurant_tables, public.table_sessions, public.orders, public.order_items,
      public.kitchen_tickets, public.kitchen_ticket_items, public.customer_service_requests,
      public.notification_recipients, public.invoices;
  end if;
end $$;

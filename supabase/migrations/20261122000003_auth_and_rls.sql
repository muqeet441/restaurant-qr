-- =============================================================================
-- 0003  Authorization helpers, JWT claims hook, Row Level Security
--
-- Model:
--   * RLS reads roles from public.user_roles (authoritative, never stale).
--   * The access-token hook copies roles into the JWT so the frontend can route
--     without a database call. The JWT claims are never trusted for writes.
--   * Clients may read; operational writes (sessions, orders, payments…) are
--     only possible through SECURITY DEFINER functions. Config/CRUD tables are
--     writable directly by admins under RLS.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.is_super_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'super_admin'
  );
$$;

-- True when the current user holds any of p_roles in p_restaurant
-- (super_admin passes every check).
create or replace function app.has_role(p_restaurant uuid, p_roles public.app_role[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    left join public.employees e on e.user_id = ur.user_id
    where ur.user_id = auth.uid()
      and (
        ur.role = 'super_admin'
        or (ur.restaurant_id = p_restaurant
            and ur.role = any (p_roles)
            and coalesce(e.is_active, true))
      )
  );
$$;

create or replace function app.is_staff(p_restaurant uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select app.has_role(p_restaurant,
    array['admin','manager','waiter','kitchen','cashier']::public.app_role[]);
$$;

create or replace function app.is_admin(p_restaurant uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select app.has_role(p_restaurant, array['admin']::public.app_role[]);
$$;

-- Live sessions the current (anonymous) customer has joined.
create or replace function app.is_session_guest(p_session uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.session_guests g
    join public.table_sessions s on s.id = g.session_id
    where g.session_id = p_session
      and g.user_id = auth.uid()
      and s.status <> 'closed'
  );
$$;

-- Restaurants whose menu the current customer may read.
create or replace function app.is_restaurant_guest(p_restaurant uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.session_guests g
    join public.table_sessions s on s.id = g.session_id
    where g.user_id = auth.uid()
      and s.restaurant_id = p_restaurant
      and s.status <> 'closed'
  );
$$;

-- Kitchen staff only see tickets for their stations (FR-066).
create or replace function app.can_see_station(p_restaurant uuid, p_station uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.has_role(p_restaurant,
           array['admin','manager','waiter','cashier']::public.app_role[])
      or exists (
        select 1 from public.employee_station_assignments a
        join public.employees e on e.id = a.employee_id
        where e.user_id = auth.uid() and e.is_active and a.station_id = p_station
      );
$$;

grant usage on schema app to authenticated, anon;
grant execute on all functions in schema app to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Custom access token hook: adds { app_roles: [{role, restaurant_id}] }.
-- Enable in Dashboard → Authentication → Hooks → Customize Access Token.
-- ---------------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_roles  jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'role', ur.role, 'restaurant_id', ur.restaurant_id)), '[]'::jsonb)
    into v_roles
  from public.user_roles ur
  left join public.employees e on e.user_id = ur.user_id
  where ur.user_id = (event ->> 'user_id')::uuid
    and coalesce(e.is_active, true);

  v_claims := jsonb_set(v_claims, '{app_roles}', v_roles);
  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.user_roles, public.employees to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- The auth hook runs as supabase_auth_admin and must read roles.
create policy auth_admin_reads_roles on public.user_roles
  for select to supabase_auth_admin using (true);
create policy auth_admin_reads_employees on public.employees
  for select to supabase_auth_admin using (true);

-- ---------------------------------------------------------------------------
-- Restaurant & configuration
-- ---------------------------------------------------------------------------
create policy restaurants_read on public.restaurants for select to authenticated
  using (app.is_staff(id) or app.is_restaurant_guest(id));
create policy restaurants_admin_update on public.restaurants for update to authenticated
  using (app.is_admin(id)) with check (app.is_admin(id));
create policy restaurants_super_insert on public.restaurants for insert to authenticated
  with check (app.is_super_admin());
create policy restaurants_super_delete on public.restaurants for delete to authenticated
  using (app.is_super_admin());

-- Standard "staff read, admin write" tables keyed by restaurant_id.
do $$
declare t text;
begin
  foreach t in array array[
    'branches', 'restaurant_settings', 'tax_configurations', 'service_charges',
    'kitchen_stations', 'add_on_groups', 'discounts', 'cash_registers'
  ] loop
    execute format($f$
      create policy %1$s_staff_read on public.%1$I for select to authenticated
        using (app.is_staff(restaurant_id));
      create policy %1$s_admin_insert on public.%1$I for insert to authenticated
        with check (app.is_admin(restaurant_id));
      create policy %1$s_admin_update on public.%1$I for update to authenticated
        using (app.is_admin(restaurant_id)) with check (app.is_admin(restaurant_id));
      create policy %1$s_admin_delete on public.%1$I for delete to authenticated
        using (app.is_admin(restaurant_id));
    $f$, t);
  end loop;
end $$;

-- Customers need tax/service-charge config to see estimated totals (FR-022).
create policy tax_guest_read on public.tax_configurations for select to authenticated
  using (is_active and app.is_restaurant_guest(restaurant_id));
create policy service_charges_guest_read on public.service_charges for select to authenticated
  using (is_active and app.is_restaurant_guest(restaurant_id));
create policy add_on_groups_guest_read on public.add_on_groups for select to authenticated
  using (app.is_restaurant_guest(restaurant_id));

-- Roles & permissions catalogue: readable by any signed-in staff, managed by super admin.
create policy roles_read on public.roles for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
create policy roles_super_write on public.roles for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());
create policy permissions_super_write on public.permissions for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());
create policy role_permissions_super_write on public.role_permissions for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

-- ---------------------------------------------------------------------------
-- Users & employees
-- ---------------------------------------------------------------------------
create policy user_roles_read on public.user_roles for select to authenticated
  using (user_id = auth.uid() or app.has_role(restaurant_id, array['admin','manager']::public.app_role[]));
-- Admins manage roles inside their restaurant but can never grant super_admin.
create policy user_roles_admin_insert on public.user_roles for insert to authenticated
  with check (role <> 'super_admin' and app.is_admin(restaurant_id)
              or app.is_super_admin());
create policy user_roles_admin_delete on public.user_roles for delete to authenticated
  using (role <> 'super_admin' and app.is_admin(restaurant_id) and user_id <> auth.uid()
         or app.is_super_admin());

create policy employees_staff_read on public.employees for select to authenticated
  using (app.is_staff(restaurant_id));
create policy employees_admin_write on public.employees for update to authenticated
  using (app.is_admin(restaurant_id)) with check (app.is_admin(restaurant_id));
-- Inserts happen in the server (service role) together with auth user creation.

create policy employee_stations_read on public.employee_station_assignments for select to authenticated
  using (exists (select 1 from public.employees e where e.id = employee_id and app.is_staff(e.restaurant_id)));
create policy employee_stations_admin on public.employee_station_assignments for all to authenticated
  using (exists (select 1 from public.employees e where e.id = employee_id and app.is_admin(e.restaurant_id)))
  with check (exists (select 1 from public.employees e where e.id = employee_id and app.is_admin(e.restaurant_id)));

create policy login_history_read on public.login_history for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.employees e where e.user_id = login_history.user_id and app.is_admin(e.restaurant_id)));
create policy login_history_insert_self on public.login_history for insert to authenticated
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Tables, sessions, reservations
-- ---------------------------------------------------------------------------
create policy tables_staff_read on public.restaurant_tables for select to authenticated
  using (app.is_staff(restaurant_id));
create policy tables_guest_read on public.restaurant_tables for select to authenticated
  using (exists (select 1 from public.table_sessions s
                 where s.table_id = restaurant_tables.id and app.is_session_guest(s.id)));
create policy tables_admin_insert on public.restaurant_tables for insert to authenticated
  with check (app.is_admin(restaurant_id));
create policy tables_admin_update on public.restaurant_tables for update to authenticated
  using (app.is_admin(restaurant_id)) with check (app.is_admin(restaurant_id));
create policy tables_admin_delete on public.restaurant_tables for delete to authenticated
  using (app.is_admin(restaurant_id));

-- status and qr_token are only changed by functions.
revoke insert, update on public.restaurant_tables from authenticated, anon;
grant insert (restaurant_id, branch_id, table_number, name, capacity, location, is_active)
  on public.restaurant_tables to authenticated;
grant update (branch_id, table_number, name, capacity, location, is_active)
  on public.restaurant_tables to authenticated;

create policy sessions_staff_read on public.table_sessions for select to authenticated
  using (app.is_staff(restaurant_id));
create policy sessions_guest_read on public.table_sessions for select to authenticated
  using (app.is_session_guest(id));

create policy session_history_staff_read on public.table_session_history for select to authenticated
  using (exists (select 1 from public.table_sessions s where s.id = session_id and app.is_staff(s.restaurant_id)));

create policy session_guests_read on public.session_guests for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.table_sessions s where s.id = session_id and app.is_staff(s.restaurant_id)));

create policy transfers_staff_read on public.table_transfers for select to authenticated
  using (exists (select 1 from public.table_sessions s where s.id = session_id and app.is_staff(s.restaurant_id)));
create policy merges_staff_read on public.table_merges for select to authenticated
  using (exists (select 1 from public.table_sessions s where s.id = primary_session_id and app.is_staff(s.restaurant_id)));

create policy assignments_staff_read on public.employee_table_assignments for select to authenticated
  using (exists (select 1 from public.restaurant_tables t where t.id = table_id and app.is_staff(t.restaurant_id)));

create policy reservations_staff_read on public.reservations for select to authenticated
  using (app.is_staff(restaurant_id));
create policy reservations_staff_insert on public.reservations for insert to authenticated
  with check (app.has_role(restaurant_id, array['admin','manager','waiter','cashier']::public.app_role[]));
create policy reservations_staff_update on public.reservations for update to authenticated
  using (app.has_role(restaurant_id, array['admin','manager','waiter','cashier']::public.app_role[]))
  with check (app.has_role(restaurant_id, array['admin','manager','waiter','cashier']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Menu: staff read all, guests read active rows, admins write
-- ---------------------------------------------------------------------------
create policy categories_read on public.menu_categories for select to authenticated
  using (app.is_staff(restaurant_id) or (is_active and app.is_restaurant_guest(restaurant_id)));
create policy categories_admin on public.menu_categories for all to authenticated
  using (app.is_admin(restaurant_id)) with check (app.is_admin(restaurant_id));

create policy items_read on public.menu_items for select to authenticated
  using (app.is_staff(restaurant_id) or (is_active and app.is_restaurant_guest(restaurant_id)));
create policy items_admin on public.menu_items for all to authenticated
  using (app.is_admin(restaurant_id)) with check (app.is_admin(restaurant_id));

do $$
declare t text;
begin
  foreach t in array array['menu_item_images', 'item_variations', 'item_add_on_groups'] loop
    execute format($f$
      create policy %1$s_read on public.%1$I for select to authenticated
        using (exists (select 1 from public.menu_items i where i.id = item_id
               and (app.is_staff(i.restaurant_id) or app.is_restaurant_guest(i.restaurant_id))));
      create policy %1$s_admin on public.%1$I for all to authenticated
        using (exists (select 1 from public.menu_items i where i.id = item_id and app.is_admin(i.restaurant_id)))
        with check (exists (select 1 from public.menu_items i where i.id = item_id and app.is_admin(i.restaurant_id)));
    $f$, t);
  end loop;
end $$;

create policy add_ons_read on public.add_ons for select to authenticated
  using (exists (select 1 from public.add_on_groups g where g.id = group_id
         and (app.is_staff(g.restaurant_id) or app.is_restaurant_guest(g.restaurant_id))));
create policy add_ons_admin on public.add_ons for all to authenticated
  using (exists (select 1 from public.add_on_groups g where g.id = group_id and app.is_admin(g.restaurant_id)))
  with check (exists (select 1 from public.add_on_groups g where g.id = group_id and app.is_admin(g.restaurant_id)));

-- ---------------------------------------------------------------------------
-- Orders & kitchen: read-only for clients (writes go through functions)
-- ---------------------------------------------------------------------------
create policy orders_read on public.orders for select to authenticated
  using (app.is_staff(restaurant_id) or app.is_session_guest(session_id));
create policy order_items_read on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
         and (app.is_staff(o.restaurant_id) or app.is_session_guest(o.session_id))));
create policy order_item_add_ons_read on public.order_item_add_ons for select to authenticated
  using (exists (select 1 from public.order_items oi join public.orders o on o.id = oi.order_id
         where oi.id = order_item_id and (app.is_staff(o.restaurant_id) or app.is_session_guest(o.session_id))));
create policy order_history_read on public.order_status_history for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
         and (app.is_staff(o.restaurant_id) or app.is_session_guest(o.session_id))));
create policy cancellation_requests_read on public.order_cancellation_requests for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and app.is_staff(o.restaurant_id)));

create policy tickets_read on public.kitchen_tickets for select to authenticated
  using (app.can_see_station(restaurant_id, station_id));
create policy ticket_items_read on public.kitchen_ticket_items for select to authenticated
  using (exists (select 1 from public.kitchen_tickets k where k.id = ticket_id
         and app.can_see_station(k.restaurant_id, k.station_id)));
create policy ticket_history_read on public.kitchen_ticket_status_history for select to authenticated
  using (exists (select 1 from public.kitchen_tickets k where k.id = ticket_id
         and app.can_see_station(k.restaurant_id, k.station_id)));

-- ---------------------------------------------------------------------------
-- Billing: cashier / manager / admin, plus the guest's own bill
-- ---------------------------------------------------------------------------
create policy invoices_read on public.invoices for select to authenticated
  using (app.has_role(restaurant_id, array['admin','manager','cashier','waiter']::public.app_role[])
         or app.is_session_guest(session_id));
create policy invoice_items_read on public.invoice_items for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id
         and (app.has_role(i.restaurant_id, array['admin','manager','cashier','waiter']::public.app_role[])
              or app.is_session_guest(i.session_id))));

do $$
declare t text;
begin
  foreach t in array array['payments', 'refunds', 'discount_applications'] loop
    execute format($f$
      create policy %1$s_read on public.%1$I for select to authenticated
        using (exists (select 1 from public.invoices i where i.id = invoice_id
               and app.has_role(i.restaurant_id, array['admin','manager','cashier']::public.app_role[])));
    $f$, t);
  end loop;
end $$;

create policy payment_transactions_read on public.payment_transactions for select to authenticated
  using (exists (select 1 from public.payments p join public.invoices i on i.id = p.invoice_id
         where p.id = payment_id and app.has_role(i.restaurant_id, array['admin','manager']::public.app_role[])));

create policy register_sessions_read on public.cash_register_sessions for select to authenticated
  using (exists (select 1 from public.cash_registers r where r.id = register_id
         and app.has_role(r.restaurant_id, array['admin','manager','cashier']::public.app_role[])));

-- ---------------------------------------------------------------------------
-- Service requests, feedback, notifications
-- ---------------------------------------------------------------------------
create policy service_requests_read on public.customer_service_requests for select to authenticated
  using (app.is_staff(restaurant_id) or app.is_session_guest(session_id));
create policy feedback_read on public.customer_feedback for select to authenticated
  using (exists (select 1 from public.table_sessions s where s.id = session_id
         and app.has_role(s.restaurant_id, array['admin','manager']::public.app_role[])));

create policy notifications_read on public.notifications for select to authenticated
  using (exists (select 1 from public.notification_recipients r
                 where r.notification_id = notifications.id and r.user_id = auth.uid()));
create policy notification_recipients_read on public.notification_recipients for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create policy audit_logs_read on public.audit_logs for select to authenticated
  using (app.has_role(restaurant_id, array['admin','manager']::public.app_role[]));
create policy system_config_read on public.system_configurations for select to authenticated
  using (app.is_super_admin());
create policy system_config_write on public.system_configurations for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

-- Nothing in public is reachable by the bare anon role: customers sign in
-- anonymously (role "authenticated", is_anonymous = true) before they read.
revoke all on all tables in schema public from anon;

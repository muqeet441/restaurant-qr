-- =============================================================================
-- 0006  Phase 3: waiter confirmation, kitchen tickets, preparation, serving,
--       cancellations, stale-order alerts
-- =============================================================================

alter table public.orders
  add column clarification_question text,
  add column clarification_answer   text,
  add column stale_alerted_at       timestamptz;

-- ---------------------------------------------------------------------------
-- Visibility: kitchen staff with no station assignments see every station;
-- tickets without a station are visible to all kitchen staff.
-- ---------------------------------------------------------------------------
create or replace function app.can_see_station(p_restaurant uuid, p_station uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.has_role(p_restaurant, array['admin','manager','waiter','cashier']::public.app_role[])
      or (app.has_role(p_restaurant, array['kitchen']::public.app_role[])
          and (p_station is null
               or not exists (
                 select 1 from public.employee_station_assignments a
                 join public.employees e on e.id = a.employee_id
                 where e.user_id = auth.uid())
               or exists (
                 select 1 from public.employee_station_assignments a
                 join public.employees e on e.id = a.employee_id
                 where e.user_id = auth.uid() and e.is_active and a.station_id = p_station)));
$$;

-- ---------------------------------------------------------------------------
-- Recipient helpers
-- ---------------------------------------------------------------------------
create or replace function app.role_user_ids(p_restaurant uuid, p_roles public.app_role[])
returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select array_agg(distinct e.user_id)
  from public.employees e
  join public.user_roles ur on ur.user_id = e.user_id and ur.restaurant_id = e.restaurant_id
  where e.restaurant_id = p_restaurant and e.is_active and ur.role = any (p_roles);
$$;

-- Kitchen staff who would see a ticket for this station.
create or replace function app.station_user_ids(p_restaurant uuid, p_station uuid)
returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select array_agg(distinct e.user_id)
  from public.employees e
  join public.user_roles ur on ur.user_id = e.user_id and ur.restaurant_id = e.restaurant_id
  where e.restaurant_id = p_restaurant and e.is_active and ur.role = 'kitchen'
    and (p_station is null
         or not exists (select 1 from public.employee_station_assignments a where a.employee_id = e.id)
         or exists (select 1 from public.employee_station_assignments a
                    where a.employee_id = e.id and a.station_id = p_station));
$$;

create or replace function app.table_label(p_table uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select 'Table ' || table_number from public.restaurant_tables where id = p_table;
$$;

-- ---------------------------------------------------------------------------
-- Derived statuses (PRD 5.1, 5.4). Item statuses drive tickets and orders.
-- ---------------------------------------------------------------------------
create or replace function app.refresh_ticket_status(p_ticket uuid)
returns public.ticket_status
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket public.kitchen_tickets;
  v_total int; v_ready int; v_preparing int;
  v_new public.ticket_status;
begin
  select * into v_ticket from public.kitchen_tickets where id = p_ticket for update;
  select count(*) filter (where status <> 'cancelled'),
         count(*) filter (where status in ('ready', 'served')),
         count(*) filter (where status = 'preparing')
    into v_total, v_ready, v_preparing
  from public.kitchen_ticket_items where ticket_id = p_ticket;

  v_new := case
    when v_total = 0 then 'cancelled'
    when v_ready = v_total then 'ready'
    when v_ready > 0 then 'partially_ready'
    when v_preparing > 0 then 'preparing'
    else v_ticket.status
  end;
  if v_new is distinct from v_ticket.status then
    update public.kitchen_tickets
       set status = v_new,
           ready_at = case when v_new = 'ready' then coalesce(ready_at, now()) else ready_at end,
           started_at = case when v_new in ('preparing','partially_ready','ready') then coalesce(started_at, now()) else started_at end
     where id = p_ticket;
  end if;
  return v_new;
end;
$$;

create or replace function app.refresh_order_status(p_order uuid)
returns public.order_status
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_total int; v_served int; v_ready int; v_preparing int;
  v_new public.order_status;
begin
  select * into v_order from public.orders where id = p_order for update;
  if v_order.status in ('pending_confirmation', 'on_hold', 'rejected', 'cancelled', 'completed') then
    return v_order.status;
  end if;

  select count(*) filter (where status <> 'cancelled'),
         count(*) filter (where status = 'served'),
         count(*) filter (where status in ('ready', 'served')),
         count(*) filter (where status = 'preparing')
    into v_total, v_served, v_ready, v_preparing
  from public.order_items where order_id = p_order;

  v_new := case
    when v_total = 0 then 'cancelled'
    when v_served = v_total then 'served'
    when v_served > 0 then 'partially_served'
    when v_ready = v_total then 'ready'
    when v_ready > 0 then 'partially_ready'
    when v_preparing > 0 then 'preparing'
    else 'sent_to_kitchen'
  end;
  if v_new is distinct from v_order.status then
    update public.orders
       set status = v_new,
           served_at = case when v_new = 'served' then now() else served_at end,
           rejection_reason = case when v_new = 'cancelled' then coalesce(rejection_reason, 'All items cancelled') else rejection_reason end
     where id = p_order;
  end if;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Waiter: confirm / reject / ask the customer (FR-040..047, BR-003, BR-004)
-- ---------------------------------------------------------------------------
create or replace function public.confirm_order(p_order_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_station record;
  v_ticket  uuid;
  v_summary text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_order.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if v_order.status <> 'pending_confirmation' then
    raise exception 'order_not_pending' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.table_sessions where id = v_order.session_id and status = 'closed') then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;

  update public.orders
     set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_order_id;
  update public.order_items set status = 'confirmed'
   where order_id = p_order_id and status = 'pending';

  -- One ticket per station (FR-065, FR-067). Persisted before anyone is notified.
  for v_station in
    select distinct station_id from public.order_items
     where order_id = p_order_id and status = 'confirmed'
  loop
    insert into public.kitchen_tickets (restaurant_id, order_id, station_id)
    values (v_order.restaurant_id, p_order_id, v_station.station_id)
    returning id into v_ticket;

    insert into public.kitchen_ticket_items (ticket_id, order_item_id, status)
    select v_ticket, id, 'confirmed' from public.order_items
     where order_id = p_order_id and status = 'confirmed'
       and station_id is not distinct from v_station.station_id;

    select string_agg(quantity || '× ' || item_name_snapshot, ', ') into v_summary
      from public.order_items
     where order_id = p_order_id and status = 'confirmed'
       and station_id is not distinct from v_station.station_id;

    perform app.notify(v_order.restaurant_id, 'ticket.new',
      'New ticket · ' || app.table_label(v_order.table_id), v_summary,
      jsonb_build_object('ticket_id', v_ticket, 'order_number', v_order.order_number),
      p_order_id, v_order.session_id,
      app.station_user_ids(v_order.restaurant_id, v_station.station_id));
  end loop;

  update public.orders set status = 'sent_to_kitchen' where id = p_order_id;
end;
$$;

create or replace function public.reject_order(p_order_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order  public.orders;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_order.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if v_order.status not in ('pending_confirmation', 'on_hold') then
    raise exception 'order_not_pending' using errcode = 'P0001';
  end if;

  update public.order_items set status = 'cancelled', cancelled_reason = left(v_reason, 500)
   where order_id = p_order_id;
  update public.orders
     set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(),
         rejection_reason = left(v_reason, 500)
   where id = p_order_id;
end;
$$;

create or replace function public.request_order_clarification(p_order_id uuid, p_question text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_q     text := nullif(trim(coalesce(p_question, '')), '');
begin
  if v_q is null then
    raise exception 'message_required' using errcode = 'P0001';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_order.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if v_order.status not in ('pending_confirmation', 'on_hold') then
    raise exception 'order_not_pending' using errcode = 'P0001';
  end if;
  update public.orders
     set status = 'on_hold', clarification_question = left(v_q, 500), clarification_answer = null
   where id = p_order_id;
end;
$$;

-- The customer answers; the order goes back to the waiter.
create or replace function public.answer_order_clarification(p_order_id uuid, p_answer text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_a     text := nullif(trim(coalesce(p_answer, '')), '');
begin
  if v_a is null then
    raise exception 'message_required' using errcode = 'P0001';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if not app.is_session_guest(v_order.session_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_order.status <> 'on_hold' then
    raise exception 'no_question_pending' using errcode = 'P0001';
  end if;
  update public.orders
     set status = 'pending_confirmation', clarification_answer = left(v_a, 500)
   where id = p_order_id;

  perform app.notify(v_order.restaurant_id, 'order.clarified',
    'Customer replied · ' || app.table_label(v_order.table_id), left(v_a, 200),
    jsonb_build_object('order_number', v_order.order_number),
    p_order_id, v_order.session_id, app.table_waiter_user_ids(v_order.table_id));
end;
$$;

-- Customers may also cancel while the waiter's question is open.
create or replace function public.cancel_pending_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order  public.orders;
  v_staff  boolean;
  v_reason text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  v_staff := app.has_role(v_order.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if not v_staff and not app.is_session_guest(v_order.session_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_order.status not in ('pending_confirmation', 'on_hold') then
    raise exception 'order_already_confirmed' using errcode = 'P0001';
  end if;
  v_reason := coalesce(nullif(trim(p_reason), ''),
                       case when v_staff then 'Cancelled by staff' else 'Cancelled by customer' end);
  update public.order_items set status = 'cancelled', cancelled_reason = v_reason where order_id = p_order_id;
  update public.orders set status = 'cancelled', rejection_reason = v_reason where id = p_order_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Kitchen (FR-057..062)
-- ---------------------------------------------------------------------------
create or replace function app.require_ticket(p_ticket uuid)
returns public.kitchen_tickets
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket public.kitchen_tickets;
begin
  select * into v_ticket from public.kitchen_tickets where id = p_ticket for update;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_ticket.restaurant_id, array['admin','manager','kitchen']::public.app_role[]);
  if not app.can_see_station(v_ticket.restaurant_id, v_ticket.station_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_ticket;
end;
$$;

create or replace function public.accept_ticket(p_ticket_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket public.kitchen_tickets := app.require_ticket(p_ticket_id);
begin
  if v_ticket.status <> 'new' then
    raise exception 'ticket_not_new' using errcode = 'P0001';
  end if;
  update public.kitchen_tickets
     set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
   where id = p_ticket_id;
end;
$$;

create or replace function public.start_ticket(p_ticket_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket public.kitchen_tickets := app.require_ticket(p_ticket_id);
  v_order  public.orders;
begin
  if v_ticket.status not in ('new', 'accepted') then
    raise exception 'ticket_already_started' using errcode = 'P0001';
  end if;

  update public.kitchen_tickets
     set status = 'preparing', started_at = now(),
         accepted_by = coalesce(accepted_by, auth.uid()), accepted_at = coalesce(accepted_at, now())
   where id = p_ticket_id;
  update public.kitchen_ticket_items set status = 'preparing'
   where ticket_id = p_ticket_id and status = 'confirmed';
  update public.order_items oi set status = 'preparing'
    from public.kitchen_ticket_items ti
   where ti.ticket_id = p_ticket_id and ti.order_item_id = oi.id and oi.status = 'confirmed';

  if app.refresh_order_status(v_ticket.order_id) = 'preparing' then
    select * into v_order from public.orders where id = v_ticket.order_id;
    perform app.notify(v_order.restaurant_id, 'order.preparing',
      'Preparing · ' || app.table_label(v_order.table_id), v_order.order_number,
      jsonb_build_object('order_number', v_order.order_number),
      v_order.id, v_order.session_id, app.table_waiter_user_ids(v_order.table_id));
  end if;
end;
$$;

-- Mark individual ticket items ready (FR-059). Empty/null = every open item on the ticket.
create or replace function public.mark_ticket_items_ready(p_ticket_id uuid, p_ticket_item_ids uuid[] default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket  public.kitchen_tickets := app.require_ticket(p_ticket_id);
  v_order   public.orders;
  v_ids     uuid[];
  v_summary text;
  v_status  public.order_status;
begin
  if v_ticket.status = 'cancelled' then
    raise exception 'ticket_cancelled' using errcode = 'P0001';
  end if;

  select array_agg(id) into v_ids
    from public.kitchen_ticket_items
   where ticket_id = p_ticket_id
     and status in ('confirmed', 'preparing')
     and (p_ticket_item_ids is null or cardinality(p_ticket_item_ids) = 0 or id = any (p_ticket_item_ids));

  if p_ticket_item_ids is not null and cardinality(p_ticket_item_ids) > 0
     and coalesce(cardinality(v_ids), 0) <> cardinality(p_ticket_item_ids) then
    raise exception 'item_not_preparable' using errcode = 'P0001';
  end if;
  if v_ids is null then
    return; -- nothing left to do
  end if;

  update public.kitchen_ticket_items set status = 'ready', ready_at = now() where id = any (v_ids);
  update public.order_items oi set status = 'ready'
    from public.kitchen_ticket_items ti
   where ti.id = any (v_ids) and ti.order_item_id = oi.id;

  perform app.refresh_ticket_status(p_ticket_id);
  v_status := app.refresh_order_status(v_ticket.order_id);

  select * into v_order from public.orders where id = v_ticket.order_id;
  select string_agg(oi.quantity || '× ' || oi.item_name_snapshot, ', ') into v_summary
    from public.kitchen_ticket_items ti join public.order_items oi on oi.id = ti.order_item_id
   where ti.id = any (v_ids);

  perform app.notify(v_order.restaurant_id,
    case when v_status = 'ready' then 'order.ready' else 'item.ready' end,
    case when v_status = 'ready' then 'Order ready · ' else 'Ready to serve · ' end || app.table_label(v_order.table_id),
    v_summary,
    jsonb_build_object('order_number', v_order.order_number),
    v_order.id, v_order.session_id, app.table_waiter_user_ids(v_order.table_id));
end;
$$;

-- Kitchen ran out of something: take it off the menu and tell the waiter.
create or replace function public.report_item_unavailable(p_ticket_item_id uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ti    public.kitchen_ticket_items;
  v_item  public.order_items;
  v_order public.orders;
begin
  select * into v_ti from public.kitchen_ticket_items where id = p_ticket_item_id;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'P0002';
  end if;
  perform app.require_ticket(v_ti.ticket_id);
  select * into v_item from public.order_items where id = v_ti.order_item_id;
  select * into v_order from public.orders where id = v_item.order_id;

  update public.menu_items set is_available = false where id = v_item.menu_item_id;
  perform app.notify(v_order.restaurant_id, 'item.unavailable',
    'Out of stock · ' || app.table_label(v_order.table_id),
    v_item.item_name_snapshot || ' is unavailable' || coalesce(': ' || nullif(trim(p_note), ''), '')
      || '. Talk to the customer and cancel or change the item.',
    jsonb_build_object('order_number', v_order.order_number, 'order_item_id', v_item.id),
    v_order.id, v_order.session_id,
    coalesce(app.table_waiter_user_ids(v_order.table_id), '{}') ||
    coalesce(app.role_user_ids(v_order.restaurant_id, array['manager']::public.app_role[]), '{}'));
end;
$$;

-- Kitchen asks the waiter a question about a ticket.
create or replace function public.kitchen_message_waiter(p_ticket_id uuid, p_message text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket public.kitchen_tickets := app.require_ticket(p_ticket_id);
  v_order  public.orders;
  v_msg    text := nullif(trim(coalesce(p_message, '')), '');
begin
  if v_msg is null then
    raise exception 'message_required' using errcode = 'P0001';
  end if;
  select * into v_order from public.orders where id = v_ticket.order_id;
  perform app.notify(v_order.restaurant_id, 'kitchen.question',
    'Kitchen question · ' || app.table_label(v_order.table_id), left(v_msg, 500),
    jsonb_build_object('order_number', v_order.order_number, 'ticket_id', p_ticket_id),
    v_order.id, v_order.session_id, app.table_waiter_user_ids(v_order.table_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Serving (FR-049..053, status rule 5)
-- ---------------------------------------------------------------------------
create or replace function public.serve_items(p_order_item_ids uuid[])
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row   record;
  v_order uuid;
begin
  if p_order_item_ids is null or cardinality(p_order_item_ids) = 0 then
    raise exception 'nothing_to_serve' using errcode = 'P0001';
  end if;
  for v_row in
    select oi.id, oi.status, o.restaurant_id, o.id as order_id
      from public.order_items oi join public.orders o on o.id = oi.order_id
     where oi.id = any (p_order_item_ids)
     for update of oi
  loop
    perform app.require_role(v_row.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
    if v_row.status <> 'ready' then
      raise exception 'item_not_ready' using errcode = 'P0001';
    end if;
  end loop;
  if (select count(*) from public.order_items where id = any (p_order_item_ids)) <> cardinality(p_order_item_ids) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  update public.order_items set status = 'served', served_by = auth.uid(), served_at = now()
   where id = any (p_order_item_ids);
  update public.kitchen_ticket_items set status = 'served' where order_item_id = any (p_order_item_ids);

  for v_order in select distinct order_id from public.order_items where id = any (p_order_item_ids) loop
    perform app.refresh_order_status(v_order);
  end loop;
end;
$$;

-- FR-052: serve a whole order; refused while any item is not ready yet.
create or replace function public.serve_order(p_order_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_ids   uuid[];
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_order.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if exists (select 1 from public.order_items
              where order_id = p_order_id and status not in ('ready', 'served', 'cancelled')) then
    raise exception 'order_not_ready' using errcode = 'P0001';
  end if;
  select array_agg(id) into v_ids from public.order_items where order_id = p_order_id and status = 'ready';
  if v_ids is null then
    raise exception 'nothing_to_serve' using errcode = 'P0001';
  end if;
  perform public.serve_items(v_ids);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancellations after confirmation (workflow 6.3, BR-009, BR-010)
-- ---------------------------------------------------------------------------
create or replace function app.cancel_items(p_item_ids uuid[], p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ticket uuid;
  v_order  uuid;
  v_o      public.orders;
  v_summary text;
  v_station uuid;
begin
  update public.order_items set status = 'cancelled', cancelled_reason = p_reason
   where id = any (p_item_ids) and status not in ('served', 'cancelled');
  update public.kitchen_ticket_items set status = 'cancelled' where order_item_id = any (p_item_ids);

  for v_ticket, v_station in
    select distinct t.id, t.station_id from public.kitchen_ticket_items ti
      join public.kitchen_tickets t on t.id = ti.ticket_id
     where ti.order_item_id = any (p_item_ids)
  loop
    perform app.refresh_ticket_status(v_ticket);
    select o.* into v_o from public.kitchen_tickets t join public.orders o on o.id = t.order_id where t.id = v_ticket;
    select string_agg(oi.quantity || '× ' || oi.item_name_snapshot, ', ') into v_summary
      from public.kitchen_ticket_items ti join public.order_items oi on oi.id = ti.order_item_id
     where ti.ticket_id = v_ticket and ti.order_item_id = any (p_item_ids);
    perform app.notify(v_o.restaurant_id, 'ticket.cancelled',
      'Cancelled · ' || app.table_label(v_o.table_id), v_summary || ' — ' || p_reason,
      jsonb_build_object('ticket_id', v_ticket, 'order_number', v_o.order_number),
      v_o.id, v_o.session_id, app.station_user_ids(v_o.restaurant_id, v_station));
  end loop;

  for v_order in select distinct order_id from public.order_items where id = any (p_item_ids) loop
    perform app.refresh_order_status(v_order);
  end loop;
end;
$$;

-- Returns 'cancelled' or 'requested' (needs manager approval).
create or replace function public.cancel_order_item(p_order_item_id uuid, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_item   public.order_items;
  v_order  public.orders;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_mgr    boolean;
begin
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders where id = v_item.order_id;
  perform app.require_role(v_order.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  v_mgr := app.has_role(v_order.restaurant_id, array['admin','manager']::public.app_role[]);

  if v_item.status = 'pending' then
    raise exception 'order_not_confirmed' using errcode = 'P0001',
      hint = 'Reject the order or let the customer cancel it.';
  elsif v_item.status = 'served' then
    raise exception 'item_already_served' using errcode = 'P0001',
      hint = 'Handle it as a discount or refund when billing.';
  elsif v_item.status = 'cancelled' then
    raise exception 'item_already_cancelled' using errcode = 'P0001';
  end if;

  -- Kitchen hasn't started (or a manager is asking): cancel now.
  if v_item.status = 'confirmed' or v_mgr then
    perform app.cancel_items(array[v_item.id], left(v_reason, 500));
    insert into public.order_cancellation_requests
      (order_id, order_item_id, requested_by, reason, status, reviewed_by, reviewed_at)
    values (v_order.id, v_item.id, auth.uid(), left(v_reason, 500), 'approved', auth.uid(), now());
    return 'cancelled';
  end if;

  if exists (select 1 from public.order_cancellation_requests
              where order_item_id = v_item.id and status = 'pending') then
    raise exception 'cancellation_already_requested' using errcode = 'P0001';
  end if;
  insert into public.order_cancellation_requests (order_id, order_item_id, requested_by, reason)
  values (v_order.id, v_item.id, auth.uid(), left(v_reason, 500));
  perform app.notify(v_order.restaurant_id, 'cancellation.requested',
    'Cancellation needs approval · ' || app.table_label(v_order.table_id),
    v_item.quantity || '× ' || v_item.item_name_snapshot || ' — ' || v_reason,
    jsonb_build_object('order_number', v_order.order_number),
    v_order.id, v_order.session_id,
    app.role_user_ids(v_order.restaurant_id, array['manager','admin']::public.app_role[]));
  return 'requested';
end;
$$;

create or replace function public.review_cancellation(p_request_id uuid, p_approve boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_req   public.order_cancellation_requests;
  v_order public.orders;
begin
  select * into v_req from public.order_cancellation_requests where id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders where id = v_req.order_id;
  perform app.require_role(v_order.restaurant_id, array['admin','manager']::public.app_role[]);
  if v_req.status <> 'pending' then
    raise exception 'request_already_reviewed' using errcode = 'P0001';
  end if;

  if p_approve then
    perform app.cancel_items(
      coalesce(array[v_req.order_item_id],
               (select array_agg(id) from public.order_items where order_id = v_req.order_id)),
      v_req.reason);
  end if;
  update public.order_cancellation_requests
     set status = case when p_approve then 'approved'::public.approval_status else 'denied'::public.approval_status end,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_request_id;

  perform app.notify(v_order.restaurant_id, 'cancellation.reviewed',
    'Cancellation ' || case when p_approve then 'approved' else 'denied' end || ' · ' || app.table_label(v_order.table_id),
    v_req.reason, jsonb_build_object('order_number', v_order.order_number),
    v_order.id, v_order.session_id, array[v_req.requested_by]);
end;
$$;

-- ---------------------------------------------------------------------------
-- FR-048: tell managers about orders nobody has confirmed in time.
-- Runs every minute through pg_cron where available.
-- ---------------------------------------------------------------------------
create or replace function app.alert_stale_orders()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_n   int := 0;
begin
  for v_row in
    select o.id, o.restaurant_id, o.session_id, o.table_id, o.order_number, o.created_at
      from public.orders o
      join public.restaurant_settings s on s.restaurant_id = o.restaurant_id
     where o.status = 'pending_confirmation'
       and o.stale_alerted_at is null
       and o.created_at < now() - make_interval(mins => s.pending_order_alert_minutes)
     for update of o skip locked
  loop
    perform app.notify(v_row.restaurant_id, 'order.stale',
      'Order waiting · ' || app.table_label(v_row.table_id),
      v_row.order_number || ' has waited ' || floor(extract(epoch from now() - v_row.created_at) / 60) || ' min for confirmation',
      jsonb_build_object('order_number', v_row.order_number),
      v_row.id, v_row.session_id,
      app.role_user_ids(v_row.restaurant_id, array['manager']::public.app_role[]));
    update public.orders set stale_alerted_at = now() where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('alert-stale-orders', '* * * * *', 'select app.alert_stale_orders()');
  end if;
end $$;

-- Re-define close_table_session so orders on hold count as unconfirmed.
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
  perform app.require_role(v_session.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  if v_session.status = 'closed' then
    raise exception 'session_already_closed' using errcode = 'P0001';
  end if;

  select * into v_invoice from public.invoices where session_id = p_session_id and status <> 'void';

  v_outstanding := exists (
      select 1 from public.orders
      where session_id = p_session_id
        and status not in ('pending_confirmation', 'on_hold', 'rejected', 'cancelled'))
    and (v_invoice.id is null or v_invoice.status not in ('paid', 'partially_refunded', 'refunded'));

  if v_outstanding then
    if v_reason is null then
      raise exception 'outstanding_balance'
        using errcode = 'P0001', hint = 'Collect payment, or a manager can close with a reason.';
    end if;
    perform app.require_role(v_session.restaurant_id, array['admin','manager']::public.app_role[]);
  end if;

  update public.order_items set status = 'cancelled', cancelled_reason = 'Session closed'
   where order_id in (select id from public.orders
                       where session_id = p_session_id and status in ('pending_confirmation', 'on_hold'));
  update public.orders
     set status = 'cancelled', rejection_reason = coalesce(rejection_reason, 'Session closed')
   where session_id = p_session_id and status in ('pending_confirmation', 'on_hold');

  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(),
         exceptional_close_reason = case when v_outstanding then v_reason end
   where id = p_session_id
  returning * into v_session;

  select * into v_settings from public.restaurant_settings where restaurant_id = v_session.restaurant_id;
  update public.restaurant_tables
     set status = case when coalesce(v_settings.require_cleaning, true)
                       then 'cleaning'::public.table_status else 'available'::public.table_status end
   where id = v_session.table_id;
  return v_session;
end;
$$;

-- FR-158
create or replace function public.mark_all_notifications_read()
returns void
language sql security definer
set search_path = ''
as $$
  update public.notification_recipients set read_at = now()
   where user_id = auth.uid() and read_at is null;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon;
grant execute on function
  app.is_super_admin(), app.has_role(uuid, public.app_role[]), app.is_staff(uuid), app.is_admin(uuid),
  app.is_session_guest(uuid), app.is_restaurant_guest(uuid), app.can_see_station(uuid, uuid),
  app.try_uuid(text),
  app.random_token() -- called by the restaurant_tables insert trigger as the admin
to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.regenerate_table_qr(uuid), public.open_table_session(uuid, int, uuid),
  public.join_table_session(text), public.close_table_session(uuid, text),
  public.mark_table_cleaned(uuid), public.set_table_status(uuid, public.table_status),
  public.assign_table_waiter(uuid, uuid), public.mark_notification_read(uuid),
  public.mark_all_notifications_read(), public.record_login(text, text),
  public.submit_order(uuid, jsonb, uuid, text), public.cancel_pending_order(uuid, text),
  public.confirm_order(uuid), public.reject_order(uuid, text),
  public.request_order_clarification(uuid, text), public.answer_order_clarification(uuid, text),
  public.accept_ticket(uuid), public.start_ticket(uuid), public.mark_ticket_items_ready(uuid, uuid[]),
  public.report_item_unavailable(uuid, text), public.kitchen_message_waiter(uuid, text),
  public.serve_items(uuid[]), public.serve_order(uuid),
  public.cancel_order_item(uuid, text), public.review_cancellation(uuid, boolean)
to authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.order_cancellation_requests;
  end if;
end $$;

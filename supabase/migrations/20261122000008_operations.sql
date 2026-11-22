-- =============================================================================
-- 0008  Phase 5: service requests, feedback, reservations, table transfer &
--       merge, automatic promotions
-- =============================================================================

alter table public.reservations add column reminded_at timestamptz;
create unique index customer_feedback_one_per_guest
  on public.customer_feedback (session_id, user_id);

-- ---------------------------------------------------------------------------
-- Customer service requests (Module 5, FR-085..090)
-- ---------------------------------------------------------------------------
create or replace function public.create_service_request(
  p_session_id uuid,
  p_type       public.service_request_type,
  p_note       text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  s      public.table_sessions;
  v_id   uuid;
  v_note text := nullif(left(trim(coalesce(p_note, '')), 300), '');
  v_label text;
begin
  select * into s from public.table_sessions where id = p_session_id for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  if not app.is_session_guest(p_session_id)
     and not app.has_role(s.restaurant_id, array['admin','manager','waiter']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if s.status = 'closed' then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;
  if p_type = 'problem' and v_note is null then
    raise exception 'message_required' using errcode = 'P0001';
  end if;

  -- The same request is already open: don't notify again (FR-090).
  select id into v_id from public.customer_service_requests
   where session_id = p_session_id and type = p_type and status in ('open', 'accepted');
  if v_id is not null then
    if v_note is not null then
      update public.customer_service_requests set note = v_note where id = v_id;
    end if;
    return v_id;
  end if;

  insert into public.customer_service_requests (restaurant_id, session_id, table_id, type, note, requested_by_user)
  values (s.restaurant_id, s.id, s.table_id, p_type, v_note, auth.uid())
  returning id into v_id;

  v_label := case p_type
    when 'call_waiter' then 'Waiter called'
    when 'water' then 'Water requested'
    when 'bill' then 'Bill requested'
    when 'assistance' then 'Assistance needed'
    else 'Problem reported' end;
  perform app.notify(s.restaurant_id, 'service.' || p_type, v_label || ' · ' || app.table_label(s.table_id),
    v_note, jsonb_build_object('request_id', v_id), null, s.id,
    case when p_type = 'problem'
         then coalesce(app.table_waiter_user_ids(s.table_id), '{}')
              || coalesce(app.role_user_ids(s.restaurant_id, array['manager']::public.app_role[]), '{}')
         else app.table_waiter_user_ids(s.table_id) end);

  if p_type = 'bill' then
    perform public.request_bill(p_session_id);
  end if;
  return v_id;
end;
$$;

create or replace function app.require_service_request(p_id uuid)
returns public.customer_service_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  r public.customer_service_requests;
begin
  select * into r from public.customer_service_requests where id = p_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

create or replace function public.accept_service_request(p_request_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  r public.customer_service_requests := app.require_service_request(p_request_id);
begin
  perform app.require_role(r.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if r.status <> 'open' then
    raise exception 'request_not_open' using errcode = 'P0001';
  end if;
  update public.customer_service_requests
     set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
   where id = p_request_id;
end;
$$;

create or replace function public.complete_service_request(p_request_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  r public.customer_service_requests := app.require_service_request(p_request_id);
begin
  perform app.require_role(r.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if r.status not in ('open', 'accepted') then
    raise exception 'request_not_open' using errcode = 'P0001';
  end if;
  update public.customer_service_requests
     set status = 'completed', completed_by = auth.uid(), completed_at = now(),
         accepted_by = coalesce(accepted_by, auth.uid()), accepted_at = coalesce(accepted_at, now())
   where id = p_request_id;
end;
$$;

create or replace function public.cancel_service_request(p_request_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  r public.customer_service_requests := app.require_service_request(p_request_id);
begin
  if not app.is_session_guest(r.session_id)
     and not app.has_role(r.restaurant_id, array['admin','manager','waiter']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if r.status not in ('open', 'accepted') then
    raise exception 'request_not_open' using errcode = 'P0001';
  end if;
  update public.customer_service_requests set status = 'cancelled' where id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer feedback. Allowed during the visit and for 6 hours after it ends.
-- ---------------------------------------------------------------------------
create or replace function public.submit_feedback(p_session_id uuid, p_rating int, p_comment text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.table_sessions;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'invalid_rating' using errcode = 'P0001';
  end if;
  select * into s from public.table_sessions where id = p_session_id;
  if not found
     or not exists (select 1 from public.session_guests where session_id = p_session_id and user_id = auth.uid())
     or (s.closed_at is not null and s.closed_at < now() - interval '6 hours') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.customer_feedback (session_id, user_id, rating, comment)
  values (p_session_id, auth.uid(), p_rating, nullif(left(trim(coalesce(p_comment, '')), 1000), ''))
  on conflict (session_id, user_id)
    do update set rating = excluded.rating, comment = excluded.comment, created_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Reservations (Module 8, FR-133..140)
-- Validation lives in a trigger so every write path is covered.
-- ---------------------------------------------------------------------------
create or replace function app.reservation_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  t public.restaurant_tables;
begin
  if tg_op = 'UPDATE' and old.status in ('completed', 'cancelled', 'no_show')
     and new.status is distinct from old.status then
    raise exception 'reservation_closed' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.reserved_for < now() - interval '15 minutes' then
      raise exception 'reservation_in_past' using errcode = 'P0001';
    end if;
  end if;
  if length(trim(new.customer_name)) = 0 or length(trim(new.contact_number)) = 0 then
    raise exception 'reservation_contact_required' using errcode = 'P0001';
  end if;

  if new.table_id is not null then
    -- Lock the table so two bookings can't slip past each other's check.
    select * into t from public.restaurant_tables
     where id = new.table_id and restaurant_id = new.restaurant_id for update;
    if not found or not t.is_active then
      raise exception 'table_not_found' using errcode = 'P0002';
    end if;
    if t.capacity < new.guest_count then
      raise exception 'table_too_small' using errcode = 'P0001',
        detail = 'Table ' || t.table_number || ' seats ' || t.capacity;
    end if;
    if new.status in ('pending', 'confirmed') and exists (
      select 1 from public.reservations r
       where r.table_id = new.table_id and r.id <> new.id
         and r.status in ('pending', 'confirmed', 'arrived')
         and tstzrange(r.reserved_for, r.reserved_for + make_interval(mins => r.duration_minutes))
             && tstzrange(new.reserved_for, new.reserved_for + make_interval(mins => new.duration_minutes))
    ) then
      raise exception 'reservation_conflict' using errcode = 'P0001',
        detail = 'Table ' || t.table_number || ' is already booked then.';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard before insert or update on public.reservations
  for each row execute function app.reservation_guard();

create or replace function app.reservation_after()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.notify(new.restaurant_id, 'reservation.created',
      'New reservation · ' || new.customer_name,
      new.guest_count || ' guests · ' || to_char(new.reserved_for at time zone
        (select timezone from public.restaurants where id = new.restaurant_id), 'Dy DD Mon HH24:MI'),
      jsonb_build_object('reservation_id', new.id), null, null,
      app.role_user_ids(new.restaurant_id, array['manager']::public.app_role[]));
  elsif new.status in ('cancelled', 'no_show') and old.status is distinct from new.status
        and new.table_id is not null then
    -- Release a table we were holding for this booking.
    update public.restaurant_tables t set status = 'available'
     where t.id = new.table_id and t.status = 'reserved'
       and not exists (select 1 from public.table_sessions s where s.table_id = t.id and s.status <> 'closed')
       and not exists (select 1 from public.reservations r
                        where r.table_id = t.id and r.id <> new.id and r.status in ('pending', 'confirmed')
                          and r.reserved_for between now() - interval '30 minutes' and now() + interval '30 minutes');
  end if;
  return null;
end;
$$;
create trigger after_change after insert or update of status on public.reservations
  for each row execute function app.reservation_after();

create trigger audit after insert or update or delete on public.reservations
  for each row execute function app.audit_row();

-- Every 5 minutes: remind staff about bookings in the next 30 minutes and
-- hold the table (FR-140).
create or replace function app.remind_reservations()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  r   record;
  n   int := 0;
begin
  for r in
    select res.*, t.table_number
      from public.reservations res
      left join public.restaurant_tables t on t.id = res.table_id
     where res.status in ('pending', 'confirmed')
       and res.reminded_at is null
       and res.reserved_for between now() and now() + interval '30 minutes'
     for update of res skip locked
  loop
    perform app.notify(r.restaurant_id, 'reservation.soon',
      'Arriving soon · ' || r.customer_name,
      r.guest_count || ' guests' || coalesce(' · Table ' || r.table_number, ' · no table assigned'),
      jsonb_build_object('reservation_id', r.id), null, null,
      coalesce(case when r.table_id is not null then app.table_waiter_user_ids(r.table_id) end, '{}')
        || coalesce(app.role_user_ids(r.restaurant_id, array['manager']::public.app_role[]), '{}'));
    update public.reservations set reminded_at = now() where id = r.id;
    if r.table_id is not null then
      update public.restaurant_tables set status = 'reserved'
       where id = r.table_id and status = 'available';
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('remind-reservations', '*/5 * * * *', 'select app.remind_reservations()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Closing a session also completes its reservation, cancels open service
-- requests and releases tables merged into it.
-- ---------------------------------------------------------------------------
create or replace function app.session_closed()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_clean boolean;
begin
  if new.status <> 'closed' or old.status = 'closed' then
    return null;
  end if;
  update public.reservations set status = 'completed'
   where id = new.reservation_id and status = 'arrived';
  update public.customer_service_requests set status = 'cancelled'
   where session_id = new.id and status in ('open', 'accepted');

  select coalesce(require_cleaning, true) into v_clean
    from public.restaurant_settings where restaurant_id = new.restaurant_id;
  update public.restaurant_tables t
     set status = case when v_clean then 'cleaning'::public.table_status else 'available'::public.table_status end
    from public.table_merges m
    join public.table_sessions ms on ms.id = m.merged_session_id
   where m.primary_session_id = new.id and t.id = ms.table_id
     and not exists (select 1 from public.table_sessions s where s.table_id = t.id and s.status <> 'closed');
  return null;
end;
$$;
create trigger on_closed after update of status on public.table_sessions
  for each row execute function app.session_closed();

-- ---------------------------------------------------------------------------
-- Transfer a party to another table (FR-076, FR-078, BR-019)
-- ---------------------------------------------------------------------------
create or replace function public.transfer_session(p_session_id uuid, p_to_table_id uuid, p_reason text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  s       public.table_sessions;
  v_from  public.restaurant_tables;
  v_to    public.restaurant_tables;
  v_clean boolean;
begin
  select * into s from public.table_sessions where id = p_session_id for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(s.restaurant_id, array['admin','manager']::public.app_role[]);
  if s.status = 'closed' then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;
  if s.table_id = p_to_table_id then
    raise exception 'same_table' using errcode = 'P0001';
  end if;

  -- Lock both tables in a stable order to avoid deadlocks.
  perform 1 from public.restaurant_tables where id in (s.table_id, p_to_table_id) order by id for update;
  select * into v_from from public.restaurant_tables where id = s.table_id;
  select * into v_to from public.restaurant_tables where id = p_to_table_id and restaurant_id = s.restaurant_id;
  if not found or not v_to.is_active then
    raise exception 'table_not_found' using errcode = 'P0002';
  end if;
  if v_to.status not in ('available', 'reserved')
     or exists (select 1 from public.table_sessions where table_id = p_to_table_id and status <> 'closed') then
    raise exception 'table_not_available' using errcode = 'P0001';
  end if;

  insert into public.table_transfers (session_id, from_table_id, to_table_id, transferred_by, reason)
  values (p_session_id, v_from.id, v_to.id, auth.uid(), nullif(left(trim(coalesce(p_reason, '')), 300), ''));

  update public.table_sessions set table_id = v_to.id where id = p_session_id;
  update public.orders set table_id = v_to.id where session_id = p_session_id;
  update public.customer_service_requests set table_id = v_to.id
   where session_id = p_session_id and status in ('open', 'accepted');

  select coalesce(require_cleaning, true) into v_clean
    from public.restaurant_settings where restaurant_id = s.restaurant_id;
  update public.restaurant_tables set status = v_from.status where id = v_to.id;
  update public.restaurant_tables
     set status = case when v_clean then 'cleaning'::public.table_status else 'available'::public.table_status end
   where id = v_from.id;

  perform app.notify(s.restaurant_id, 'session.transferred',
    'Moved · Table ' || v_from.table_number || ' → ' || v_to.table_number,
    nullif(trim(coalesce(p_reason, '')), ''), jsonb_build_object('session_id', s.id), null, s.id,
    coalesce(app.table_waiter_user_ids(v_from.id), '{}') || coalesce(app.table_waiter_user_ids(v_to.id), '{}'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Merge two parties into one bill (FR-077, FR-078)
-- The merged table stays occupied and is released when the primary session closes.
-- ---------------------------------------------------------------------------
create or replace function public.merge_sessions(p_primary_session_id uuid, p_merged_session_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  p      public.table_sessions;
  m      public.table_sessions;
  v_inv  public.invoices;
  v_from text;
  v_to   text;
begin
  if p_primary_session_id = p_merged_session_id then
    raise exception 'same_table' using errcode = 'P0001';
  end if;
  -- Stable lock order.
  perform 1 from public.table_sessions where id in (p_primary_session_id, p_merged_session_id) order by id for update;
  select * into p from public.table_sessions where id = p_primary_session_id;
  select * into m from public.table_sessions where id = p_merged_session_id;
  if p.id is null or m.id is null or p.restaurant_id <> m.restaurant_id then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(p.restaurant_id, array['admin','manager','waiter']::public.app_role[]);
  if p.status = 'closed' or m.status = 'closed' then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;

  for v_inv in select * from public.invoices
                where session_id in (p.id, m.id) and status <> 'void' loop
    if v_inv.finalized_at is not null then
      raise exception 'invoice_finalized' using errcode = 'P0001';
    end if;
  end loop;
  -- The merged party's draft bill is replaced by the primary's.
  update public.invoices set status = 'void', void_reason = 'Merged', voided_by = auth.uid()
   where session_id = m.id and status <> 'void';

  update public.orders set session_id = p.id where session_id = m.id;
  insert into public.session_guests (session_id, user_id)
  select p.id, user_id from public.session_guests where session_id = m.id
  on conflict do nothing;
  update public.customer_service_requests set session_id = p.id
   where session_id = m.id and status in ('open', 'accepted');

  insert into public.table_merges (primary_session_id, merged_session_id, merged_by)
  values (p.id, m.id, auth.uid());

  select table_number into v_to from public.restaurant_tables where id = p.table_id;
  select table_number into v_from from public.restaurant_tables where id = m.table_id;
  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(),
         exceptional_close_reason = 'Merged into table ' || v_to
   where id = m.id;
  -- Still in use by the merged party.
  update public.restaurant_tables set status = 'occupied' where id = m.table_id;

  if p.status = 'open' and exists (select 1 from public.orders where session_id = p.id) then
    update public.table_sessions set status = 'active' where id = p.id;
  end if;
  if exists (select 1 from public.invoices where session_id = p.id and status <> 'void') then
    perform app.recompute_invoice((select id from public.invoices where session_id = p.id and status <> 'void'));
  end if;

  perform app.notify(p.restaurant_id, 'session.merged', 'Merged · Table ' || v_from || ' + ' || v_to,
    'One bill at table ' || v_to, jsonb_build_object('session_id', p.id), null, p.id,
    coalesce(app.table_waiter_user_ids(p.table_id), '{}') || coalesce(app.table_waiter_user_ids(m.table_id), '{}'));
end;
$$;

-- Scanning a merged table's QR joins the party it was merged into.
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

  select t.* into v_table from public.restaurant_tables t
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

  select * into v_session from public.table_sessions
   where table_id = v_table.id and status <> 'closed';
  if not found then
    select s.* into v_session
      from public.table_merges mg
      join public.table_sessions ms on ms.id = mg.merged_session_id
      join public.table_sessions s on s.id = mg.primary_session_id
     where ms.table_id = v_table.id and s.status <> 'closed'
     order by mg.created_at desc
     limit 1;
  end if;

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
    'session', jsonb_build_object('id', v_session.id, 'status', v_session.status, 'opened_at', v_session.opened_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- Automatic promotions (FR-152): active discounts *without* a code apply
-- themselves to draft bills when they are valid right now.
-- ---------------------------------------------------------------------------
create or replace function app.discount_valid_now(p_discount uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select d.is_active
     and (d.starts_at is null or now() >= d.starts_at)
     and (d.ends_at is null or now() <= d.ends_at)
     and (d.active_days is null or cardinality(d.active_days) = 0
          or extract(dow from now() at time zone r.timezone)::int = any (d.active_days))
     and (d.start_time is null or d.end_time is null
          or (now() at time zone r.timezone)::time between d.start_time and d.end_time)
     and (d.max_uses is null or d.used_count < d.max_uses)
  from public.discounts d join public.restaurants r on r.id = d.restaurant_id
  where d.id = p_discount;
$$;

create or replace function app.sync_auto_promotions(p_invoice uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.invoices;
begin
  select * into v from public.invoices where id = p_invoice;
  if v.finalized_at is not null or v.status = 'void' then
    return;
  end if;
  delete from public.discount_applications da
   using public.discounts d
   where da.invoice_id = p_invoice and da.discount_id = d.id and d.code is null;
  insert into public.discount_applications (discount_id, invoice_id, amount, reason)
  select d.id, p_invoice, 0, d.name
    from public.discounts d
   where d.restaurant_id = v.restaurant_id and d.code is null and app.discount_valid_now(d.id);
end;
$$;

create or replace function public.generate_invoice(p_session_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions;
  v_id      uuid;
begin
  select * into v_session from public.table_sessions where id = p_session_id for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v_session.restaurant_id, array['admin','manager','cashier','waiter']::public.app_role[]);
  if v_session.status = 'closed' then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;

  select id into v_id from public.invoices where session_id = p_session_id and status <> 'void';
  if v_id is null then
    insert into public.invoices (restaurant_id, session_id, invoice_number, receipt_token)
    values (v_session.restaurant_id, p_session_id,
            app.next_document_number(v_session.restaurant_id, 'inv'), app.random_token())
    returning id into v_id;
  end if;
  perform app.sync_auto_promotions(v_id);
  perform app.recompute_invoice(v_id);

  if v_session.status in ('open', 'active') then
    update public.table_sessions set status = 'billing' where id = p_session_id;
  end if;
  update public.restaurant_tables set status = 'billing'
   where id = v_session.table_id and status in ('occupied', 'ordering');
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit rows for tables without restaurant_id (payments, refunds, discount
-- applications, register sessions, cancellation requests) now resolve the
-- restaurant through their parent, so admins can see them.
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
  v_restaurant uuid;
begin
  if tg_op = 'UPDATE' and v_new = v_old then
    return new;
  end if;
  v_restaurant := app.try_uuid(v_row ->> 'restaurant_id');
  if v_restaurant is null and v_row ? 'invoice_id' then
    select restaurant_id into v_restaurant from public.invoices where id = app.try_uuid(v_row ->> 'invoice_id');
  end if;
  if v_restaurant is null and v_row ? 'order_id' then
    select restaurant_id into v_restaurant from public.orders where id = app.try_uuid(v_row ->> 'order_id');
  end if;
  if v_restaurant is null and v_row ? 'register_id' then
    select restaurant_id into v_restaurant from public.cash_registers where id = app.try_uuid(v_row ->> 'register_id');
  end if;

  insert into public.audit_logs (restaurant_id, actor_id, table_name, record_id, action, old_data, new_data)
  values (v_restaurant, auth.uid(), tg_table_name,
          coalesce(v_row ->> 'id', v_row ->> 'restaurant_id'), lower(tg_op), v_old, v_new);
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon;
grant execute on function
  app.is_super_admin(), app.has_role(uuid, public.app_role[]), app.is_staff(uuid), app.is_admin(uuid),
  app.is_session_guest(uuid), app.is_restaurant_guest(uuid), app.can_see_station(uuid, uuid),
  app.try_uuid(text), app.random_token()
to authenticated;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.get_receipt(text) from authenticated;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated;
grant execute on function
  public.create_service_request(uuid, public.service_request_type, text),
  public.accept_service_request(uuid), public.complete_service_request(uuid),
  public.cancel_service_request(uuid), public.submit_feedback(uuid, int, text),
  public.transfer_session(uuid, uuid, text), public.merge_sessions(uuid, uuid),
  public.join_table_session(text), public.generate_invoice(uuid)
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.reservations;
  end if;
end $$;

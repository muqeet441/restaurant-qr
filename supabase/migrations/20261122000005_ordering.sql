-- =============================================================================
-- 0005  Phase 2: menu integrity, image storage, order submission & tracking
-- =============================================================================

-- One default variation per item.
create unique index item_variations_one_default
  on public.item_variations (item_id) where is_default;

-- Returns null instead of raising on malformed input.
create or replace function app.try_uuid(p text)
returns uuid
language plpgsql immutable
set search_path = ''
as $$
begin
  return p::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Notifications helper (Module 11). Persists first; Realtime streams the
-- notification_recipients rows to connected clients (BR-004, FR-156).
-- ---------------------------------------------------------------------------
create or replace function app.notify(
  p_restaurant uuid,
  p_type       text,
  p_title      text,
  p_body       text,
  p_payload    jsonb,
  p_order      uuid,
  p_session    uuid,
  p_recipients uuid[]
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then
    return null;
  end if;
  insert into public.notifications (restaurant_id, type, title, body, payload, order_id, session_id)
  values (p_restaurant, p_type, p_title, p_body, coalesce(p_payload, '{}'), p_order, p_session)
  returning id into v_id;

  insert into public.notification_recipients (notification_id, user_id)
  select v_id, u from (select distinct unnest(p_recipients) as u) r where u is not null;
  return v_id;
end;
$$;

-- Assigned waiter for a table, or every active waiter/manager when unassigned.
create or replace function app.table_waiter_user_ids(p_table uuid)
returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select array_agg(e.user_id)
       from public.employee_table_assignments a
       join public.employees e on e.id = a.employee_id and e.is_active
      where a.table_id = p_table and a.unassigned_at is null),
    (select array_agg(distinct e.user_id)
       from public.restaurant_tables t
       join public.employees e on e.restaurant_id = t.restaurant_id and e.is_active
       join public.user_roles ur on ur.user_id = e.user_id and ur.restaurant_id = t.restaurant_id
      where t.id = p_table and ur.role in ('waiter', 'manager'))
  );
$$;

-- ---------------------------------------------------------------------------
-- submit_order  (FR-024..033, BR-001, BR-005, BR-007, BR-020)
--
-- p_items: [{ "menu_item_id": uuid, "variation_id": uuid|null, "quantity": int,
--             "add_on_ids": [uuid], "special_instructions": text|null }]
--
-- Prices come from the database, never from the client, and are copied onto
-- the order as snapshots. Re-sending the same idempotency key returns the
-- original order instead of creating a duplicate.
-- ---------------------------------------------------------------------------
create or replace function public.submit_order(
  p_session_id      uuid,
  p_items           jsonb,
  p_idempotency_key uuid,
  p_note            text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_session   public.table_sessions;
  v_existing  public.orders;
  v_table     public.restaurant_tables;
  v_order_id  uuid;
  v_number    text;
  v_line      jsonb;
  v_item      public.menu_items;
  v_var       public.item_variations;
  v_qty       int;
  v_unit      numeric(12,2);
  v_addons    numeric(12,2);
  v_oi_id     uuid;
  v_subtotal  numeric(12,2) := 0;
  v_ids       text[];
  v_addon     record;
  v_group     record;
  v_count     int;
  v_var_id    uuid;
  v_item_id   uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'invalid_order' using errcode = 'P0001';
  end if;

  select * into v_session from public.table_sessions where id = p_session_id for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  if not app.is_session_guest(p_session_id)
     and not app.has_role(v_session.restaurant_id, array['admin','manager','waiter']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Duplicate submission (double tap, retry after a dropped connection).
  select * into v_existing from public.orders
   where session_id = p_session_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'order_number', v_existing.order_number,
                              'status', v_existing.status, 'subtotal', v_existing.subtotal,
                              'duplicate', true);
  end if;

  if v_session.status = 'closed' then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_order' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'order_too_large' using errcode = 'P0001';
  end if;
  if (select count(*) from public.orders
       where session_id = p_session_id and status = 'pending_confirmation') >= 5 then
    raise exception 'too_many_pending_orders' using errcode = 'P0001',
      hint = 'Wait for the waiter to confirm earlier orders.';
  end if;

  select * into v_table from public.restaurant_tables where id = v_session.table_id;
  v_number := app.next_document_number(v_session.restaurant_id, 'ord');

  insert into public.orders (restaurant_id, session_id, table_id, order_number, idempotency_key,
                             customer_user_id, customer_note)
  values (v_session.restaurant_id, p_session_id, v_session.table_id, v_number, p_idempotency_key,
          v_uid, nullif(left(trim(coalesce(p_note, '')), 500), ''))
  returning id into v_order_id;

  for v_line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_line) is distinct from 'object' then
      raise exception 'invalid_order' using errcode = 'P0001';
    end if;

    -- Quantity
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' then
      raise exception 'invalid_quantity' using errcode = 'P0001';
    end if;
    v_qty := floor((v_line ->> 'quantity')::numeric);
    if v_qty < 1 or v_qty > 50 or (v_line ->> 'quantity')::numeric <> v_qty then
      raise exception 'invalid_quantity' using errcode = 'P0001';
    end if;

    -- Item: must belong to this restaurant, be active, in an active category, and available.
    v_item_id := app.try_uuid(v_line ->> 'menu_item_id');
    select i.* into v_item
      from public.menu_items i
      join public.menu_categories c on c.id = i.category_id and c.is_active
     where i.id = v_item_id and i.restaurant_id = v_session.restaurant_id and i.is_active;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    if not v_item.is_available then
      raise exception 'item_unavailable' using errcode = 'P0001', detail = v_item.name;
    end if;

    -- Variation: required when the item has any active ones.
    v_var := null;
    v_var_id := app.try_uuid(nullif(v_line ->> 'variation_id', ''));
    if v_var_id is not null then
      select * into v_var from public.item_variations
       where id = v_var_id and item_id = v_item.id and is_active;
      if not found then
        raise exception 'invalid_variation' using errcode = 'P0001', detail = v_item.name;
      end if;
    elsif nullif(v_line ->> 'variation_id', '') is not null then
      raise exception 'invalid_variation' using errcode = 'P0001', detail = v_item.name;
    elsif exists (select 1 from public.item_variations where item_id = v_item.id and is_active) then
      raise exception 'variation_required' using errcode = 'P0001', detail = v_item.name;
    end if;

    v_unit := greatest(v_item.base_price + coalesce(v_var.price_delta, 0), 0);

    insert into public.order_items (order_id, menu_item_id, variation_id, station_id,
                                    item_name_snapshot, variation_name_snapshot,
                                    unit_price_snapshot, quantity, line_total, special_instructions)
    values (v_order_id, v_item.id, v_var.id, v_item.station_id, v_item.name, v_var.name,
            v_unit, v_qty, 0,
            nullif(left(trim(coalesce(v_line ->> 'special_instructions', '')), 500), ''))
    returning id into v_oi_id;

    -- Add-ons: each must be active and in a group linked to this item; no duplicates.
    if v_line ? 'add_on_ids' and jsonb_typeof(v_line -> 'add_on_ids') <> 'array' then
      raise exception 'invalid_add_on' using errcode = 'P0001', detail = v_item.name;
    end if;
    select coalesce(array_agg(x), '{}') into v_ids
      from jsonb_array_elements_text(coalesce(v_line -> 'add_on_ids', '[]'::jsonb)) as t(x);
    if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) as u(x)) then
      raise exception 'invalid_add_on' using errcode = 'P0001', detail = v_item.name;
    end if;

    v_addons := 0;
    for v_addon in
      select a.id, a.name, a.price, ig.item_id as linked
        from unnest(v_ids) as u(x)
        left join public.add_ons a on a.id = app.try_uuid(u.x) and a.is_active
        left join public.item_add_on_groups ig on ig.group_id = a.group_id and ig.item_id = v_item.id
    loop
      if v_addon.id is null or v_addon.linked is null then
        raise exception 'invalid_add_on' using errcode = 'P0001', detail = v_item.name;
      end if;
      insert into public.order_item_add_ons (order_item_id, add_on_id, name_snapshot, price_snapshot)
      values (v_oi_id, v_addon.id, v_addon.name, v_addon.price);
      v_addons := v_addons + v_addon.price;
    end loop;

    -- Min / max selection per group (FR-131, FR-132).
    for v_group in
      select g.id, g.name, g.min_select, g.max_select
        from public.item_add_on_groups ig
        join public.add_on_groups g on g.id = ig.group_id
       where ig.item_id = v_item.id
    loop
      select count(*) into v_count
        from public.order_item_add_ons oa
        join public.add_ons a on a.id = oa.add_on_id
       where oa.order_item_id = v_oi_id and a.group_id = v_group.id;
      if v_count < v_group.min_select
         or (v_group.max_select is not null and v_count > v_group.max_select) then
        raise exception 'add_on_selection_invalid' using errcode = 'P0001',
          detail = v_item.name || ': ' || v_group.name;
      end if;
    end loop;

    update public.order_items
       set line_total = (v_unit + v_addons) * v_qty
     where id = v_oi_id;
    v_subtotal := v_subtotal + (v_unit + v_addons) * v_qty;
  end loop;

  update public.orders set subtotal = v_subtotal where id = v_order_id;

  if v_session.status = 'open' then
    update public.table_sessions set status = 'active' where id = p_session_id;
  end if;

  perform app.notify(
    v_session.restaurant_id, 'order.new',
    'New order · Table ' || v_table.table_number,
    v_number || ' is waiting for confirmation',
    jsonb_build_object('order_number', v_number, 'table_number', v_table.table_number),
    v_order_id, p_session_id,
    app.table_waiter_user_ids(v_session.table_id));

  return jsonb_build_object('order_id', v_order_id, 'order_number', v_number,
                            'status', 'pending_confirmation', 'subtotal', v_subtotal,
                            'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel an order that no waiter has confirmed yet (workflow 6.3, step 3).
-- After confirmation, cancellation goes through the approval flow (Phase 3).
-- ---------------------------------------------------------------------------
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
  if v_order.status <> 'pending_confirmation' then
    raise exception 'order_already_confirmed' using errcode = 'P0001';
  end if;

  v_reason := coalesce(nullif(trim(p_reason), ''),
                       case when v_staff then 'Cancelled by staff' else 'Cancelled by customer' end);

  update public.order_items set status = 'cancelled', cancelled_reason = v_reason
   where order_id = p_order_id;
  update public.orders set status = 'cancelled', rejection_reason = v_reason
   where id = p_order_id;
end;
$$;

revoke execute on function public.submit_order(uuid, jsonb, uuid, text) from public, anon;
revoke execute on function public.cancel_pending_order(uuid, text) from public, anon;
grant execute on function public.submit_order(uuid, jsonb, uuid, text) to authenticated;
grant execute on function public.cancel_pending_order(uuid, text) to authenticated;
revoke execute on function app.notify(uuid, text, text, text, jsonb, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke execute on function app.table_waiter_user_ids(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Menu image storage (Supabase Storage). Skipped where Storage isn't installed
-- (the local PGlite test harness).
-- Object paths: <restaurant_id>/<file>
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('menu-images', 'menu-images', true, 2097152,
            array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    execute $p$
      create policy menu_images_admin_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'menu-images'
                    and app.is_admin(app.try_uuid((storage.foldername(name))[1])))
    $p$;
    execute $p$
      create policy menu_images_admin_update on storage.objects for update to authenticated
        using (bucket_id = 'menu-images'
               and app.is_admin(app.try_uuid((storage.foldername(name))[1])))
    $p$;
    execute $p$
      create policy menu_images_admin_delete on storage.objects for delete to authenticated
        using (bucket_id = 'menu-images'
               and app.is_admin(app.try_uuid((storage.foldername(name))[1])))
    $p$;
  end if;
end $$;

-- Customers track their orders live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

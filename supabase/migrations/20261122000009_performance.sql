-- =============================================================================
-- 0009  Phase 6: performance hardening
--
-- Index every foreign-key column that doesn't already lead an index. These
-- columns back RLS sub-queries, joins and ON DELETE cascades; unindexed they
-- turn into sequential scans as the tables grow (Supabase's performance
-- advisor flags the same thing).
-- =============================================================================
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, cl.relname as rel, a.attname as col
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and array_length(c.conkey, 1) = 1
       and c.connamespace = 'public'::regnamespace
       and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
  loop
    execute format('create index if not exists %I on %s (%I)', left(r.rel || '_' || r.col || '_fk_idx', 63), r.tbl, r.col);
  end loop;
end $$;

-- Hot paths the dashboards poll.
create index if not exists orders_session_status on public.orders (session_id, status);
create index if not exists kitchen_tickets_restaurant_status on public.kitchen_tickets (restaurant_id, status, created_at);
create index if not exists service_requests_restaurant_status on public.customer_service_requests (restaurant_id, status);
create index if not exists reservations_table_time on public.reservations (table_id, reserved_for) where status in ('pending', 'confirmed', 'arrived');
create index if not exists notifications_created on public.notifications (created_at desc);

analyze;

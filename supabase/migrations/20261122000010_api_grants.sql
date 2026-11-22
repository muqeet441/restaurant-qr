-- =============================================================================
-- 0010  Explicit API grants
--
-- Newer Supabase projects no longer grant table privileges to the API roles
-- automatically. Grant them explicitly. Row Level Security (enabled on every
-- table, see 0003) still decides which rows each user may read or write; a
-- grant only lets the role *reach* the table.
--
--   anon          → nothing (customers sign in anonymously → "authenticated")
--   authenticated → table access, filtered by RLS; RPCs granted individually
--   service_role  → everything (server-side only: staff accounts, receipts)
-- =============================================================================

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to service_role;

-- Keep the column-level limits on tables (status and QR token only change
-- through functions).
revoke insert, update on public.restaurant_tables from authenticated;
grant insert (restaurant_id, branch_id, table_number, name, capacity, location, is_active)
  on public.restaurant_tables to authenticated;
grant update (branch_id, table_number, name, capacity, location, is_active)
  on public.restaurant_tables to authenticated;

-- Internal-only functions stay closed to signed-in users.
revoke execute on function public.get_receipt(text) from authenticated;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated;

-- Nothing for the bare anon role.
revoke all on all tables in schema public from anon;

-- Future tables created by migrations get the same treatment.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;

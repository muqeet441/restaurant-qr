-- =============================================================================
-- 0011  Let the server (service role) use the private helper schema
--
-- Triggers fired by server-side writes (e.g. creating a table generates its QR
-- token via app.random_token) run as the service role, which needs access to
-- the `app` schema. The service role is server-only and already bypasses RLS.
-- =============================================================================
grant usage on schema app to service_role;
grant execute on all functions in schema app to service_role;
alter default privileges in schema app grant execute on functions to service_role;

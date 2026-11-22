-- =============================================================================
-- 0012  Self-service defaults for new restaurants
--
-- The customer's QR scan starts the visit (no staff "seat" step) and the
-- cashier closing the bill ends it (no separate cleaning step). Both remain
-- switchable per restaurant in Admin → Settings → Operating rules.
-- =============================================================================
alter table public.restaurant_settings
  alter column customer_can_open_session set default true,
  alter column require_cleaning set default false;

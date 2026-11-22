-- =============================================================================
-- 0007  Phase 4: invoices, taxes & charges, discounts, split payments,
--       refunds, receipts, cash registers, bill requests
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column tax_breakdown    jsonb not null default '[]',
  add column charge_breakdown jsonb not null default '[]',
  add column receipt_token    text unique,
  add column void_reason      text,
  add column voided_by        uuid references auth.users(id);

alter table public.invoice_items
  add column menu_item_id         uuid references public.menu_items(id),
  add column category_id          uuid references public.menu_categories(id),
  add column tax_configuration_id uuid references public.tax_configurations(id),
  add column tax_rate             numeric(5,2) not null default 0,
  add column tax_inclusive        boolean not null default false;

-- Manual discounts keep their rule so the amount can be recomputed.
alter table public.discount_applications
  add column kind  public.discount_type,
  add column value numeric(12,2);

alter table public.payments
  add column tendered       numeric(12,2),
  add column change_given   numeric(12,2),
  add column payer_label    text,
  add column failure_reason text;

-- "Split by items": which invoice lines a payment covered.
create table public.payment_allocations (
  payment_id      uuid not null references public.payments(id) on delete cascade,
  invoice_item_id uuid not null references public.invoice_items(id) on delete cascade,
  primary key (payment_id, invoice_item_id)
);
alter table public.payment_allocations enable row level security;
create policy payment_allocations_read on public.payment_allocations for select to authenticated
  using (exists (select 1 from public.payments p join public.invoices i on i.id = p.invoice_id
                 where p.id = payment_id
                   and app.has_role(i.restaurant_id, array['admin','manager','cashier']::public.app_role[])));

alter table public.refunds
  add column method              public.payment_method,
  add column register_session_id uuid references public.cash_register_sessions(id),
  add column reviewed_at         timestamptz;

alter table public.cash_register_sessions
  add column reviewed_at  timestamptz,
  add column review_notes text;
-- A cashier runs one register at a time.
create unique index register_one_open_per_user
  on public.cash_register_sessions (opened_by) where closed_at is null;

alter table public.table_sessions add column bill_requested_at timestamptz;

-- ---------------------------------------------------------------------------
-- Status of an invoice from its money (PRD 5.3)
-- ---------------------------------------------------------------------------
create or replace function app.refresh_invoice_status(p_invoice uuid)
returns public.invoice_status
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.invoices;
  s public.invoice_status;
begin
  select * into v from public.invoices where id = p_invoice for update;
  if v.status = 'void' then
    return v.status;
  end if;
  s := case
    when exists (select 1 from public.refunds where invoice_id = p_invoice and status = 'pending') then 'refund_pending'
    when v.amount_refunded > 0 and v.amount_refunded >= v.amount_paid then 'refunded'
    when v.amount_refunded > 0 then 'partially_refunded'
    when v.finalized_at is not null and v.amount_paid >= v.total then 'paid'
    when v.amount_paid > 0 then 'partially_paid'
    when exists (select 1 from public.payments where invoice_id = p_invoice and status = 'failed') then 'payment_failed'
    else 'unpaid'
  end;
  if s is distinct from v.status then
    update public.invoices set status = s where id = p_invoice;
  end if;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rebuild a draft invoice from the session's orders (FR-093, FR-094, BR-012).
-- Totals: subtotal − discounts + exclusive taxes + service charges.
-- Discounts are spread across lines in proportion before tax.
-- Finalized and void invoices are never touched (FR-097).
-- ---------------------------------------------------------------------------
create or replace function app.recompute_invoice(p_invoice uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inv     public.invoices;
  v_default uuid;
  v_sub     numeric(12,2);
  v_disc    numeric(12,2) := 0;
  v_app     record;
  v_amt     numeric(12,2);
  v_base    numeric(12,2);
  v_qty     int;
  v_min     numeric(12,2);
  v_factor  numeric;
  v_taxes   jsonb;
  v_tax     numeric(12,2);
  v_charges jsonb;
  v_svc     numeric(12,2);
begin
  select * into v_inv from public.invoices where id = p_invoice for update;
  if v_inv.finalized_at is not null or v_inv.status = 'void' then
    return;
  end if;

  select id into v_default from public.tax_configurations
   where restaurant_id = v_inv.restaurant_id and is_default and is_active limit 1;

  delete from public.invoice_items where invoice_id = p_invoice;
  insert into public.invoice_items (invoice_id, order_item_id, menu_item_id, category_id, description,
                                    quantity, unit_price, line_total, tax_configuration_id, tax_rate, tax_inclusive)
  select p_invoice, oi.id, oi.menu_item_id, mi.category_id,
         oi.item_name_snapshot
           || coalesce(' (' || oi.variation_name_snapshot || ')', '')
           || coalesce(' + ' || (select string_agg(a.name_snapshot, ', ' order by a.name_snapshot)
                                   from public.order_item_add_ons a where a.order_item_id = oi.id), ''),
         oi.quantity, round(oi.line_total / oi.quantity, 2), oi.line_total,
         t.id, coalesce(t.rate_pct, 0), coalesce(t.is_inclusive, false)
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.menu_items mi on mi.id = oi.menu_item_id
    left join public.tax_configurations t
      on t.id = coalesce(mi.tax_configuration_id, v_default) and t.is_active
   where o.session_id = v_inv.session_id
     and oi.status <> 'cancelled'
     and o.status not in ('pending_confirmation', 'on_hold', 'rejected', 'cancelled');

  select coalesce(sum(line_total), 0) into v_sub from public.invoice_items where invoice_id = p_invoice;

  -- Discounts (FR-152), in the order they were applied.
  for v_app in
    select da.id, da.discount_id, da.kind, da.value,
           d.type as d_type, d.value as d_value, d.scope, d.target_item_id, d.target_category_id, d.min_order_amount
      from public.discount_applications da
      left join public.discounts d on d.id = da.discount_id
     where da.invoice_id = p_invoice
     order by da.created_at, da.id
  loop
    if v_app.discount_id is null then
      v_amt := case when v_app.kind = 'percentage' then round(v_sub * v_app.value / 100, 2) else v_app.value end;
    elsif v_app.min_order_amount is not null and v_sub < v_app.min_order_amount then
      v_amt := 0;
    else
      select coalesce(sum(line_total), 0), coalesce(sum(quantity), 0), min(unit_price)
        into v_base, v_qty, v_min
        from public.invoice_items
       where invoice_id = p_invoice
         and (v_app.scope = 'order'
              or (v_app.scope = 'item' and menu_item_id = v_app.target_item_id)
              or (v_app.scope = 'category' and category_id = v_app.target_category_id));
      v_amt := case v_app.d_type
        when 'percentage' then round(v_base * v_app.d_value / 100, 2)
        when 'fixed_amount' then case when v_app.scope = 'order' then v_app.d_value else v_app.d_value * v_qty end
        else floor(v_qty / 2.0) * coalesce(v_min, 0)              -- bogo: every second unit free
      end;
      v_amt := least(v_amt, v_base);
    end if;
    v_amt := greatest(least(v_amt, v_sub - v_disc), 0);
    update public.discount_applications set amount = v_amt where id = v_app.id;
    v_disc := v_disc + v_amt;
  end loop;

  v_factor := case when v_sub > 0 then (v_sub - v_disc) / v_sub else 0 end;

  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate', rate, 'inclusive', inclusive, 'amount', amount)
                            order by inclusive, name), '[]'::jsonb),
         coalesce(sum(amount) filter (where not inclusive), 0)
    into v_taxes, v_tax
    from (select t.name, ii.tax_rate as rate, ii.tax_inclusive as inclusive,
                 round(case when ii.tax_inclusive
                            then sum(ii.line_total * v_factor) - sum(ii.line_total * v_factor) / (1 + ii.tax_rate / 100)
                            else sum(ii.line_total * v_factor) * ii.tax_rate / 100 end, 2) as amount
            from public.invoice_items ii
            join public.tax_configurations t on t.id = ii.tax_configuration_id
           where ii.invoice_id = p_invoice and ii.tax_rate > 0
           group by t.id, t.name, ii.tax_rate, ii.tax_inclusive) x;

  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'amount', amt) order by name), '[]'::jsonb),
         coalesce(sum(amt), 0)
    into v_charges, v_svc
    from (select name,
                 case when rate_pct is not null then round((v_sub - v_disc) * rate_pct / 100, 2)
                      else fixed_amount end as amt
            from public.service_charges
           where restaurant_id = v_inv.restaurant_id and is_active and v_sub > 0) s;

  update public.invoices
     set subtotal = v_sub, discount_total = v_disc, tax_total = v_tax, service_charge_total = v_svc,
         total = v_sub - v_disc + v_tax + v_svc, tax_breakdown = v_taxes, charge_breakdown = v_charges
   where id = p_invoice;
  perform app.refresh_invoice_status(p_invoice);
end;
$$;

-- No new orders once the bill is final (void it to reopen).
create or replace function app.block_orders_after_billing()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.invoices
              where session_id = new.session_id and status <> 'void' and finalized_at is not null) then
    raise exception 'bill_in_progress' using errcode = 'P0001',
      hint = 'The bill for this table is already final. A manager can void it to add more orders.';
  end if;
  return new;
end;
$$;
create trigger block_after_billing before insert on public.orders
  for each row execute function app.block_orders_after_billing();

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
-- Creates (or refreshes) the session's draft invoice. Waiters may start billing.
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
  perform app.recompute_invoice(v_id);

  if v_session.status in ('open', 'active') then
    update public.table_sessions set status = 'billing' where id = p_session_id;
  end if;
  update public.restaurant_tables set status = 'billing'
   where id = v_session.table_id and status in ('occupied', 'ordering');
  return v_id;
end;
$$;

create or replace function app.finalize_invoice(p_invoice uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.invoices;
begin
  select * into v from public.invoices where id = p_invoice for update;
  if v.finalized_at is not null then
    return;
  end if;
  if exists (select 1 from public.orders
              where session_id = v.session_id and status in ('pending_confirmation', 'on_hold')) then
    raise exception 'orders_pending' using errcode = 'P0001',
      hint = 'Confirm, reject or cancel the waiting orders before finalizing the bill.';
  end if;
  perform app.recompute_invoice(p_invoice);
  if (select count(*) from public.invoice_items where invoice_id = p_invoice) = 0 then
    raise exception 'invoice_empty' using errcode = 'P0001';
  end if;
  update public.invoices set finalized_at = now(), finalized_by = auth.uid() where id = p_invoice;
  perform app.refresh_invoice_status(p_invoice);
end;
$$;

create or replace function public.finalize_invoice(p_invoice_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.invoices;
begin
  select * into v from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  if v.status = 'void' then
    raise exception 'invoice_void' using errcode = 'P0001';
  end if;
  perform app.finalize_invoice(p_invoice_id);
end;
$$;

-- Managers can void an invoice that has no money on it, reopening the table.
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v       public.invoices;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  select * into v from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v.restaurant_id, array['admin','manager']::public.app_role[]);
  if v.status = 'void' then
    raise exception 'invoice_void' using errcode = 'P0001';
  end if;
  if v.amount_paid - v.amount_refunded > 0
     or exists (select 1 from public.refunds where invoice_id = p_invoice_id and status = 'pending') then
    raise exception 'invoice_has_payments' using errcode = 'P0001',
      hint = 'Refund the payments first.';
  end if;
  update public.invoices set status = 'void', void_reason = left(v_reason, 500), voided_by = auth.uid()
   where id = p_invoice_id;
  -- Release coupon uses.
  update public.discounts d set used_count = greatest(used_count - 1, 0)
    from public.discount_applications da
   where da.invoice_id = p_invoice_id and da.discount_id = d.id;
  update public.table_sessions set status = 'active'
   where id = v.session_id and status in ('billing', 'payment_pending');
  update public.restaurant_tables t set status = 'occupied'
    from public.table_sessions s
   where s.id = v.session_id and t.id = s.table_id and t.status = 'billing';
end;
$$;

-- ---------------------------------------------------------------------------
-- Discounts (FR-095, FR-151..154, BR-016)
-- ---------------------------------------------------------------------------
create or replace function app.require_draft(p_invoice uuid)
returns public.invoices
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.invoices;
begin
  select * into v from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  if v.status = 'void' then
    raise exception 'invoice_void' using errcode = 'P0001';
  end if;
  if v.finalized_at is not null then
    raise exception 'invoice_finalized' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

create or replace function public.apply_manual_discount(
  p_invoice_id uuid,
  p_kind       public.discount_type,
  p_value      numeric,
  p_reason     text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v        public.invoices := app.require_draft(p_invoice_id);
  v_limit  numeric;
  v_pct    numeric;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_mgr    boolean := app.has_role(v.restaurant_id, array['admin','manager']::public.app_role[]);
begin
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  if p_kind not in ('percentage', 'fixed_amount') or p_value is null or p_value <= 0
     or (p_kind = 'percentage' and p_value > 100) or p_value <> round(p_value, 2) then
    raise exception 'invalid_discount' using errcode = 'P0001';
  end if;
  perform app.recompute_invoice(p_invoice_id);
  select * into v from public.invoices where id = p_invoice_id;

  select manager_discount_limit_pct into v_limit from public.restaurant_settings where restaurant_id = v.restaurant_id;
  -- Size of this discount plus the ones already on the bill, as % of the subtotal.
  v_pct := case when v.subtotal > 0
                then (v.discount_total + case when p_kind = 'percentage' then v.subtotal * p_value / 100 else p_value end)
                     * 100 / v.subtotal
                else 100 end;
  if v_pct > coalesce(v_limit, 0) and not v_mgr then
    raise exception 'discount_needs_manager' using errcode = '42501',
      hint = 'Discounts above ' || coalesce(v_limit, 0) || '% need a manager.';
  end if;

  insert into public.discount_applications (invoice_id, kind, value, amount, reason, applied_by, approved_by)
  values (p_invoice_id, p_kind, p_value, 0, left(v_reason, 500), auth.uid(),
          case when v_mgr then auth.uid() end);
  perform app.recompute_invoice(p_invoice_id);
end;
$$;

create or replace function public.apply_coupon(p_invoice_id uuid, p_code text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v     public.invoices := app.require_draft(p_invoice_id);
  d     public.discounts;
  v_tz  text;
  v_now timestamp;
begin
  select * into d from public.discounts
   where restaurant_id = v.restaurant_id and upper(code) = upper(trim(coalesce(p_code, ''))) and code is not null
   for update;
  if not found or not d.is_active then
    raise exception 'coupon_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.discount_applications where invoice_id = p_invoice_id and discount_id = d.id) then
    raise exception 'coupon_already_applied' using errcode = 'P0001';
  end if;
  select timezone into v_tz from public.restaurants where id = v.restaurant_id;
  v_now := now() at time zone v_tz;

  if (d.starts_at is not null and now() < d.starts_at) or (d.ends_at is not null and now() > d.ends_at) then
    raise exception 'coupon_expired' using errcode = 'P0001';
  end if;
  if d.active_days is not null and cardinality(d.active_days) > 0
     and not (extract(dow from v_now)::int = any (d.active_days)) then
    raise exception 'coupon_not_today' using errcode = 'P0001';
  end if;
  if d.start_time is not null and d.end_time is not null
     and not (v_now::time between d.start_time and d.end_time) then
    raise exception 'coupon_not_now' using errcode = 'P0001';
  end if;
  if d.max_uses is not null and d.used_count >= d.max_uses then
    raise exception 'coupon_used_up' using errcode = 'P0001';
  end if;
  perform app.recompute_invoice(p_invoice_id);
  if d.min_order_amount is not null and (select subtotal from public.invoices where id = p_invoice_id) < d.min_order_amount then
    raise exception 'coupon_minimum_not_met' using errcode = 'P0001';
  end if;

  insert into public.discount_applications (discount_id, invoice_id, amount, reason, applied_by)
  values (d.id, p_invoice_id, 0, 'Coupon ' || upper(d.code), auth.uid());
  update public.discounts set used_count = used_count + 1 where id = d.id;
  perform app.recompute_invoice(p_invoice_id);
end;
$$;

create or replace function public.remove_discount(p_application_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  a public.discount_applications;
  v public.invoices;
begin
  select * into a from public.discount_applications where id = p_application_id;
  if not found or a.invoice_id is null then
    raise exception 'discount_not_found' using errcode = 'P0002';
  end if;
  v := app.require_draft(a.invoice_id);
  delete from public.discount_applications where id = p_application_id;
  if a.discount_id is not null then
    update public.discounts set used_count = greatest(used_count - 1, 0) where id = a.discount_id;
  end if;
  perform app.recompute_invoice(a.invoice_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cash registers (FR-115..120)
-- ---------------------------------------------------------------------------
create or replace function public.open_register_session(p_register_id uuid, p_opening_balance numeric)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  r    public.cash_registers;
  v_id uuid;
begin
  select * into r from public.cash_registers where id = p_register_id;
  if not found then
    raise exception 'register_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(r.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  if not r.is_active then
    raise exception 'register_inactive' using errcode = 'P0001';
  end if;
  if p_opening_balance is null or p_opening_balance < 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cash_register_sessions where register_id = p_register_id and closed_at is null) then
    raise exception 'register_in_use' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cash_register_sessions where opened_by = auth.uid() and closed_at is null) then
    raise exception 'register_already_open' using errcode = 'P0001';
  end if;
  insert into public.cash_register_sessions (register_id, opened_by, opening_balance)
  values (p_register_id, auth.uid(), round(p_opening_balance, 2))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function app.expected_cash(p_register_session uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select s.opening_balance
       + coalesce((select sum(amount) from public.payments
                    where register_session_id = s.id and method = 'cash' and status = 'succeeded'), 0)
       - coalesce((select sum(amount) from public.refunds
                    where register_session_id = s.id and method = 'cash' and status = 'approved'), 0)
    from public.cash_register_sessions s where s.id = p_register_session;
$$;

create or replace function public.close_register_session(p_session_id uuid, p_counted_cash numeric, p_notes text default null)
returns public.cash_register_sessions
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.cash_register_sessions;
  r public.cash_registers;
  v_expected numeric(12,2);
begin
  select * into s from public.cash_register_sessions where id = p_session_id for update;
  if not found then
    raise exception 'register_session_not_found' using errcode = 'P0002';
  end if;
  select * into r from public.cash_registers where id = s.register_id;
  perform app.require_role(r.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  if s.opened_by <> auth.uid() and not app.has_role(r.restaurant_id, array['admin','manager']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if s.closed_at is not null then
    raise exception 'register_session_closed' using errcode = 'P0001';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  v_expected := app.expected_cash(p_session_id);
  update public.cash_register_sessions
     set closed_at = now(), closed_by = auth.uid(), counted_cash = round(p_counted_cash, 2),
         expected_cash = v_expected, discrepancy = round(p_counted_cash, 2) - v_expected,
         notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_session_id
  returning * into s;

  if s.discrepancy <> 0 then
    perform app.notify(r.restaurant_id, 'register.discrepancy',
      'Cash difference · ' || r.name,
      'Counted ' || s.counted_cash || ', expected ' || s.expected_cash || ' (' || s.discrepancy || ')',
      jsonb_build_object('register_session_id', s.id), null, null,
      app.role_user_ids(r.restaurant_id, array['manager']::public.app_role[]));
  end if;
  return s;
end;
$$;

create or replace function public.review_register_session(p_session_id uuid, p_notes text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.cash_register_sessions;
  r public.cash_registers;
begin
  select * into s from public.cash_register_sessions where id = p_session_id for update;
  if not found then
    raise exception 'register_session_not_found' using errcode = 'P0002';
  end if;
  select * into r from public.cash_registers where id = s.register_id;
  perform app.require_role(r.restaurant_id, array['admin','manager']::public.app_role[]);
  if s.closed_at is null then
    raise exception 'register_session_open' using errcode = 'P0001';
  end if;
  update public.cash_register_sessions
     set reviewed_by = auth.uid(), reviewed_at = now(), review_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_session_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payments (FR-100..110, FR-114, BR-013, BR-014, NFR-015)
--
-- p_invoice_item_ids: pay for specific lines ("split by items"); the amount is
-- then their share of the total (incl. tax, service and discounts).
-- p_failed: record a declined card etc. — it never counts as paid.
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
  p_invoice_id       uuid,
  p_method           public.payment_method,
  p_idempotency_key  uuid,
  p_amount           numeric default null,
  p_reference        text default null,
  p_tendered         numeric default null,
  p_invoice_item_ids uuid[] default null,
  p_payer_label      text default null,
  p_failed           boolean default false,
  p_failure_reason   text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v           public.invoices;
  v_existing  public.payments;
  v_outstand  numeric(12,2);
  v_amount    numeric(12,2);
  v_register  uuid;
  v_change    numeric(12,2);
  v_payment   uuid;
  v_status    public.invoice_status;
  v_count     int;
  v_remaining int;
begin
  if p_idempotency_key is null then
    raise exception 'invalid_payment' using errcode = 'P0001';
  end if;
  select * into v_existing from public.payments where idempotency_key = p_idempotency_key;
  if found then
    select * into v from public.invoices where id = v_existing.invoice_id;
    return jsonb_build_object('payment_id', v_existing.id, 'amount', v_existing.amount, 'status', v_existing.status,
                              'change', v_existing.change_given, 'invoice_status', v.status,
                              'outstanding', v.total - v.amount_paid, 'duplicate', true);
  end if;

  select * into v from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  perform app.require_role(v.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  if v.status = 'void' then
    raise exception 'invoice_void' using errcode = 'P0001';
  end if;
  perform app.finalize_invoice(p_invoice_id);  -- the first payment freezes the bill
  select * into v from public.invoices where id = p_invoice_id;
  v_outstand := v.total - v.amount_paid;
  if v_outstand <= 0 then
    raise exception 'invoice_already_paid' using errcode = 'P0001';
  end if;

  if p_invoice_item_ids is not null and cardinality(p_invoice_item_ids) > 0 then
    select count(*) into v_count from public.invoice_items ii
     where ii.invoice_id = p_invoice_id and ii.id = any (p_invoice_item_ids)
       and not exists (select 1 from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
                        where pa.invoice_item_id = ii.id and p.status = 'succeeded');
    if v_count <> cardinality(p_invoice_item_ids) then
      raise exception 'items_already_paid' using errcode = 'P0001';
    end if;
    select count(*) into v_remaining from public.invoice_items ii
     where ii.invoice_id = p_invoice_id and not (ii.id = any (p_invoice_item_ids))
       and not exists (select 1 from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
                        where pa.invoice_item_id = ii.id and p.status = 'succeeded');
    if v_remaining = 0 then
      v_amount := v_outstand;  -- last share absorbs rounding
    else
      select round(sum(line_total) * v.total / nullif(v.subtotal, 0), 2) into v_amount
        from public.invoice_items where id = any (p_invoice_item_ids);
      v_amount := least(v_amount, v_outstand);
    end if;
  else
    v_amount := round(coalesce(p_amount, v_outstand), 2);
  end if;

  if v_amount is null or v_amount <= 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  if v_amount > v_outstand then
    raise exception 'amount_exceeds_balance' using errcode = 'P0001',
      detail = 'Outstanding: ' || v_outstand;
  end if;

  if p_method = 'cash' then
    select id into v_register from public.cash_register_sessions
     where opened_by = auth.uid() and closed_at is null;
    if v_register is null and not p_failed then
      raise exception 'register_not_open' using errcode = 'P0001',
        hint = 'Open a cash register session before taking cash.';
    end if;
    if p_tendered is not null then
      if p_tendered < v_amount then
        raise exception 'tendered_too_low' using errcode = 'P0001';
      end if;
      v_change := round(p_tendered - v_amount, 2);
    end if;
  end if;

  insert into public.payments (invoice_id, amount, method, status, reference, idempotency_key, received_by,
                               register_session_id, tendered, change_given, payer_label, failure_reason)
  values (p_invoice_id, v_amount, p_method,
          case when p_failed then 'failed'::public.payment_txn_status else 'succeeded'::public.payment_txn_status end,
          nullif(left(trim(coalesce(p_reference, '')), 120), ''), p_idempotency_key, auth.uid(),
          v_register, case when p_method = 'cash' then round(p_tendered, 2) end, v_change,
          nullif(left(trim(coalesce(p_payer_label, '')), 60), ''),
          case when p_failed then coalesce(nullif(trim(p_failure_reason), ''), 'Declined') end)
  returning id into v_payment;

  if p_failed then
    v_status := app.refresh_invoice_status(p_invoice_id);
    return jsonb_build_object('payment_id', v_payment, 'amount', v_amount, 'status', 'failed',
                              'invoice_status', v_status, 'outstanding', v_outstand, 'duplicate', false);
  end if;

  if p_invoice_item_ids is not null and cardinality(p_invoice_item_ids) > 0 then
    insert into public.payment_allocations (payment_id, invoice_item_id)
    select v_payment, unnest(p_invoice_item_ids);
  end if;

  update public.invoices set amount_paid = amount_paid + v_amount where id = p_invoice_id;
  v_status := app.refresh_invoice_status(p_invoice_id);

  if v_status = 'paid' then
    update public.orders set status = 'completed'
     where session_id = v.session_id and status = 'served';
  end if;
  update public.table_sessions
     set status = case when v_status = 'paid' then 'billing'::public.session_status else 'payment_pending'::public.session_status end
   where id = v.session_id and status <> 'closed';

  return jsonb_build_object('payment_id', v_payment, 'amount', v_amount, 'status', 'succeeded',
                            'change', v_change, 'invoice_status', v_status,
                            'outstanding', v_outstand - v_amount, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Refunds (FR-111, FR-112, BR-015). Managers approve; their own are immediate.
-- ---------------------------------------------------------------------------
create or replace function app.apply_refund(p_refund uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  f public.refunds;
begin
  select * into f from public.refunds where id = p_refund;
  update public.invoices set amount_refunded = amount_refunded + f.amount where id = f.invoice_id;
  perform app.refresh_invoice_status(f.invoice_id);
end;
$$;

create or replace function public.request_refund(p_payment_id uuid, p_amount numeric, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  p        public.payments;
  v        public.invoices;
  v_used   numeric(12,2);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_mgr    boolean;
  v_reg    uuid;
  v_id     uuid;
begin
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  select * into p from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;
  select * into v from public.invoices where id = p.invoice_id for update;
  perform app.require_role(v.restaurant_id, array['admin','manager','cashier']::public.app_role[]);
  v_mgr := app.has_role(v.restaurant_id, array['admin','manager']::public.app_role[]);
  if p.status <> 'succeeded' then
    raise exception 'payment_not_refundable' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into v_used from public.refunds
   where payment_id = p_payment_id and status in ('pending', 'approved');
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) > p.amount - v_used then
    raise exception 'refund_exceeds_payment' using errcode = 'P0001',
      detail = 'Refundable: ' || (p.amount - v_used);
  end if;
  if p.method = 'cash' then
    select id into v_reg from public.cash_register_sessions where opened_by = auth.uid() and closed_at is null;
    if v_reg is null then
      raise exception 'register_not_open' using errcode = 'P0001';
    end if;
  end if;

  insert into public.refunds (payment_id, invoice_id, amount, reason, status, requested_by, approved_by,
                              reviewed_at, method, register_session_id)
  values (p_payment_id, p.invoice_id, round(p_amount, 2), left(v_reason, 500),
          case when v_mgr then 'approved'::public.approval_status else 'pending'::public.approval_status end,
          auth.uid(), case when v_mgr then auth.uid() end, case when v_mgr then now() end,
          p.method, v_reg)
  returning id into v_id;

  if v_mgr then
    perform app.apply_refund(v_id);
    return 'approved';
  end if;
  perform app.refresh_invoice_status(p.invoice_id);
  perform app.notify(v.restaurant_id, 'refund.requested', 'Refund needs approval · ' || v.invoice_number,
    round(p_amount, 2) || ' — ' || v_reason, jsonb_build_object('refund_id', v_id, 'invoice_id', v.id),
    null, v.session_id, app.role_user_ids(v.restaurant_id, array['manager','admin']::public.app_role[]));
  return 'pending';
end;
$$;

create or replace function public.review_refund(p_refund_id uuid, p_approve boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  f public.refunds;
  v public.invoices;
begin
  select * into f from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund_not_found' using errcode = 'P0002';
  end if;
  select * into v from public.invoices where id = f.invoice_id for update;
  perform app.require_role(v.restaurant_id, array['admin','manager']::public.app_role[]);
  if f.status <> 'pending' then
    raise exception 'request_already_reviewed' using errcode = 'P0001';
  end if;
  update public.refunds
     set status = case when p_approve then 'approved'::public.approval_status else 'denied'::public.approval_status end,
         approved_by = auth.uid(), reviewed_at = now()
   where id = p_refund_id;
  if p_approve then
    perform app.apply_refund(p_refund_id);
  else
    perform app.refresh_invoice_status(f.invoice_id);
  end if;
  perform app.notify(v.restaurant_id, 'refund.reviewed',
    'Refund ' || case when p_approve then 'approved' else 'denied' end || ' · ' || v.invoice_number,
    f.amount::text, jsonb_build_object('refund_id', f.id), null, v.session_id, array[f.requested_by]);
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer asks for the bill (workflow 6.4 step 1)
-- ---------------------------------------------------------------------------
create or replace function public.request_bill(p_session_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.table_sessions;
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
  -- Repeated taps within two minutes don't notify again (FR-090).
  if s.bill_requested_at is not null and s.bill_requested_at > now() - interval '2 minutes' then
    return;
  end if;
  update public.table_sessions set bill_requested_at = now() where id = p_session_id;
  perform app.notify(s.restaurant_id, 'bill.requested', 'Bill requested · ' || app.table_label(s.table_id),
    'The customer would like to pay.', jsonb_build_object('session_id', s.id), null, s.id,
    coalesce(app.table_waiter_user_ids(s.table_id), '{}')
      || coalesce(app.role_user_ids(s.restaurant_id, array['cashier']::public.app_role[]), '{}'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Digital receipt by token (FR-099). Called by the server with the service role.
-- ---------------------------------------------------------------------------
create or replace function public.get_receipt(p_token text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'invoice', jsonb_build_object(
      'invoice_number', i.invoice_number, 'status', i.status, 'subtotal', i.subtotal,
      'discount_total', i.discount_total, 'tax_total', i.tax_total,
      'service_charge_total', i.service_charge_total, 'total', i.total,
      'amount_paid', i.amount_paid, 'amount_refunded', i.amount_refunded,
      'tax_breakdown', i.tax_breakdown, 'charge_breakdown', i.charge_breakdown,
      'finalized_at', i.finalized_at, 'created_at', i.created_at),
    'restaurant', jsonb_build_object('name', r.name, 'address', r.address, 'phone', r.phone,
                                     'email', r.email, 'currency', r.currency, 'timezone', r.timezone),
    'table', t.table_number,
    'items', coalesce((select jsonb_agg(jsonb_build_object('description', ii.description, 'quantity', ii.quantity,
                                                           'unit_price', ii.unit_price, 'line_total', ii.line_total)
                                        order by ii.description)
                         from public.invoice_items ii where ii.invoice_id = i.id), '[]'::jsonb),
    'discounts', coalesce((select jsonb_agg(jsonb_build_object('reason', da.reason, 'amount', da.amount))
                             from public.discount_applications da where da.invoice_id = i.id and da.amount > 0), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', p.method, 'amount', p.amount,
                                                              'payer', p.payer_label, 'change', p.change_given,
                                                              'at', p.created_at) order by p.created_at)
                            from public.payments p where p.invoice_id = i.id and p.status = 'succeeded'), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('amount', f.amount, 'at', f.created_at))
                           from public.refunds f where f.invoice_id = i.id and f.status = 'approved'), '[]'::jsonb))
  from public.invoices i
  join public.restaurants r on r.id = i.restaurant_id
  join public.table_sessions s on s.id = i.session_id
  join public.restaurant_tables t on t.id = s.table_id
  where i.receipt_token = p_token and i.finalized_at is not null and i.status <> 'void';
$$;

-- ---------------------------------------------------------------------------
-- close_table_session: "paid" now means a final invoice whose payments cover
-- its total (a pending refund no longer blocks closing the table).
-- ---------------------------------------------------------------------------
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
    and (v_invoice.id is null or v_invoice.finalized_at is null or v_invoice.amount_paid < v_invoice.total);

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
  public.cancel_order_item(uuid, text), public.review_cancellation(uuid, boolean),
  public.generate_invoice(uuid), public.finalize_invoice(uuid), public.void_invoice(uuid, text),
  public.apply_manual_discount(uuid, public.discount_type, numeric, text), public.apply_coupon(uuid, text),
  public.remove_discount(uuid),
  public.open_register_session(uuid, numeric), public.close_register_session(uuid, numeric, text),
  public.review_register_session(uuid, text),
  public.record_payment(uuid, public.payment_method, uuid, numeric, text, numeric, uuid[], text, boolean, text),
  public.request_refund(uuid, numeric, text), public.review_refund(uuid, boolean),
  public.request_bill(uuid)
to authenticated;
-- Only the server (service role) reads receipts; Supabase grants new functions to
-- authenticated by default, so remove that explicitly.
revoke execute on function public.get_receipt(text) from authenticated;
grant execute on function public.get_receipt(text) to service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payments, public.refunds;
  end if;
end $$;

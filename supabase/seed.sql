-- Demo data. Runs after migrations on `supabase db reset` (and in the local test harness).
-- Staff accounts are created with `npm run create-admin` (they need real auth users).

insert into public.restaurants (id, name, slug, description, address, phone, currency, timezone)
values ('11111111-1111-1111-1111-111111111111', 'Demo Bistro', 'demo-bistro',
        'Burgers, pizza and good coffee.', '1 Main Street', '+1 555 0100', 'USD', 'UTC');

update public.restaurant_settings
   set customer_can_open_session = false, require_cleaning = true
 where restaurant_id = '11111111-1111-1111-1111-111111111111';

insert into public.tax_configurations (restaurant_id, name, rate_pct, is_default)
values ('11111111-1111-1111-1111-111111111111', 'Sales tax', 8.00, true);

insert into public.service_charges (restaurant_id, name, rate_pct)
values ('11111111-1111-1111-1111-111111111111', 'Service charge', 5.00);

insert into public.kitchen_stations (id, restaurant_id, name, sort_order) values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Grill',    1),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Pizza',    2),
  ('22222222-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Beverage', 3),
  ('22222222-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Dessert',  4);

insert into public.menu_categories (id, restaurant_id, name, sort_order) values
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Burgers',  1),
  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Pizza',    2),
  ('33333333-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Drinks',   3),
  ('33333333-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Desserts', 4);

insert into public.menu_items (id, restaurant_id, category_id, station_id, name, description, base_price, allergens, sort_order) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001',
   'Classic Burger', 'Beef patty, cheddar, lettuce, tomato, house sauce.', 9.50, '{gluten,dairy}', 1),
  ('44444444-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001',
   'Chicken Burger', 'Crispy chicken, slaw, pickles.', 8.75, '{gluten,egg}', 2),
  ('44444444-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002',
   'Margherita', 'Tomato, mozzarella, basil.', 11.00, '{gluten,dairy}', 1),
  ('44444444-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000003',
   'Fresh Lemonade', 'Squeezed to order.', 3.50, '{}', 1),
  ('44444444-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000004',
   'Chocolate Brownie', 'Warm, with vanilla ice cream.', 5.25, '{gluten,dairy,egg}', 1);

insert into public.item_variations (item_id, name, price_delta, is_default, sort_order) values
  ('44444444-0000-0000-0000-000000000001', 'Regular', 0,    true,  1),
  ('44444444-0000-0000-0000-000000000001', 'Large',   2.50, false, 2),
  ('44444444-0000-0000-0000-000000000003', 'Small',   -2.00, false, 1),
  ('44444444-0000-0000-0000-000000000003', 'Medium',  0,    true,  2),
  ('44444444-0000-0000-0000-000000000003', 'Large',   3.00, false, 3);

insert into public.add_on_groups (id, restaurant_id, name, min_select, max_select) values
  ('55555555-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Burger extras', 0, 3),
  ('55555555-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Pizza toppings', 0, 5);

insert into public.add_ons (group_id, name, price, sort_order) values
  ('55555555-0000-0000-0000-000000000001', 'Extra cheese', 1.00, 1),
  ('55555555-0000-0000-0000-000000000001', 'Extra patty',  3.00, 2),
  ('55555555-0000-0000-0000-000000000001', 'No onions',    0,    3),
  ('55555555-0000-0000-0000-000000000002', 'Mushrooms',    1.25, 1),
  ('55555555-0000-0000-0000-000000000002', 'Olives',       1.25, 2),
  ('55555555-0000-0000-0000-000000000002', 'Pepperoni',    2.00, 3);

insert into public.item_add_on_groups (item_id, group_id) values
  ('44444444-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001'),
  ('44444444-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000001'),
  ('44444444-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000002');

insert into public.restaurant_tables (restaurant_id, table_number, name, capacity, location)
select '11111111-1111-1111-1111-111111111111', n::text, 'Table ' || n,
       case when n <= 4 then 2 when n <= 8 then 4 else 6 end,
       case when n <= 6 then 'Main hall' else 'Terrace' end
from generate_series(1, 10) as n;

insert into public.cash_registers (restaurant_id, name)
values ('11111111-1111-1111-1111-111111111111', 'Front counter');

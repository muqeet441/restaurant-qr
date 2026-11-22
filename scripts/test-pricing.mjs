// Checks the cart maths in src/lib/menu.ts against the same example that
// test-db.mjs runs through submit_order (35.50 subtotal).
//   npm run test:pricing
import assert from "node:assert/strict";
import { cartTotals, unitPrice, validateSelection } from "../src/lib/menu.ts";

const burger = {
  id: "burger", category_id: "c", name: "Classic Burger", description: null, base_price: 9.5,
  is_available: true, allergens: [], dietary_tags: [], tax_configuration_id: null, image_path: null,
  variations: [
    { id: "regular", item_id: "burger", name: "Regular", price_delta: 0, is_default: true, is_active: true, sort_order: 1 },
    { id: "large", item_id: "burger", name: "Large", price_delta: 2.5, is_default: false, is_active: true, sort_order: 2 },
  ],
  groups: [{
    id: "extras", name: "Burger extras", min_select: 0, max_select: 2,
    add_ons: [
      { id: "cheese", group_id: "extras", name: "Extra cheese", price: 1, is_active: true, sort_order: 1 },
      { id: "patty", group_id: "extras", name: "Extra patty", price: 3, is_active: true, sort_order: 2 },
      { id: "onions", group_id: "extras", name: "No onions", price: 0, is_active: true, sort_order: 3 },
    ],
  }],
};
const lemonade = { ...burger, id: "lemonade", name: "Lemonade", base_price: 3.5, variations: [], groups: [] };
const items = new Map([[burger.id, burger], [lemonade.id, lemonade]]);
const lines = [
  { key: "1", menu_item_id: "burger", variation_id: "large", add_on_ids: ["cheese", "patty"], quantity: 2, special_instructions: "" },
  { key: "2", menu_item_id: "lemonade", variation_id: null, add_on_ids: [], quantity: 1, special_instructions: "" },
];

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok   ${name}`); };

ok("unit price = base + option + extras", () => assert.equal(unitPrice(burger, lines[0]), 16));
ok("subtotal matches submit_order (35.50)", () =>
  assert.equal(cartTotals(lines, items, [], []).subtotal, 35.5));
ok("exclusive tax and service charge are added", () => {
  const t = cartTotals(lines, items,
    [{ id: "tax", name: "Sales tax", rate_pct: 8, is_inclusive: false, is_default: true }],
    [{ id: "svc", name: "Service", rate_pct: 5, fixed_amount: null }]);
  assert.equal(t.taxes[0].amount, 2.84);
  assert.equal(t.charges[0].amount, 1.78);
  assert.equal(t.total, 40.12);
});
ok("inclusive tax is shown but not added", () => {
  const t = cartTotals(lines, items, [{ id: "vat", name: "VAT", rate_pct: 20, is_inclusive: true, is_default: true }], []);
  assert.equal(t.taxes[0].amount, 5.92);
  assert.equal(t.total, 35.5);
});
ok("item-specific tax overrides the default", () => {
  const taxed = new Map(items);
  taxed.set("lemonade", { ...lemonade, tax_configuration_id: "zero" });
  const t = cartTotals(lines, taxed, [
    { id: "std", name: "Standard", rate_pct: 10, is_inclusive: false, is_default: true },
    { id: "zero", name: "Zero", rate_pct: 0, is_inclusive: false, is_default: false },
  ], []);
  assert.equal(t.taxes.find((x) => x.name === "Standard").amount, 3.2);
});
ok("option is required when the item has options", () =>
  assert.match(validateSelection(burger, { variation_id: null, add_on_ids: [] }), /Choose an option/));
ok("group maximum enforced", () =>
  assert.match(validateSelection(burger, { variation_id: "large", add_on_ids: ["cheese", "patty", "onions"] }), /at most 2/));
ok("group minimum enforced", () => {
  const strict = { ...burger, groups: [{ ...burger.groups[0], min_select: 1 }] };
  assert.match(validateSelection(strict, { variation_id: "large", add_on_ids: [] }), /at least 1/);
});
ok("valid selection passes", () =>
  assert.equal(validateSelection(burger, { variation_id: "regular", add_on_ids: ["onions"] }), null));

console.log(`\n${n} passed`);

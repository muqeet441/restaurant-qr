// Menu shapes shared by the admin and customer screens, plus the cart price
// maths. The database recomputes every price on submission (submit_order);
// these numbers are only for display.

export interface Variation {
  id: string;
  item_id: string;
  name: string;
  price_delta: number;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface AddOn {
  id: string;
  group_id: string;
  name: string;
  price: number;
  is_active: boolean;
  sort_order: number;
}

export interface AddOnGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number | null;
  add_ons: AddOn[];
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  base_price: number;
  is_available: boolean;
  allergens: string[];
  dietary_tags: string[];
  tax_configuration_id: string | null;
  image_path: string | null;
  variations: Variation[];
  groups: AddOnGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  items: MenuItem[];
}

export interface Tax {
  id: string;
  name: string;
  rate_pct: number;
  is_inclusive: boolean;
  is_default: boolean;
}

export interface Charge {
  id: string;
  name: string;
  rate_pct: number | null;
  fixed_amount: number | null;
}

export interface CartLine {
  key: string; // local id for editing/removing
  menu_item_id: string;
  variation_id: string | null;
  add_on_ids: string[];
  quantity: number;
  special_instructions: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function unitPrice(item: MenuItem, line: Pick<CartLine, "variation_id" | "add_on_ids">): number {
  const variation = item.variations.find((v) => v.id === line.variation_id);
  const base = Math.max(Number(item.base_price) + Number(variation?.price_delta ?? 0), 0);
  const addOns = item.groups
    .flatMap((g) => g.add_ons)
    .filter((a) => line.add_on_ids.includes(a.id))
    .reduce((sum, a) => sum + Number(a.price), 0);
  return round2(base + addOns);
}

/** Problems that would make submit_order reject this configuration. */
export function validateSelection(item: MenuItem, line: Pick<CartLine, "variation_id" | "add_on_ids">): string | null {
  const activeVariations = item.variations.filter((v) => v.is_active);
  if (activeVariations.length && !activeVariations.some((v) => v.id === line.variation_id)) {
    return "Choose an option.";
  }
  for (const g of item.groups) {
    const n = g.add_ons.filter((a) => line.add_on_ids.includes(a.id)).length;
    if (n < g.min_select) return `Choose at least ${g.min_select} from ${g.name}.`;
    if (g.max_select != null && n > g.max_select) return `Choose at most ${g.max_select} from ${g.name}.`;
  }
  return null;
}

export interface CartTotals {
  subtotal: number;
  taxes: { name: string; amount: number; inclusive: boolean }[];
  charges: { name: string; amount: number }[];
  total: number;
}

/**
 * Estimated bill (FR-020..022). Exclusive taxes and service charges are
 * added; inclusive taxes are shown but already part of the prices.
 */
export function cartTotals(
  lines: CartLine[],
  items: Map<string, MenuItem>,
  taxes: Tax[],
  charges: Charge[],
): CartTotals {
  const defaultTax = taxes.find((t) => t.is_default);
  const taxBase = new Map<string, number>();
  let subtotal = 0;

  for (const line of lines) {
    const item = items.get(line.menu_item_id);
    if (!item) continue;
    const amount = unitPrice(item, line) * line.quantity;
    subtotal += amount;
    const taxId = item.tax_configuration_id ?? defaultTax?.id;
    if (taxId) taxBase.set(taxId, (taxBase.get(taxId) ?? 0) + amount);
  }

  const taxLines = taxes
    .filter((t) => taxBase.has(t.id))
    .map((t) => {
      const base = taxBase.get(t.id)!;
      const rate = Number(t.rate_pct) / 100;
      const amount = t.is_inclusive ? base - base / (1 + rate) : base * rate;
      return { name: t.name, amount: round2(amount), inclusive: t.is_inclusive };
    });
  const chargeLines = charges.map((c) => ({
    name: c.name,
    amount: round2(c.rate_pct != null ? (subtotal * Number(c.rate_pct)) / 100 : Number(c.fixed_amount ?? 0)),
  }));

  const total =
    subtotal +
    taxLines.filter((t) => !t.inclusive).reduce((s, t) => s + t.amount, 0) +
    chargeLines.reduce((s, c) => s + c.amount, 0);

  return { subtotal: round2(subtotal), taxes: taxLines, charges: chargeLines, total: round2(total) };
}

export function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/menu-images/${path}`;
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_confirmation: "Waiting for waiter",
  on_hold: "Waiter has a question",
  confirmed: "Confirmed",
  sent_to_kitchen: "Sent to kitchen",
  preparing: "Preparing",
  partially_ready: "Partly ready",
  ready: "Ready",
  partially_served: "Partly served",
  served: "Served",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

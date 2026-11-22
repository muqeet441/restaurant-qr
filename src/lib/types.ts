// Hand-written row types for Phase 1. Replace with generated types once the
// Supabase project exists:  npm run gen:types
export type AppRole = "super_admin" | "admin" | "manager" | "waiter" | "kitchen" | "cashier";
export const STAFF_ROLES: Exclude<AppRole, "super_admin">[] = [
  "admin",
  "manager",
  "waiter",
  "kitchen",
  "cashier",
];
export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super admin",
  admin: "Administrator",
  manager: "Manager",
  waiter: "Waiter",
  kitchen: "Kitchen",
  cashier: "Cashier",
};

export type TableStatus = "available" | "reserved" | "occupied" | "ordering" | "billing" | "cleaning";
export type SessionStatus = "open" | "active" | "billing" | "payment_pending" | "closed";

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  currency: string;
  timezone: string;
  logo_path: string | null;
  is_active: boolean;
}

export interface RestaurantSettings {
  restaurant_id: string;
  customer_can_open_session: boolean;
  require_cleaning: boolean;
  pending_order_alert_minutes: number;
  manager_discount_limit_pct: number;
}

export interface TaxConfiguration {
  id: string;
  name: string;
  rate_pct: number;
  is_inclusive: boolean;
  is_default: boolean;
  is_active: boolean;
}

export interface ServiceCharge {
  id: string;
  name: string;
  rate_pct: number | null;
  fixed_amount: number | null;
  is_active: boolean;
}

export interface RestaurantTable {
  id: string;
  restaurant_id: string;
  table_number: string;
  name: string | null;
  capacity: number;
  location: string | null;
  status: TableStatus;
  is_active: boolean;
  qr_token: string | null;
  qr_generated_at: string | null;
}

export interface TableSession {
  id: string;
  table_id: string;
  status: SessionStatus;
  guest_count: number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface Employee {
  id: string;
  restaurant_id: string;
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
}

export interface JoinResult {
  status: "joined" | "waiting_for_staff";
  restaurant: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    address: string | null;
    phone: string | null;
    currency: string;
    logo_path: string | null;
  };
  table: { id: string; table_number: string; name: string | null };
  session?: { id: string; status: SessionStatus; opened_at: string };
}

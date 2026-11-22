// Creates the first administrator for a restaurant (or a global super admin).
//
//   npm run create-admin -- --email you@example.com --password "s3cret-pass" --name "Your Name"
//   npm run create-admin -- ... --restaurant "My Restaurant"     (creates the restaurant)
//   npm run create-admin -- ... --slug demo-bistro                (uses an existing one; default)
//   npm run create-admin -- ... --super                           (global super admin)
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string" },
    restaurant: { type: "string" },
    slug: { type: "string", default: "demo-bistro" },
    super: { type: "boolean", default: false },
  },
});

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) fail("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
if (!args.email || !args.password || !args.name) fail("--email, --password and --name are required");
if (args.password.length < 8) fail("Password must be at least 8 characters");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let restaurant;
if (args.restaurant) {
  const slug = args.restaurant.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const { data, error } = await db
    .from("restaurants")
    .insert({ name: args.restaurant, slug })
    .select()
    .single();
  if (error) fail(`Could not create restaurant: ${error.message}`);
  restaurant = data;
  console.log(`✓ Created restaurant "${restaurant.name}" (${restaurant.slug})`);
} else if (!args.super) {
  const { data, error } = await db.from("restaurants").select().eq("slug", args.slug).maybeSingle();
  if (error || !data) fail(`No restaurant with slug "${args.slug}". Use --restaurant "Name" to create one.`);
  restaurant = data;
}

const { data: created, error: authError } = await db.auth.admin.createUser({
  email: args.email,
  password: args.password,
  email_confirm: true,
  user_metadata: { full_name: args.name },
});
if (authError) fail(`Could not create user: ${authError.message}`);
const userId = created.user.id;

if (restaurant) {
  const { error } = await db.from("employees").insert({
    restaurant_id: restaurant.id,
    user_id: userId,
    full_name: args.name,
    email: args.email,
  });
  if (error) fail(`Could not create employee: ${error.message}`);
}

const { error: roleError } = await db.from("user_roles").insert({
  user_id: userId,
  restaurant_id: args.super ? null : restaurant.id,
  role: args.super ? "super_admin" : "admin",
});
if (roleError) fail(`Could not assign role: ${roleError.message}`);

console.log(
  `✓ ${args.super ? "Super admin" : `Admin of ${restaurant.name}`}: ${args.email}\n  Sign in at /login`,
);

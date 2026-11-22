# Go-live runbook

Follow this top to bottom the first time. Each step says how to check it worked.
Your Supabase project ref: **aylscqybatccypzabxao**.

## 1. Supabase project settings (dashboard)

| Where | Setting | Why |
|---|---|---|
| Authentication → Sign In / Providers | **Allow anonymous sign-ins: ON** | Customers scanning a QR code get an anonymous session. *Currently off.* |
| Authentication → Sign In / Providers → Email | Confirm email: off (staff are created by an admin) | Staff can sign in immediately. |
| Database → Extensions | **pg_cron: enabled** (done) | Stale-order alerts and reservation reminders. |
| Authentication → Attack Protection | Enable CAPTCHA (Turnstile or hCaptcha) | Stops abuse of the anonymous sign-in endpoint. Requires passing the token in `signInAnonymously` — see "Hardening" below. |
| Authentication → Rate Limits | Anonymous sign-ins per hour: 30 per IP (default) is fine for one restaurant | Limits bulk account creation. |

## 2. Push the database

```bash
cd C:\Users\User\restaurant-qr
npx supabase login                                   # opens the browser
npx supabase link --project-ref aylscqybatccypzabxao # asks for the database password
npx supabase db push                                 # applies supabase/migrations/*
```
Add `--include-seed` only if you want the "Demo Bistro" sample restaurant.

**Then** enable the token hook (the function now exists):
Authentication → Hooks → **Customize Access Token (JWT) Claims** → Postgres → schema `public`, function `custom_access_token_hook`.

Check: Database → Tables shows `restaurants`, `orders`, `invoices`, …; Database → Cron Jobs shows
`alert-stale-orders` and `remind-reservations`.

## 3. Keys and first admin

1. Project Settings → API Keys → copy the **secret** (service-role) key into `.env.local` as
   `SUPABASE_SERVICE_ROLE_KEY`. Never paste it into chats, tickets or client code.
2. Create your restaurant and its first administrator:
   ```bash
   npm run create-admin -- --email you@example.com --password "a-long-password" --name "Your Name" --restaurant "Your Restaurant"
   ```

## 4. Verify the live backend

```bash
npm run e2e:live
```
This signs in as test staff and an anonymous customer inside a separate, hidden "E2E check" restaurant
and runs a complete visit: seat → scan → order → confirm → kitchen → serve → bill → cash payment →
receipt → close → clean → register close-out. It also checks Realtime delivery, that customers can't
change prices or read receipts, and API latency (NFR-001). Every line should say `ok`.

## 5. Deploy the app to Vercel

1. Create a GitHub repository and push this folder:
   ```bash
   git remote add origin https://github.com/<you>/restaurant-qr.git
   git push -u origin main
   ```
2. vercel.com → **Add New → Project** → import the repository. Framework: Next.js (auto-detected).
3. Environment variables (Production **and** Preview):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://aylscqybatccypzabxao.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your publishable key (`sb_publishable_…`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | your secret key — mark as **Sensitive** |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-project>.vercel.app` (or your own domain) |

4. Deploy. Then in Supabase **Authentication → URL Configuration** set *Site URL* to the same domain.
5. Open `https://<domain>/login`, sign in, go to **Admin → Tables & QR** and print the QR codes
   **only after** `NEXT_PUBLIC_SITE_URL` points at the final domain — the URL is printed into the code.

**Licence note:** Vercel's free Hobby plan is for non-commercial use. For a live restaurant use
Vercel Pro, or deploy the same repo to Cloudflare Pages / Netlify (no code changes).

## 6. GitHub Actions (optional but recommended)

| Workflow | What it does | Secrets it needs |
|---|---|---|
| `ci.yml` | Tests, type check, lint, build on every push / PR | none |
| `migrate.yml` | After CI passes on `main`, runs `supabase db push` | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` |
| `backup.yml` | Nightly encrypted `pg_dump`, kept 14 days (NFR-016) | `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` |

`migrate.yml` uses a GitHub **environment** called `production`; add a required reviewer there if
you want to approve each migration. Test a restore once: download a backup artifact and run
`gpg -d backup.sql.gz.gpg | gunzip | psql "<a scratch database URL>"`.

## 7. Before opening the doors

- [ ] Run through [UAT.md](UAT.md) with real staff on real devices.
- [ ] Waiter tablets / kitchen screen: open the site, then **Add to Home Screen / Install app**,
      sign in, keep the screen awake, turn the sound on (bell → Sound on).
- [ ] Print QR codes, stick them on tables, scan each one with a phone.
- [ ] Set taxes, service charge, discount limit and time zone in **Admin → Settings**.
- [ ] Open the register with the real float.

## Free-tier limits to watch

| Limit (free) | Typical single restaurant | Where to watch |
|---|---|---|
| Supabase DB 500 MB | ~1–2 KB per order item → years of orders | Supabase → Reports → Database |
| Storage 1 GB | photos are resized to ≤1200 px WebP (~100–200 KB) | Storage |
| Realtime 200 concurrent connections | each open staff screen and customer phone = 1 | Reports → Realtime |
| Realtime 2 M messages / month | ~10–50 per order | Reports → Realtime |
| Project pauses after 7 days idle | not an issue if used daily | — |
| Vercel Hobby: non-commercial | see licence note above | — |

## Hardening after launch

- **CAPTCHA on anonymous sign-in:** add Cloudflare Turnstile to the QR page and pass
  `options: { captchaToken }` to `signInAnonymously()` in `src/app/t/[token]/customer-table.tsx`,
  then enable CAPTCHA in Supabase.
- Rotate the service-role key if it was ever shared.
- Review **Admin → Audit log** weekly and **POS → Cash register** discrepancies daily.
- Supabase → Advisors (Security, Performance) should show no errors.

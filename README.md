# Inventory & Fulfillment Ops Dashboard

A small internal dashboard that will combine **live Shopify** sales data with
**ShipHero** inventory & fulfillment data into one view of inventory and
fulfillment health. Built with Next.js (App Router) + TypeScript + Tailwind,
designed to deploy on Vercel.

> **Current status:** Shopify metrics are **real** (live Admin API). ShipHero
> metrics are **stubbed** with realistic sample data until ShipHero credentials
> are provided. When the ShipHero refresh token is added, the real API turns on
> automatically — the only file that changes is `lib/shiphero.ts`.

---

## Run this locally (step by step)

This assumes you already have **Node.js** installed (version 18.18 or newer —
20+ recommended). If you don't, download the "LTS" version from
<https://nodejs.org> and install it first, then continue.

1. **Open a terminal** and go into this project folder. For example:

   ```bash
   cd operations-dashboard
   ```

2. **Install the dependencies** (only needed the first time, and again if they
   change). This downloads everything the app needs:

   ```bash
   npm install
   ```

3. **Create your settings file.** Copy the example file to `.env.local`:

   ```bash
   cp .env.example .env.local
   ```

   Then open `.env.local` in any text editor and fill in **at least** these
   three values (everything else can stay blank to run on sample ShipHero data):

   - `SHOPIFY_STORE_DOMAIN` — already pre-filled with `2f4a18-f3.myshopify.com`
   - `SHOPIFY_ADMIN_ACCESS_TOKEN` — paste the Shopify Admin API token
   - `DASHBOARD_PASSWORD` — pick any password; this is what you'll type to log in
   - `REFRESH_SECRET` — pick any random string (used to protect the refresh URL)

4. **Start the app:**

   ```bash
   npm run dev
   ```

5. **Open your browser** to <http://localhost:3000>. You'll be asked for the
   password — type the `DASHBOARD_PASSWORD` you chose above. You should then see
   the dashboard, with real stock-velocity numbers from Shopify and a yellow
   "sample ShipHero data" banner (expected until ShipHero credentials are added).

To stop the app, go back to the terminal and press `Ctrl + C`.

---

## What's real vs. stubbed

| Metric | Source | Status |
| --- | --- | --- |
| Sales velocity / units sold (30d) | Shopify Admin API | **Real** |
| Days of stock (uses Shopify velocity) | Shopify + ShipHero | **Real velocity**, stubbed stock |
| Orders created today | Shopify Admin API | **Real** |
| Current stock per SKU (NV / PA / total) | ShipHero | Stubbed |
| Lots per SKU (number, qty, expiration) | ShipHero | Stubbed |
| Orders fulfilled today | ShipHero | Stubbed |
| Orders on hold (total + breakdown) | ShipHero | Stubbed |
| Returns received/processed today | ShipHero | Stubbed |
| New receivals today | ShipHero | Stubbed |

ShipHero metrics switch from stubbed to real automatically once
`SHIPHERO_REFRESH_TOKEN` is set — no code changes beyond that.

---

## Environment variables

Set these in `.env.local` for local development, and later in the Vercel project
settings for production. See `.env.example` for a copy-paste template.

| Variable | Required now? | Purpose |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | **Yes** | The `xxxxx.myshopify.com` domain (NOT the `admin.shopify.com/store/...` URL). |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | **Yes** | Shopify Admin API token. Scopes: `read_products`, `read_orders`. |
| `DASHBOARD_PASSWORD` | **Yes** | Single shared password for the team login. |
| `REFRESH_SECRET` | **Yes** | Shared secret protecting `/api/refresh`. |
| `SHIPHERO_ACCESS_TOKEN` | No | ShipHero access token (optional; app stubs without it). |
| `SHIPHERO_REFRESH_TOKEN` | No | ShipHero refresh token. **Setting this turns on the real ShipHero API.** |
| `CRON_SECRET` | Vercel only | Set equal to `REFRESH_SECRET`; Vercel auto-attaches it to scheduled cron calls. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | No | Auto-injected by Vercel when you connect KV/Upstash. Enables cached snapshots. |

---

## How it works

### Data layer (server-side only — tokens never reach the browser)

- **`lib/shopify.ts`** — produces trailing-30-day units sold per SKU plus
  today's order count. Because this store does ~50k orders/month and Shopify
  rate-limits by *query cost*, it does a one-time historical **backfill via the
  Bulk Operations API**, then **incremental daily syncs** (only new orders),
  storing each day's per-SKU totals as its own KV entry and summing the last 30.
  It reads `extensions.cost` and backs off on `THROTTLED`.
- **`lib/shiphero.ts`** — the **only** file to touch when ShipHero credentials
  arrive. Returns realistic stub data while `SHIPHERO_REFRESH_TOKEN` is unset;
  otherwise resolves warehouse IDs by name, refreshes/caches the access token,
  and queries stock, lots, holds, fulfillments, returns, and receivals.
- **`lib/snapshot.ts`** — combines both sources and applies the metric formulas.

### SKU aggregation

The same physical product is sometimes listed as multiple Shopify
products/variants for A/B testing. **All** Shopify-derived numbers are grouped
and summed by **SKU**, never by `product_id` or `variant_id`, so a SKU's true
sales include every listing selling it.

### Caching

- **With Vercel KV connected:** `/api/refresh` computes the snapshot and stores
  it under `dashboard:snapshot`; the dashboard reads that key.
- **Without KV:** the app falls back to computing fresh on each request, using
  Next's built-in fetch caching with a ~15-minute revalidate window. It works
  correctly either way. KV is **strongly recommended** for this store's volume.

### Auth

One shared password (`DASHBOARD_PASSWORD`). A correct login sets an HTTP-only
session cookie; `middleware.ts` checks it on every route except `/login` and
`/api/login`. `/api/refresh` is gated separately by `REFRESH_SECRET`.

### Scheduling

`vercel.json` defines a **daily** Vercel Cron hitting `/api/refresh` (the
free-tier limit). For more frequent refreshes, use a paid Vercel plan or a free
external pinger (e.g. cron-job.org) calling
`https://<your-app>/api/refresh?secret=<REFRESH_SECRET>`. Details are in the
comment at the top of `app/api/refresh/route.ts`.

---

## Useful commands

```bash
npm install      # install dependencies (first run)
npm run dev      # start the dev server at http://localhost:3000
npm run build    # production build (also type-checks)
npm run start    # run the production build locally
```

---

## Deployment notes

Build and verify on a feature branch first. The app is **not** auto-deployed as
part of this work — pull the branch locally, run `npm run dev`, and confirm it
works in your browser before anything goes live. When deploying to Vercel later,
set the environment variables above in the project settings and (optionally)
connect a KV/Upstash store.

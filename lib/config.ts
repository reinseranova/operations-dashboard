/**
 * Central, easily-bumpable configuration constants.
 *
 * Anything that might need to change later (API versions, warehouse names,
 * cache windows) lives here so there's a single place to edit.
 */

// Current Shopify Admin API stable version. Shopify ships a new dated version
// every quarter (e.g. 2026-07 on 2026-07-01). Bump this single constant to
// move to a newer version. See https://shopify.dev/docs/api/usage/versioning
export const SHOPIFY_API_VERSION = "2026-04";

// ShipHero GraphQL + auth endpoints.
export const SHIPHERO_GRAPHQL_ENDPOINT = "https://public-api.shiphero.com/graphql";
export const SHIPHERO_REFRESH_ENDPOINT = "https://public-api.shiphero.com/auth/refresh";

/**
 * This account has exactly two warehouses. ShipHero warehouse IDs are opaque
 * and not known ahead of time, so we identify warehouses by their human name
 * and resolve the IDs at runtime (see lib/shiphero.ts). `key` is our short
 * internal handle used throughout the UI / metrics.
 */
export const WAREHOUSES = [
  { key: "nv" as const, name: "NV LG Express, Inc. / Primary" },
  { key: "pa" as const, name: "PA LG Express, Inc. / LG Express, Inc. PA" },
];

export type WarehouseKey = (typeof WAREHOUSES)[number]["key"];

// How many trailing days of sales velocity we keep / sum for "days of stock".
export const ROLLING_WINDOW_DAYS = 30;

// Fallback fetch-cache revalidate window (seconds) used when Vercel KV is not
// configured. ~15 minutes per the build spec.
export const FALLBACK_REVALIDATE_SECONDS = 15 * 60;

// KV key names — keep them in one place.
export const KV_KEYS = {
  snapshot: "dashboard:snapshot",
  shopifyMeta: "shopify:meta",
  // Per-day units-sold-by-SKU entries are stored under `shopify:daily:<YYYY-MM-DD>`.
  shopifyDailyPrefix: "shopify:daily:",
  shipheroToken: "shiphero:access_token",
  shipheroWarehouses: "shiphero:warehouse_ids",
};

export function shopifyDailyKey(dateYmd: string): string {
  return `${KV_KEYS.shopifyDailyPrefix}${dateYmd}`;
}

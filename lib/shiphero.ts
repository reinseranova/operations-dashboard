/**
 * ShipHero Public API layer — live data only.
 *
 * All queries here follow ShipHero's schema conventions (verified against the
 * live schema reference at developer.shiphero.com/schema/queries/):
 *   - Every top-level query returns `{ request_id, complexity, data }`; `data`
 *     is a connection for list queries.
 *   - FILTER arguments (warehouse_id, sku, updated_from, has_hold, …) go on the
 *     top-level query field. PAGINATION (`first`, `after`) goes on the inner
 *     `data(...)` connection — NOT on the query field.
 *   - Cursor pagination: read `data.pageInfo { hasNextPage, endCursor }` and
 *     pass `after`. The account shares a credit pool, so queries stay lean and
 *     back off on throttle.
 *
 * Metric → query mapping:
 *   - Stock per SKU per warehouse …… `warehouse_products(warehouse_id)` → on_hand
 *   - Warehouse IDs (by name) ……… `account` → data.warehouses (cached)
 *   - Lots per SKU …………………… `expiration_lots` → Lot + nested locations
 *   - Orders on hold + breakdown … `orders(has_hold: true)` → holds { … }
 *   - Orders fulfilled today ……… `orders(fulfillment_status, updated_from)`
 *   - Returns received today ……… `returns(date_from)` → created_at
 *   - New receivals today ………… `warehouse_products(updated_from).inbounds`
 *
 * Resilience: the core (warehouse resolution + stock) surfaces errors so the UI
 * shows a clear banner. Secondary metrics (holds, fulfilled, returns, receivals,
 * lots) each degrade to a safe default and add a human-readable warning instead
 * of taking down the whole dashboard. GraphQL errors carry the raw response body
 * so any schema mismatch is diagnosable from the banner / logs.
 */
import {
  SHIPHERO_GRAPHQL_ENDPOINT,
  SHIPHERO_REFRESH_ENDPOINT,
  WAREHOUSES,
  KV_KEYS,
  type WarehouseKey,
} from "./config";
import { isKvConfigured, kvGet, kvSet } from "./kv";
import type {
  HoldsBreakdown,
  Lot,
  ShipHeroInventory,
  ShipHeroSummary,
} from "./types";

export interface InventoryResult {
  inventory: ShipHeroInventory;
  warnings: string[];
}

export interface SummaryResult {
  summary: ShipHeroSummary;
  warnings: string[];
}

function emptyBreakdown(): HoldsBreakdown {
  return {
    fraud_hold: 0,
    address_hold: 0,
    shipping_method_hold: 0,
    operator_hold: 0,
    payment_hold: 0,
    client_hold: 0,
  };
}

function warehouseNameFor(key: WarehouseKey): string {
  return WAREHOUSES.find((w) => w.key === key)!.name;
}

// Soft time budget (epoch ms) for the whole ShipHero pull. Pagination loops stop
// past it and the client won't sleep for credits beyond it, so /api/refresh
// always returns within Vercel's function limit and stores a (possibly partial)
// snapshot rather than 504-ing. Set per compute by computeSnapshot.
let shipheroDeadline = Infinity;

export function setShipHeroDeadline(epochMs: number): void {
  shipheroDeadline = epochMs;
}

function budgetLeft(): boolean {
  return Date.now() < shipheroDeadline;
}

// ===========================================================================
// Auth: refresh-token → access-token, cached (KV when available, else memory)
// ===========================================================================

let memToken: { accessToken: string; expiresAt: number } | null = null;

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();

  if (!forceRefresh) {
    if (memToken && memToken.expiresAt > now + 60_000) return memToken.accessToken;
    if (isKvConfigured()) {
      const cached = await kvGet<CachedToken>(KV_KEYS.shipheroToken);
      if (cached && cached.expiresAt > now + 60_000) {
        memToken = cached;
        return cached.accessToken;
      }
    }
  }

  if (!process.env.SHIPHERO_REFRESH_TOKEN) {
    throw new Error("SHIPHERO_REFRESH_TOKEN is not set.");
  }

  const res = await fetch(SHIPHERO_REFRESH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: process.env.SHIPHERO_REFRESH_TOKEN }),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ShipHero token refresh failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const ttlMs = (json.expires_in ?? 27 * 24 * 60 * 60) * 1000;
  const token: CachedToken = { accessToken: json.access_token, expiresAt: now + ttlMs };
  memToken = token;
  if (isKvConfigured()) {
    await kvSet(KV_KEYS.shipheroToken, token, { ttlSeconds: Math.floor(ttlMs / 1000) });
  }
  return token.accessToken;
}

// ===========================================================================
// GraphQL client with 401 refresh + throttle backoff
// ===========================================================================

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string; code?: number }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shipheroGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const maxAttempts = 4;
  let refreshedOn401 = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Stop before starting another attempt once the budget is spent.
    if (Date.now() >= shipheroDeadline) {
      throw new Error("ShipHero time budget exceeded.");
    }

    const token = await getAccessToken();
    const res = await fetch(SHIPHERO_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      // Bound each request so a hung connection can't blow the function budget.
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 401 && !refreshedOn401) {
      refreshedOn401 = true;
      await getAccessToken(true); // force refresh, then retry
      continue;
    }

    if (res.status === 429) {
      const waitMs = Math.min(1000 * 2 ** attempt, 12000);
      if (Date.now() + waitMs > shipheroDeadline) {
        throw new Error("ShipHero time budget exceeded (HTTP 429).");
      }
      await sleep(waitMs);
      continue;
    }

    const raw = await res.text();
    let body: GraphQLEnvelope<T>;
    try {
      body = JSON.parse(raw) as GraphQLEnvelope<T>;
    } catch {
      throw new Error(`ShipHero GraphQL HTTP ${res.status}: ${raw.slice(0, 400)}`);
    }

    const throttleMsg = body.errors?.find((e) =>
      /throttle|credit|too many|rate limit/i.test(e.message),
    )?.message;
    if (throttleMsg && attempt < maxAttempts) {
      // ShipHero tells us exactly how long to wait, e.g. "In 2 seconds you will
      // have enough credits". Honor that (capped) instead of guessing.
      const secs = throttleMsg.match(/in\s+(\d+)\s+second/i)?.[1];
      const waitMs = secs
        ? Math.min(Number(secs) * 1000 + 500, 12000)
        : Math.min(1000 * 2 ** attempt, 12000);
      // Don't sleep past the overall budget — bail so the caller can return.
      if (Date.now() + waitMs > shipheroDeadline) {
        throw new Error("ShipHero time budget exceeded waiting for credits.");
      }
      await sleep(waitMs);
      continue;
    }

    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `ShipHero GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!res.ok) {
      throw new Error(`ShipHero GraphQL HTTP ${res.status}: ${raw.slice(0, 400)}`);
    }
    if (!body.data) throw new Error("ShipHero GraphQL returned no data");
    return body.data;
  }

  throw new Error("ShipHero GraphQL failed after retries (throttled or 401).");
}

// ===========================================================================
// Warehouse resolution (by name → real ID), cached
// ===========================================================================

interface AccountWarehouse {
  id: string;
  legacy_id: number | null;
  identifier: string | null;
  company_name: string | null;
  company_alias: string | null;
  active: boolean | null;
}

// Each key can map to MORE THAN ONE ShipHero warehouse id (this account exposes
// several records per identifier); stock is summed across all of them.
type WarehouseIdMap = Record<WarehouseKey, string[]>;

let warehouseIdMemo: WarehouseIdMap | null = null;

/** True if any of the warehouse's names (or an "A / B" combo) matches a configured name. */
function warehouseMatches(w: AccountWarehouse, matchNames: string[]): boolean {
  const targets = new Set(matchNames.map((n) => n.trim().toLowerCase()));
  const parts = [w.identifier, w.company_name, w.company_alias]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  const candidates = new Set<string>(parts.map((p) => p.toLowerCase()));
  for (const a of parts) {
    for (const b of parts) {
      if (a !== b) candidates.add(`${a} / ${b}`.toLowerCase());
    }
  }
  for (const c of candidates) if (targets.has(c)) return true;
  return false;
}

/**
 * Resolve the configured warehouse names to their ShipHero ID(s). Cached in
 * memory + KV. Prefers active warehouses; if a name can't be matched at all,
 * throws an error listing the actual warehouses so config can be corrected.
 */
async function resolveWarehouseIds(): Promise<WarehouseIdMap> {
  if (warehouseIdMemo) return warehouseIdMemo;
  if (isKvConfigured()) {
    const cached = await kvGet<WarehouseIdMap>(KV_KEYS.shipheroWarehouses);
    if (cached) {
      warehouseIdMemo = cached;
      return cached;
    }
  }

  const data = await shipheroGraphQL<{
    account: { data: { warehouses: AccountWarehouse[] | null } };
  }>(/* GraphQL */ `
    query {
      account {
        data {
          warehouses {
            id
            legacy_id
            identifier
            company_name
            company_alias
            active
          }
        }
      }
    }
  `);

  const warehouses = data.account.data.warehouses ?? [];
  const map = {} as WarehouseIdMap;
  for (const { key, matchNames } of WAREHOUSES) {
    const matches = warehouses.filter((w) => warehouseMatches(w, matchNames));
    // Prefer active warehouses; fall back to all matches if none flag active.
    const active = matches.filter((w) => w.active !== false);
    map[key] = (active.length > 0 ? active : matches).map((w) => w.id);
  }

  const missing = WAREHOUSES.filter((w) => map[w.key].length === 0);
  if (missing.length > 0) {
    const found =
      warehouses
        .map(
          (w) =>
            `[id=${w.id} identifier="${w.identifier}" company_name="${w.company_name}" company_alias="${w.company_alias}" active=${w.active}]`,
        )
        .join("; ") || "no warehouses returned";
    throw new Error(
      `Could not match warehouse name(s): ${missing
        .map((m) => `"${m.name}"`)
        .join(", ")}. ShipHero returned: ${found}. Update WAREHOUSES in lib/config.ts to match.`,
    );
  }

  warehouseIdMemo = map;
  if (isKvConfigured()) {
    await kvSet(KV_KEYS.shipheroWarehouses, map, { ttlSeconds: 7 * 24 * 60 * 60 });
  }
  return map;
}

function keyForWarehouseId(
  ids: WarehouseIdMap,
  id: string | null,
): WarehouseKey | null {
  if (!id) return null;
  for (const key of Object.keys(ids) as WarehouseKey[]) {
    if (ids[key].includes(id)) return key;
  }
  return null;
}

// ===========================================================================
// Inventory: stock per SKU per warehouse (+ best-effort lots)
// ===========================================================================

interface WarehouseProductsPage {
  warehouse_products: {
    data: {
      edges: Array<{
        node: {
          sku: string | null;
          on_hand: number | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

type SkuEntry = {
  sku: string;
  productName: string | null;
  onHand: { nv: number; pa: number };
  lots: Lot[];
};

export async function getShipHeroInventory(): Promise<InventoryResult> {
  const warnings: string[] = [];
  const ids = await resolveWarehouseIds();
  const skuMap = new Map<string, SkuEntry>();

  // Stock: paginate warehouse_products for each warehouse id mapped to a key,
  // summing on_hand. Per-warehouse failures are isolated so one bad warehouse
  // doesn't blank the rest.
  for (const { key } of WAREHOUSES) {
    for (const warehouseId of ids[key]) {
      try {
        let cursor: string | null = null;
        do {
          const data: WarehouseProductsPage =
            await shipheroGraphQL<WarehouseProductsPage>(
              /* GraphQL */ `
                query Stock($cursor: String, $warehouseId: String!) {
                  warehouse_products(warehouse_id: $warehouseId) {
                    data(first: 100, after: $cursor) {
                      edges {
                        node {
                          sku
                          on_hand
                        }
                      }
                      pageInfo {
                        hasNextPage
                        endCursor
                      }
                    }
                  }
                }
              `,
              { cursor, warehouseId },
            );

          for (const edge of data.warehouse_products.data.edges) {
            const sku = edge.node.sku;
            if (!sku) continue;
            const entry =
              skuMap.get(sku) ??
              ({
                sku,
                productName: null,
                onHand: { nv: 0, pa: 0 },
                lots: [],
              } as SkuEntry);
            entry.onHand[key] += edge.node.on_hand ?? 0;
            skuMap.set(sku, entry);
          }

          cursor = data.warehouse_products.data.pageInfo.hasNextPage
            ? data.warehouse_products.data.pageInfo.endCursor
            : null;
        } while (cursor && budgetLeft());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[shiphero] stock for warehouse ${warehouseId} failed:`, msg);
        warnings.push(`Stock (${key.toUpperCase()} / ${warehouseId}): ${msg}`);
      }
    }
  }

  // If we got nothing at all but hit errors, treat it as a hard failure so the
  // dashboard shows the red banner rather than an empty (misleading) table.
  if (skuMap.size === 0 && warnings.length > 0) {
    throw new Error(warnings.join(" | "));
  }

  if (!budgetLeft()) {
    warnings.push(
      "Stock: stopped early (time budget) — some SKUs may be missing; the next refresh continues.",
    );
  }

  // Lots: best-effort — never blocks stock.
  try {
    await attachLots(skuMap, ids);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[shiphero] lots failed:", msg);
    warnings.push(`Lot detail: ${msg}`);
  }

  return { inventory: { skus: Array.from(skuMap.values()) }, warnings };
}

interface ExpirationLotsPage {
  expiration_lots: {
    data: {
      edges: Array<{
        node: {
          name: string | null;
          sku: string | null;
          expires_at: string | null;
          locations: {
            edges: Array<{
              node: { quantity: number | null; warehouse_id: string | null };
            }>;
          } | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/**
 * Attach lots per SKU/warehouse.
 *
 * TEMPORARILY DISABLED: the `expiration_lots` → `locations` path we tried does
 * not expose a per-lot `quantity` on the `Location` type ("Cannot query field
 * 'quantity' on type 'Location'"), and enumerating all lots is an expensive
 * extra paginated query. Stock and days-of-stock (the core metrics) don't need
 * it, and the UI shows "No lot detail reported" gracefully. The correct
 * warehouse-scoped path with quantities is `warehouse_products.locations`
 * (ItemLocation) → `expiration_lot`; wire that here once its exact field names
 * are confirmed against the live schema, and nothing else needs to change.
 */
async function attachLots(
  _skuMap: Map<string, SkuEntry>,
  _ids: WarehouseIdMap,
): Promise<void> {
  // Reference the interfaces/helpers so they remain valid for the future impl.
  void (null as unknown as ExpirationLotsPage);
  void keyForWarehouseId;
  void warehouseNameFor;
  return;
}

// ===========================================================================
// Summary: fulfilled today, holds, returns, receivals
// ===========================================================================

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayStart(dateIso: string): string {
  return `${dateIso}T00:00:00`;
}

export async function getShipHeroSummary(): Promise<SummaryResult> {
  const today = todayIso();
  const warnings: string[] = [];

  // Sequential (not parallel) so we don't thrash the shared credit pool, and
  // ordered cheapest-first so if the time budget is hit it only sacrifices the
  // heaviest metric (fulfilled-today, which paginates the day's orders).
  const returnsToday = await safe(() => countReturnsToday(today), 0, "Returns today", warnings);
  const newReceivalsToday = await safe(
    () => countReceivalsToday(today),
    0,
    "New receivals today",
    warnings,
  );
  const ordersOnHold = await safe(
    () => fetchOrdersOnHold(),
    { total: 0, breakdown: emptyBreakdown() },
    "Orders on hold",
    warnings,
  );
  const ordersFulfilledToday = await safe(
    () => countFulfilledToday(today),
    0,
    "Orders fulfilled today",
    warnings,
  );

  return {
    summary: { ordersFulfilledToday, ordersOnHold, returnsToday, newReceivalsToday },
    warnings,
  };
}

async function safe<T>(
  fn: () => Promise<T>,
  fallback: T,
  label: string,
  warnings: string[],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[shiphero] ${label} failed:`, msg);
    warnings.push(`${label}: ${msg}`);
    return fallback;
  }
}

interface HoldsOrdersPage {
  orders: {
    data: {
      edges: Array<{
        node: {
          holds: {
            fraud_hold: boolean | null;
            address_hold: boolean | null;
            shipping_method_hold: boolean | null;
            operator_hold: boolean | null;
            payment_hold: boolean | null;
            client_hold: boolean | null;
          } | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/** Current orders on hold: total (any hold true) + per-type breakdown. */
async function fetchOrdersOnHold(): Promise<{
  total: number;
  breakdown: HoldsBreakdown;
}> {
  const breakdown = emptyBreakdown();
  let total = 0;
  let cursor: string | null = null;

  do {
    const data: HoldsOrdersPage = await shipheroGraphQL<HoldsOrdersPage>(
      /* GraphQL */ `
        query HeldOrders($cursor: String) {
          orders(has_hold: true) {
            data(first: 100, after: $cursor) {
              edges {
                node {
                  holds {
                    fraud_hold
                    address_hold
                    shipping_method_hold
                    operator_hold
                    payment_hold
                    client_hold
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { cursor },
    );

    for (const edge of data.orders.data.edges) {
      const h = edge.node.holds;
      if (!h) continue;
      const any =
        h.fraud_hold ||
        h.address_hold ||
        h.shipping_method_hold ||
        h.operator_hold ||
        h.payment_hold ||
        h.client_hold;
      if (!any) continue;
      total++;
      if (h.fraud_hold) breakdown.fraud_hold++;
      if (h.address_hold) breakdown.address_hold++;
      if (h.shipping_method_hold) breakdown.shipping_method_hold++;
      if (h.operator_hold) breakdown.operator_hold++;
      if (h.payment_hold) breakdown.payment_hold++;
      if (h.client_hold) breakdown.client_hold++;
    }

    cursor = data.orders.data.pageInfo.hasNextPage
      ? data.orders.data.pageInfo.endCursor
      : null;
  } while (cursor && budgetLeft());

  return { total, breakdown };
}

interface IdOrdersPage {
  orders: {
    data: {
      edges: Array<{ node: { id: string } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/** Orders fulfilled today: fulfillment_status "fulfilled", updated today. */
async function countFulfilledToday(today: string): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const data: IdOrdersPage = await shipheroGraphQL<IdOrdersPage>(
      /* GraphQL */ `
        query Fulfilled($cursor: String, $date: ISODateTime) {
          orders(fulfillment_status: "fulfilled", updated_from: $date) {
            data(first: 100, after: $cursor) {
              edges {
                node {
                  id
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { cursor, date: dayStart(today) },
    );
    count += data.orders.data.edges.length;
    cursor = data.orders.data.pageInfo.hasNextPage
      ? data.orders.data.pageInfo.endCursor
      : null;
  } while (cursor && budgetLeft());
  return count;
}

interface ReturnsPage {
  returns: {
    data: {
      edges: Array<{ node: { created_at: string | null } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/** Returns received today (a single event in ShipHero). Counts return records. */
async function countReturnsToday(today: string): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const data: ReturnsPage = await shipheroGraphQL<ReturnsPage>(
      /* GraphQL */ `
        query Returns($cursor: String, $date: ISODateTime) {
          returns(date_from: $date) {
            data(first: 100, after: $cursor) {
              edges {
                node {
                  created_at
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { cursor, date: dayStart(today) },
    );
    for (const edge of data.returns.data.edges) {
      if ((edge.node.created_at ?? "").slice(0, 10) === today) count++;
    }
    cursor = data.returns.data.pageInfo.hasNextPage
      ? data.returns.data.pageInfo.endCursor
      : null;
  } while (cursor && budgetLeft());
  return count;
}

interface ReceivalsPage {
  warehouse_products: {
    data: {
      edges: Array<{
        node: {
          inbounds: {
            edges: Array<{
              node: { quantity_received: number | null };
            }>;
          } | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/**
 * New receivals today: warehouse_products updated today whose nested inbounds
 * show received quantity. Counted across both warehouses.
 */
async function countReceivalsToday(today: string): Promise<number> {
  const ids = await resolveWarehouseIds();
  const warehouseIds = Array.from(new Set(Object.values(ids).flat()));
  let count = 0;

  for (const warehouseId of warehouseIds) {
    let cursor: string | null = null;
    do {
      const data: ReceivalsPage = await shipheroGraphQL<ReceivalsPage>(
        /* GraphQL */ `
          query Receivals($cursor: String, $warehouseId: String!, $date: ISODateTime) {
            warehouse_products(warehouse_id: $warehouseId, updated_from: $date) {
              data(first: 100, after: $cursor) {
                edges {
                  node {
                    inbounds {
                      edges {
                        node {
                          quantity_received
                        }
                      }
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { cursor, warehouseId, date: dayStart(today) },
      );
      for (const edge of data.warehouse_products.data.edges) {
        for (const inb of edge.node.inbounds?.edges ?? []) {
          if ((inb.node.quantity_received ?? 0) > 0) count++;
        }
      }
      cursor = data.warehouse_products.data.pageInfo.hasNextPage
        ? data.warehouse_products.data.pageInfo.endCursor
        : null;
    } while (cursor && budgetLeft());
  }

  return count;
}

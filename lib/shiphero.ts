/**
 * ShipHero Public API layer.
 *
 * ============================ IMPORTANT ====================================
 * This is the ONLY file that needs to change when real ShipHero credentials
 * arrive. Today, because `SHIPHERO_REFRESH_TOKEN` is not set, every exported
 * function returns realistic placeholder data and `isShipHeroStubbed()` is
 * true so the UI can show a "sample data" banner. The moment that env var is
 * present, the real implementations below run automatically — no other file
 * changes required.
 * ===========================================================================
 *
 * Data surfaced (per the build spec):
 *   - Stock per SKU per warehouse (on_hand), NV + PA.
 *   - Lots per SKU per warehouse (lot number, quantity, expiration date).
 *   - Orders fulfilled today.
 *   - Orders on hold: total + breakdown across the six hold booleans.
 *   - Returns received/processed today (a single event in ShipHero — see below).
 *   - New receivals today.
 *
 * Real-API notes (used only when credentials exist):
 *   - Auth is token-based. Access tokens expire after ~28 days and are renewed
 *     by POSTing { refresh_token } to the refresh endpoint. We cache the live
 *     access token (in KV when available, else in memory) and refresh on 401.
 *     https://developer.shiphero.com/getting-started/
 *   - Warehouse IDs are opaque, so we identify warehouses by their human name.
 *     ShipHero shows warehouses as "identifier / profile" (e.g. identifier
 *     "NV LG Express, Inc." + profile "Primary"), which we reconstruct and
 *     match against the two configured names. Nothing is hardcoded by ID.
 *   - Returns: per the Returns flow docs, "received" and "processed" are the
 *     same event in this API, so we surface ONE number and the UI notes that.
 *     https://developer.shiphero.com/flows/returns/
 *
 * Resilience: ShipHero's GraphQL throttles by query complexity and its schema
 * has many optional shapes. Each summary metric is computed independently and
 * degrades to a safe default (with the underlying error logged) so one bad
 * query can't blank the whole dashboard; inventory errors propagate so the UI
 * can show a clear banner. GraphQL errors include the response body to make
 * any schema mismatch immediately diagnosable from the server logs.
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

/** True when we're running on placeholder data (no refresh token configured). */
export function isShipHeroStubbed(): boolean {
  return !process.env.SHIPHERO_REFRESH_TOKEN;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

export async function getShipHeroInventory(): Promise<ShipHeroInventory> {
  if (isShipHeroStubbed()) return stubInventory();
  return realInventory();
}

export async function getShipHeroSummary(): Promise<ShipHeroSummary> {
  if (isShipHeroStubbed()) return stubSummary();
  return realSummary();
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

// ===========================================================================
// STUB IMPLEMENTATION (active until SHIPHERO_REFRESH_TOKEN is set)
// ===========================================================================

const STUB_SKUS: Array<{
  sku: string;
  name: string;
  nv: number;
  pa: number;
  lots: Array<{ wh: WarehouseKey; lot: string; qty: number; exp: string | null }>;
}> = [
  {
    sku: "LG-VITD3-5000",
    name: "Vitamin D3 5000 IU — 120ct",
    nv: 1840,
    pa: 920,
    lots: [
      { wh: "nv", lot: "D3-2405A", qty: 1200, exp: "2027-04-30" },
      { wh: "nv", lot: "D3-2312B", qty: 640, exp: "2026-12-31" },
      { wh: "pa", lot: "D3-2405A", qty: 920, exp: "2027-04-30" },
    ],
  },
  {
    sku: "LG-OMEGA3-1000",
    name: "Omega-3 Fish Oil 1000mg — 90ct",
    nv: 430,
    pa: 210,
    lots: [
      { wh: "nv", lot: "OM-2403C", qty: 430, exp: "2026-09-30" },
      { wh: "pa", lot: "OM-2403C", qty: 210, exp: "2026-09-30" },
    ],
  },
  {
    sku: "LG-MAG-GLY-400",
    name: "Magnesium Glycinate 400mg — 180ct",
    nv: 75,
    pa: 40,
    lots: [
      { wh: "nv", lot: "MG-2406A", qty: 75, exp: "2027-06-30" },
      { wh: "pa", lot: "MG-2406A", qty: 40, exp: "2027-06-30" },
    ],
  },
  {
    sku: "LG-ZINC-50",
    name: "Zinc Picolinate 50mg — 100ct",
    nv: 2200,
    pa: 1750,
    lots: [
      { wh: "nv", lot: "ZN-2404A", qty: 2200, exp: "2028-01-31" },
      { wh: "pa", lot: "ZN-2404A", qty: 1750, exp: "2028-01-31" },
    ],
  },
  {
    sku: "LG-COQ10-200",
    name: "CoQ10 200mg — 60ct",
    nv: 18,
    pa: 6,
    lots: [
      { wh: "nv", lot: "CQ-2402B", qty: 18, exp: "2026-08-31" },
      { wh: "pa", lot: "CQ-2402B", qty: 6, exp: "2026-08-31" },
    ],
  },
  {
    sku: "LG-PROBIO-50B",
    name: "Probiotic 50 Billion CFU — 30ct",
    nv: 610,
    pa: 0,
    lots: [{ wh: "nv", lot: "PB-2405D", qty: 610, exp: "2026-11-30" }],
  },
  {
    sku: "LG-CREATINE-300",
    name: "Creatine Monohydrate 300g",
    nv: 940,
    pa: 880,
    lots: [
      { wh: "nv", lot: "CR-2406A", qty: 940, exp: null },
      { wh: "pa", lot: "CR-2406A", qty: 880, exp: null },
    ],
  },
  {
    sku: "LG-ASHWA-600",
    name: "Ashwagandha KSM-66 600mg — 120ct",
    nv: 0,
    pa: 0,
    lots: [],
  },
  {
    sku: "LG-MULTI-MEN",
    name: "Men's Daily Multivitamin — 90ct",
    nv: 3100,
    pa: 2400,
    lots: [
      { wh: "nv", lot: "MM-2404A", qty: 1800, exp: "2027-03-31" },
      { wh: "nv", lot: "MM-2401A", qty: 1300, exp: "2026-10-31" },
      { wh: "pa", lot: "MM-2404A", qty: 2400, exp: "2027-03-31" },
    ],
  },
];

function whName(key: WarehouseKey): string {
  return WAREHOUSES.find((w) => w.key === key)!.name;
}

function stubInventory(): ShipHeroInventory {
  return {
    skus: STUB_SKUS.map((s) => ({
      sku: s.sku,
      productName: s.name,
      onHand: { nv: s.nv, pa: s.pa },
      lots: s.lots.map<Lot>((l) => ({
        warehouseKey: l.wh,
        warehouseName: whName(l.wh),
        lotNumber: l.lot,
        quantity: l.qty,
        expirationDate: l.exp,
      })),
    })),
  };
}

function stubSummary(): ShipHeroSummary {
  const breakdown: HoldsBreakdown = {
    fraud_hold: 3,
    address_hold: 7,
    shipping_method_hold: 1,
    operator_hold: 2,
    payment_hold: 4,
    client_hold: 5,
  };
  // Total = orders with ANY hold true; not the sum of the breakdown (an order
  // can have multiple holds). Kept deliberately below the breakdown sum.
  const total = 18;
  return {
    ordersFulfilledToday: 1242,
    ordersOnHold: { total, breakdown },
    returnsToday: 34,
    newReceivalsToday: 5,
  };
}

// ===========================================================================
// REAL IMPLEMENTATION (runs automatically once SHIPHERO_REFRESH_TOKEN is set)
// ===========================================================================

// In-memory access-token cache for when KV isn't configured. Survives within a
// warm serverless instance; refreshed on expiry / 401.
let memToken: { accessToken: string; expiresAt: number } | null = null;

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();

  if (!forceRefresh) {
    if (memToken && memToken.expiresAt > now + 60_000) {
      return memToken.accessToken;
    }
    if (isKvConfigured()) {
      const cached = await kvGet<CachedToken>(KV_KEYS.shipheroToken);
      if (cached && cached.expiresAt > now + 60_000) {
        memToken = cached;
        return cached.accessToken;
      }
    }
  }

  const res = await fetch(SHIPHERO_REFRESH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: process.env.SHIPHERO_REFRESH_TOKEN,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `ShipHero token refresh failed: ${res.status} ${detail.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  // Tokens last ~28 days; trust expires_in when present, else assume 27 days.
  const ttlMs = (json.expires_in ?? 27 * 24 * 60 * 60) * 1000;
  const token: CachedToken = {
    accessToken: json.access_token,
    expiresAt: now + ttlMs,
  };
  memToken = token;
  if (isKvConfigured()) {
    await kvSet(KV_KEYS.shipheroToken, token, {
      ttlSeconds: Math.floor(ttlMs / 1000),
    });
  }
  return token.accessToken;
}

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string; code?: number }>;
}

/**
 * POST a GraphQL query to ShipHero, refreshing the token once on a 401.
 *
 * Any failure includes the raw response body so a schema mismatch (ShipHero
 * returns HTTP 400 with a JSON description of the offending field) is visible
 * in the server logs / error banner rather than just "HTTP 400".
 */
async function shipheroGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  _retried = false,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(SHIPHERO_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (res.status === 401 && !_retried) {
    await getAccessToken(true); // force refresh, then retry once
    return shipheroGraphQL<T>(query, variables, true);
  }

  const raw = await res.text();
  let body: GraphQLEnvelope<T>;
  try {
    body = JSON.parse(raw) as GraphQLEnvelope<T>;
  } catch {
    throw new Error(`ShipHero GraphQL HTTP ${res.status}: ${raw.slice(0, 400)}`);
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

/**
 * Map a warehouse to our internal key by name. ShipHero presents warehouses as
 * "identifier / profile"; we match the reconstructed combined string first,
 * then fall back to profile- or identifier-only matches.
 */
function warehouseKeyByName(
  identifier: string | null,
  profile: string | null,
): WarehouseKey | null {
  const id = (identifier ?? "").trim();
  const prof = (profile ?? "").trim();
  const candidates = [`${id} / ${prof}`.trim(), prof, id].filter(Boolean);
  for (const { key, name } of WAREHOUSES) {
    if (candidates.includes(name)) return key;
  }
  return null;
}

function warehouseNameFor(key: WarehouseKey): string {
  return WAREHOUSES.find((w) => w.key === key)!.name;
}

interface ProductsPage {
  products: {
    data: {
      edges: Array<{
        cursor: string;
        node: {
          sku: string | null;
          name: string | null;
          warehouse_products: Array<{
            warehouse_id: string;
            on_hand: number | null;
            warehouse: { identifier: string | null; profile: string | null } | null;
          }> | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/**
 * Stock per SKU per warehouse. Pulls the products connection and sums on_hand
 * into NV / PA, mapping each warehouse_product to a warehouse by its
 * identifier/profile name (no opaque IDs hardcoded).
 */
async function realInventory(): Promise<ShipHeroInventory> {
  const skuMap = new Map<
    string,
    {
      sku: string;
      productName: string | null;
      onHand: { nv: number; pa: number };
      lots: Lot[];
    }
  >();

  let cursor: string | null = null;
  do {
    const data: ProductsPage = await shipheroGraphQL<ProductsPage>(
      /* GraphQL */ `
        query Products($cursor: String) {
          products(first: 100, after: $cursor) {
            data {
              edges {
                cursor
                node {
                  sku
                  name
                  warehouse_products {
                    warehouse_id
                    on_hand
                    warehouse {
                      identifier
                      profile
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
      { cursor },
    );

    for (const edge of data.products.data.edges) {
      const node = edge.node;
      if (!node.sku) continue;
      const entry = skuMap.get(node.sku) ?? {
        sku: node.sku,
        productName: node.name ?? null,
        onHand: { nv: 0, pa: 0 },
        lots: [] as Lot[],
      };
      for (const wp of node.warehouse_products ?? []) {
        const key = warehouseKeyByName(
          wp.warehouse?.identifier ?? null,
          wp.warehouse?.profile ?? null,
        );
        if (key) entry.onHand[key] += wp.on_hand ?? 0;
      }
      skuMap.set(node.sku, entry);
    }

    cursor = data.products.data.pageInfo.hasNextPage
      ? data.products.data.pageInfo.endCursor
      : null;
  } while (cursor);

  // Lot detail is best-effort and isolated so it can never blank out stock.
  try {
    await attachLots(skuMap);
  } catch (err) {
    console.error("[shiphero] lot detail unavailable:", err);
  }

  return { skus: Array.from(skuMap.values()) };
}

/**
 * Attach lot detail (lot number, quantity, expiration) per SKU/warehouse.
 *
 * NOTE: ShipHero exposes lots via `expiration_lots` on warehouse Locations,
 * and the exact path is best confirmed by introspecting the live schema (the
 * API is self-documenting). Until that path is verified against this account's
 * schema, this is a no-op — stock and days-of-stock (the core metrics) work
 * without it, and the UI shows "No lot detail reported" gracefully. Wire the
 * confirmed query here; nothing else needs to change.
 */
async function attachLots(
  _skuMap: Map<
    string,
    {
      sku: string;
      productName: string | null;
      onHand: { nv: number; pa: number };
      lots: Lot[];
    }
  >,
): Promise<void> {
  // Intentionally left unwired pending live-schema confirmation. See note above.
  void warehouseNameFor; // keep helper referenced for the future lots mapping
  return;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Each summary metric is computed independently and degrades to a safe default
 * (logging the underlying error) so a single schema mismatch in, say, the
 * returns query can't blank the fulfilled-today or holds numbers.
 */
async function realSummary(): Promise<ShipHeroSummary> {
  const today = todayIso();

  const [fulfillAndHolds, returnsToday, newReceivalsToday] = await Promise.all([
    safe(() => fetchFulfillmentAndHolds(today), {
      ordersFulfilledToday: 0,
      ordersOnHold: { total: 0, breakdown: emptyBreakdown() },
    }),
    safe(() => countReturnsToday(today), 0),
    safe(() => countReceivalsToday(today), 0),
  ]);

  return {
    ordersFulfilledToday: fulfillAndHolds.ordersFulfilledToday,
    ordersOnHold: fulfillAndHolds.ordersOnHold,
    returnsToday,
    newReceivalsToday,
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error("[shiphero] summary metric failed:", err);
    return fallback;
  }
}

interface OrdersPage {
  orders: {
    data: {
      edges: Array<{
        node: {
          fulfillment_status: string | null;
          updated_at: string | null;
          holds: {
            fraud_hold: boolean;
            address_hold: boolean;
            shipping_method_hold: boolean;
            operator_hold: boolean;
            payment_hold: boolean;
            client_hold: boolean;
          } | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

async function fetchFulfillmentAndHolds(today: string): Promise<{
  ordersFulfilledToday: number;
  ordersOnHold: { total: number; breakdown: HoldsBreakdown };
}> {
  const breakdown = emptyBreakdown();
  let ordersOnHoldTotal = 0;
  let ordersFulfilledToday = 0;

  let cursor: string | null = null;
  do {
    const data: OrdersPage = await shipheroGraphQL<OrdersPage>(
      /* GraphQL */ `
        query Orders($cursor: String, $date: ISODateTime) {
          orders(first: 100, after: $cursor, updated_from: $date) {
            data {
              edges {
                node {
                  fulfillment_status
                  updated_at
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
      { cursor, date: `${today}T00:00:00` },
    );

    for (const edge of data.orders.data.edges) {
      const node = edge.node;
      if (
        node.fulfillment_status === "fulfilled" &&
        node.updated_at?.slice(0, 10) === today
      ) {
        ordersFulfilledToday++;
      }
      const h = node.holds;
      if (h) {
        const anyHold =
          h.fraud_hold ||
          h.address_hold ||
          h.shipping_method_hold ||
          h.operator_hold ||
          h.payment_hold ||
          h.client_hold;
        if (anyHold) {
          ordersOnHoldTotal++;
          if (h.fraud_hold) breakdown.fraud_hold++;
          if (h.address_hold) breakdown.address_hold++;
          if (h.shipping_method_hold) breakdown.shipping_method_hold++;
          if (h.operator_hold) breakdown.operator_hold++;
          if (h.payment_hold) breakdown.payment_hold++;
          if (h.client_hold) breakdown.client_hold++;
        }
      }
    }

    cursor = data.orders.data.pageInfo.hasNextPage
      ? data.orders.data.pageInfo.endCursor
      : null;
  } while (cursor);

  return {
    ordersFulfilledToday,
    ordersOnHold: { total: ordersOnHoldTotal, breakdown },
  };
}

interface ReturnsPage {
  returns: {
    data: {
      edges: Array<{ node: { created_at: string | null } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/** Returns received/processed today — a single event in ShipHero, so one number. */
async function countReturnsToday(today: string): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const data: ReturnsPage = await shipheroGraphQL<ReturnsPage>(
      /* GraphQL */ `
        query Returns($cursor: String, $date: ISODateTime) {
          returns(first: 100, after: $cursor, created_from: $date) {
            data {
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
      { cursor, date: `${today}T00:00:00` },
    );
    for (const edge of data.returns.data.edges) {
      if (edge.node.created_at?.slice(0, 10) === today) count++;
    }
    cursor = data.returns.data.pageInfo.hasNextPage
      ? data.returns.data.pageInfo.endCursor
      : null;
  } while (cursor);
  return count;
}

interface PurchaseOrdersPage {
  purchase_orders: {
    data: {
      edges: Array<{
        node: {
          line_items: {
            edges: Array<{
              node: { quantity_received: number | null; updated_at: string | null };
            }>;
          };
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/** New receivals today: PO line items whose received quantity moved today. */
async function countReceivalsToday(today: string): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const data: PurchaseOrdersPage = await shipheroGraphQL<PurchaseOrdersPage>(
      /* GraphQL */ `
        query Receivals($cursor: String, $date: ISODateTime) {
          purchase_orders(first: 100, after: $cursor, updated_from: $date) {
            data {
              edges {
                node {
                  line_items {
                    edges {
                      node {
                        quantity_received
                        updated_at
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
      { cursor, date: `${today}T00:00:00` },
    );
    for (const po of data.purchase_orders.data.edges) {
      for (const li of po.node.line_items.edges) {
        if (
          (li.node.quantity_received ?? 0) > 0 &&
          li.node.updated_at?.slice(0, 10) === today
        ) {
          count++;
        }
      }
    }
    cursor = data.purchase_orders.data.pageInfo.hasNextPage
      ? data.purchase_orders.data.pageInfo.endCursor
      : null;
  } while (cursor);
  return count;
}

/**
 * Shopify Admin API layer.
 *
 * This file produces, per SKU, the number of units sold over the trailing
 * 30 days (used for "days of stock"), plus a count of orders created today.
 *
 * Volume note: this store does ~50k orders/month. The Admin GraphQL API
 * rate-limits by *calculated query cost* (a refilling points bucket), not by
 * request count, so naively pulling a 30-day window of orders-with-line-items
 * on every refresh would be slow and burn the budget. The strategy here:
 *
 *   1. One-time historical backfill via the Bulk Operations API (async, not
 *      subject to the normal per-request rate limit) — Shopify's documented
 *      approach for pulling >1,000 records. We kick it off, store an
 *      "in progress" flag, and pick up the JSONL result on a later refresh.
 *   2. Ongoing daily refresh: fetch only orders created since the last
 *      successful sync (usually just yesterday) via normal paginated GraphQL.
 *      Each day's per-SKU units-sold is stored as its own dated KV entry; the
 *      trailing 30-day total is the sum of the last 30 daily entries.
 *
 * Both paths read `extensions.cost` and back off on THROTTLED errors rather
 * than assuming a fixed requests-per-second number.
 *
 * SKU AGGREGATION RULE: the same physical product can be listed as multiple
 * Shopify products/variants for A/B testing. We therefore group and sum every
 * Shopify-derived number by SKU only — never by product_id or variant_id.
 *
 * When KV is not configured there's nowhere to persist daily entries, so we
 * fall back to computing the trailing window fresh on each request, relying on
 * Next's fetch caching (revalidate window) to avoid re-querying constantly.
 */
import {
  SHOPIFY_API_VERSION,
  ROLLING_WINDOW_DAYS,
  FALLBACK_REVALIDATE_SECONDS,
  KV_KEYS,
  shopifyDailyKey,
} from "./config";
import { isKvConfigured, kvGet, kvSet } from "./kv";
import type { ShopifyMeta, ShopifyStatus } from "./types";

export interface ShopifyResult {
  status: ShopifyStatus;
  message?: string;
  /** Trailing 30-day units sold, keyed by SKU. null when unavailable. */
  salesBySku: Record<string, number> | null;
  /** Orders created today (store-local UTC day). null when unavailable. */
  ordersCreatedToday: number | null;
}

type SalesMap = Record<string, number>;

/** Cache tag for the no-KV fallback fetches, so "Refresh now" can bust them. */
export const SHOPIFY_FETCH_TAG = "shopify-orders";

// ---------------------------------------------------------------------------
// Low-level GraphQL client
// ---------------------------------------------------------------------------

function shopifyConfigured(): boolean {
  return Boolean(
    process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  );
}

function graphqlEndpoint(): string {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  return `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST a GraphQL query. Handles THROTTLED by waiting until the cost bucket has
 * refilled enough, using the throttleStatus Shopify returns (no fixed RPS).
 *
 * `revalidate` opts into Next's fetch cache for the read-heavy fallback path.
 */
async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { revalidate?: number; tags?: string[] } = {},
): Promise<T> {
  const maxAttempts = 6;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(graphqlEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN as string,
      },
      body: JSON.stringify({ query, variables }),
      ...(opts.revalidate !== undefined
        ? { next: { revalidate: opts.revalidate, tags: opts.tags } }
        : { cache: "no-store" as RequestCache }),
    });

    if (res.status === 429) {
      // Hard HTTP throttle — exponential backoff.
      await sleep(Math.min(1000 * 2 ** attempt, 16000));
      continue;
    }

    const body = (await res.json()) as GraphQLResponse<T>;

    const throttled = body.errors?.some(
      (e) => e.extensions?.code === "THROTTLED",
    );
    if (throttled) {
      const throttle = body.extensions?.cost?.throttleStatus;
      if (throttle) {
        const needed = body.extensions?.cost?.requestedQueryCost ?? 100;
        const deficit = Math.max(0, needed - throttle.currentlyAvailable);
        const waitMs = Math.min(
          16000,
          Math.ceil((deficit / Math.max(1, throttle.restoreRate)) * 1000) + 500,
        );
        await sleep(waitMs);
      } else {
        await sleep(Math.min(1000 * 2 ** attempt, 16000));
      }
      continue;
    }

    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!body.data) {
      throw new Error("Shopify GraphQL returned no data");
    }
    return body.data;
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Shopify GraphQL throttled after multiple retries");
}

// ---------------------------------------------------------------------------
// Date helpers (operate on the store's UTC calendar day)
// ---------------------------------------------------------------------------

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayStartIso(dateYmd: string): string {
  return `${dateYmd}T00:00:00Z`;
}

function addDays(dateYmd: string, days: number): string {
  const d = new Date(`${dateYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

function todayYmd(): string {
  return ymd(new Date());
}

// ---------------------------------------------------------------------------
// Paginated "orders created in [start, end)" → units sold per SKU
// ---------------------------------------------------------------------------

const ORDERS_QUERY = /* GraphQL */ `
  query OrdersWindow($cursor: String, $q: String!) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          createdAt
          lineItems(first: 100) {
            edges {
              node {
                sku
                quantity
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
`;

interface OrdersPage {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        createdAt: string;
        lineItems: {
          edges: Array<{ node: { sku: string | null; quantity: number } }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Sum units sold per SKU for orders created in [startYmd, endYmd). */
async function sumUnitsForWindow(
  startYmd: string,
  endYmd: string,
  opts: { revalidate?: number; tags?: string[] } = {},
): Promise<SalesMap> {
  const sales: SalesMap = {};
  const q = `created_at:>=${dayStartIso(startYmd)} created_at:<${dayStartIso(endYmd)}`;
  let cursor: string | null = null;

  do {
    const data: OrdersPage = await shopifyGraphQL<OrdersPage>(
      ORDERS_QUERY,
      { cursor, q },
      opts,
    );
    for (const edge of data.orders.edges) {
      for (const li of edge.node.lineItems.edges) {
        const sku = li.node.sku;
        if (!sku) continue; // group strictly by SKU; skip line items without one
        sales[sku] = (sales[sku] ?? 0) + (li.node.quantity ?? 0);
      }
    }
    cursor = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;
  } while (cursor);

  return sales;
}

const ORDERS_COUNT_QUERY = /* GraphQL */ `
  query OrdersCount($cursor: String, $q: String!) {
    orders(first: 250, after: $cursor, query: $q) {
      edges {
        cursor
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
`;

interface OrdersCountPage {
  orders: {
    edges: Array<{ cursor: string; node: { id: string } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Count orders created today. */
async function countOrdersCreatedToday(
  opts: { revalidate?: number; tags?: string[] } = {},
): Promise<number> {
  const q = `created_at:>=${dayStartIso(todayYmd())}`;
  let cursor: string | null = null;
  let count = 0;
  do {
    const data: OrdersCountPage = await shopifyGraphQL<OrdersCountPage>(
      ORDERS_COUNT_QUERY,
      { cursor, q },
      opts,
    );
    count += data.orders.edges.length;
    cursor = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;
  } while (cursor);
  return count;
}

// ---------------------------------------------------------------------------
// Bulk Operations backfill (KV mode only)
// ---------------------------------------------------------------------------

const BULK_RUN_MUTATION = /* GraphQL */ `
  mutation BulkBackfill($q: String!) {
    bulkOperationRunQuery(
      query: $q
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const CURRENT_BULK_QUERY = /* GraphQL */ `
  query {
    currentBulkOperation {
      id
      status
      errorCode
      objectCount
      url
    }
  }
`;

/**
 * Kick off a bulk export of the last 30 days of orders + line items.
 * Returns the bulk operation id, or throws on a userError.
 */
async function startBulkBackfill(): Promise<string> {
  const start = addDays(todayYmd(), -ROLLING_WINDOW_DAYS);
  // The inner query is a literal bulk query string (no pagination args allowed).
  const innerQuery = `{
    orders(query: "created_at:>=${dayStartIso(start)}") {
      edges {
        node {
          id
          createdAt
          lineItems {
            edges { node { sku quantity } }
          }
        }
      }
    }
  }`;

  const data = await shopifyGraphQL<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(BULK_RUN_MUTATION, { q: innerQuery });

  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors.length > 0) {
    throw new Error(
      `Bulk backfill failed: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!bulkOperation) throw new Error("Bulk backfill returned no operation");
  return bulkOperation.id;
}

interface BulkStatus {
  id: string | null;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
}

async function getCurrentBulkOperation(): Promise<BulkStatus | null> {
  const data = await shopifyGraphQL<{ currentBulkOperation: BulkStatus | null }>(
    CURRENT_BULK_QUERY,
  );
  return data.currentBulkOperation;
}

/**
 * Download + parse a completed bulk JSONL export into per-day units-by-SKU.
 *
 * Bulk JSONL emits each connection node as its own line. Order lines carry
 * `id` + `createdAt`; line-item lines carry `sku`, `quantity`, and a
 * `__parentId` pointing back at their order. We first map order id → day, then
 * attribute each line item's quantity to that day, grouped by SKU.
 */
async function parseBulkJsonl(url: string): Promise<Record<string, SalesMap>> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bulk JSONL download failed: ${res.status}`);
  const text = await res.text();

  const orderDay: Record<string, string> = {};
  const lineItems: Array<{ parent: string; sku: string; quantity: number }> = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as {
      id?: string;
      createdAt?: string;
      sku?: string | null;
      quantity?: number;
      __parentId?: string;
    };
    if (obj.createdAt && obj.id && !obj.__parentId) {
      orderDay[obj.id] = obj.createdAt.slice(0, 10);
    } else if (obj.__parentId && obj.sku !== undefined) {
      if (obj.sku) {
        lineItems.push({
          parent: obj.__parentId,
          sku: obj.sku,
          quantity: obj.quantity ?? 0,
        });
      }
    }
  }

  const byDay: Record<string, SalesMap> = {};
  for (const li of lineItems) {
    const day = orderDay[li.parent];
    if (!day) continue;
    (byDay[day] ??= {})[li.sku] = (byDay[day][li.sku] ?? 0) + li.quantity;
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// KV persistence helpers
// ---------------------------------------------------------------------------

async function readMeta(): Promise<ShopifyMeta> {
  return (
    (await kvGet<ShopifyMeta>(KV_KEYS.shopifyMeta)) ?? {
      lastSyncDate: null,
      backfill: { status: "none", bulkOperationId: null, startedAt: null },
    }
  );
}

async function writeMeta(meta: ShopifyMeta): Promise<void> {
  await kvSet(KV_KEYS.shopifyMeta, meta);
}

// Keep daily entries a little longer than the window so trailing sums are safe.
const DAILY_TTL_SECONDS = (ROLLING_WINDOW_DAYS + 10) * 24 * 60 * 60;

async function storeDailyUnits(dateYmd: string, units: SalesMap): Promise<void> {
  await kvSet(shopifyDailyKey(dateYmd), units, { ttlSeconds: DAILY_TTL_SECONDS });
}

/** Sum the most recent ROLLING_WINDOW_DAYS daily entries into one map. */
async function sumTrailingWindow(): Promise<SalesMap> {
  const total: SalesMap = {};
  // Sum complete days: yesterday back through ROLLING_WINDOW_DAYS days.
  for (let i = 1; i <= ROLLING_WINDOW_DAYS; i++) {
    const day = addDays(todayYmd(), -i);
    const units = await kvGet<SalesMap>(shopifyDailyKey(day));
    if (!units) continue;
    for (const [sku, qty] of Object.entries(units)) {
      total[sku] = (total[sku] ?? 0) + qty;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute trailing-30-day sales by SKU and today's order count.
 *
 * KV mode: drives the backfill → incremental state machine described at the top
 * of this file. No-KV mode: computes the window fresh with Next fetch caching.
 */
export async function getShopifyData(): Promise<ShopifyResult> {
  if (!shopifyConfigured()) {
    return {
      status: "no_token",
      message:
        "Shopify credentials not set (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN).",
      salesBySku: null,
      ordersCreatedToday: null,
    };
  }

  try {
    if (isKvConfigured()) {
      return await getShopifyDataWithKv();
    }
    return await getShopifyDataFallback();
  } catch (err) {
    console.error("[shopify] getShopifyData failed:", err);
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Unknown Shopify error",
      salesBySku: null,
      ordersCreatedToday: null,
    };
  }
}

/** KV mode: backfill + incremental daily sync. */
async function getShopifyDataWithKv(): Promise<ShopifyResult> {
  const meta = await readMeta();

  // ---- Backfill state machine ----------------------------------------------
  if (meta.backfill.status === "none") {
    // First run: kick off the bulk export and return what little we have.
    const id = await startBulkBackfill();
    await writeMeta({
      ...meta,
      backfill: {
        status: "in_progress",
        bulkOperationId: id,
        startedAt: new Date().toISOString(),
      },
    });
    return {
      status: "backfill_in_progress",
      message:
        "Historical backfill started (Shopify bulk operation). Sales velocity will populate on the next refresh once it completes.",
      salesBySku: await sumTrailingWindow(),
      ordersCreatedToday: await safeCountToday(),
    };
  }

  if (meta.backfill.status === "in_progress") {
    const op = await getCurrentBulkOperation();
    if (op && op.status === "COMPLETED" && op.url) {
      const byDay = await parseBulkJsonl(op.url);
      for (const [day, units] of Object.entries(byDay)) {
        await storeDailyUnits(day, units);
      }
      await writeMeta({
        ...meta,
        lastSyncDate: addDays(todayYmd(), -1),
        backfill: { status: "done", bulkOperationId: null, startedAt: null },
      });
      // fall through to normal path below
    } else if (op && (op.status === "FAILED" || op.status === "CANCELED")) {
      // Reset so the next refresh retries the backfill.
      await writeMeta({
        ...meta,
        backfill: { status: "none", bulkOperationId: null, startedAt: null },
      });
      return {
        status: "backfill_in_progress",
        message: `Backfill ${op.status.toLowerCase()} (${op.errorCode ?? "unknown"}); it will retry on the next refresh.`,
        salesBySku: await sumTrailingWindow(),
        ordersCreatedToday: await safeCountToday(),
      };
    } else {
      // Still RUNNING / CREATED.
      return {
        status: "backfill_in_progress",
        message: "Historical backfill still running on Shopify's side.",
        salesBySku: await sumTrailingWindow(),
        ordersCreatedToday: await safeCountToday(),
      };
    }
  }

  // ---- Incremental daily refresh -------------------------------------------
  // Sync each complete day from lastSyncDate (exclusive) up to yesterday.
  const meta2 = await readMeta();
  const yesterday = addDays(todayYmd(), -1);
  let cursorDay = meta2.lastSyncDate ?? addDays(yesterday, -1);
  let day = addDays(cursorDay, 1);
  while (day <= yesterday) {
    const units = await sumUnitsForWindow(day, addDays(day, 1));
    await storeDailyUnits(day, units);
    cursorDay = day;
    day = addDays(day, 1);
  }
  if (cursorDay !== meta2.lastSyncDate) {
    await writeMeta({ ...meta2, lastSyncDate: cursorDay });
  }

  return {
    status: "ok",
    salesBySku: await sumTrailingWindow(),
    ordersCreatedToday: await safeCountToday(),
  };
}

/**
 * No-KV fallback: compute the trailing window fresh, leaning on Next fetch
 * caching so we don't re-query Shopify on every single request.
 *
 * Note: without persistence we can't use the bulk-backfill / daily-entry model,
 * so this path queries the live window directly. It's correct and throttle-safe
 * (backoff is built in), but on this store's volume it is heavier than KV mode —
 * connecting Vercel KV is strongly recommended for production. See README.
 */
async function getShopifyDataFallback(): Promise<ShopifyResult> {
  const start = addDays(todayYmd(), -ROLLING_WINDOW_DAYS);
  const today = todayYmd();
  const salesBySku = await sumUnitsForWindow(start, today, {
    revalidate: FALLBACK_REVALIDATE_SECONDS,
    tags: [SHOPIFY_FETCH_TAG],
  });
  const ordersCreatedToday = await countOrdersCreatedToday({
    revalidate: FALLBACK_REVALIDATE_SECONDS,
    tags: [SHOPIFY_FETCH_TAG],
  });
  return { status: "ok", salesBySku, ordersCreatedToday };
}

async function safeCountToday(): Promise<number | null> {
  try {
    return await countOrdersCreatedToday();
  } catch (err) {
    console.error("[shopify] countOrdersCreatedToday failed:", err);
    return null;
  }
}

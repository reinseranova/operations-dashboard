/**
 * Combines the Shopify and ShipHero layers into the single Snapshot object the
 * dashboard renders, applying the metric formulas.
 *
 * Read path: the dashboard reads the latest snapshot from KV if present;
 * otherwise it calls computeSnapshot() directly (see app/page.tsx). /api/refresh
 * always recomputes and writes to KV.
 *
 * ShipHero and Shopify are pulled independently so one failing never blanks the
 * other. ShipHero is the source of the SKU list, so on a core ShipHero error we
 * still render (with a banner) rather than throwing. Shopify is guarded by a
 * timeout: on this store's volume, computing 30 days fresh without KV can be
 * slow, and we'd rather show stock with "—" days-of-stock than hang the page.
 */
import { ROLLING_WINDOW_DAYS, KV_KEYS } from "./config";
import { isKvConfigured, kvGet, kvSet } from "./kv";
import {
  EXCLUDED_SKUS,
  PRODUCT_NAMES,
  getShopifyData,
  type ShopifyResult,
} from "./shopify";
import {
  getShipHeroInventory,
  getShipHeroSummary,
  setShipHeroDeadline,
} from "./shiphero";
import type {
  Snapshot,
  SkuRow,
  ShipHeroInventory,
  ShipHeroSummary,
} from "./types";

const SHOPIFY_TIMEOUT_MS = 45_000;
// ShipHero pull budget — keeps the whole compute under Vercel's 60s limit so
// /api/refresh stores a snapshot instead of timing out. Loops and credit waits
// stop past this; a single in-flight request is separately capped at 15s, so
// worst case ≈ 40 + 15 = 55s, comfortably under 60.
const SHIPHERO_BUDGET_MS = 40_000;

function emptyShipHeroSummary(): ShipHeroSummary {
  return {
    ordersFulfilledToday: 0,
    returnsToday: 0,
    newReceivalsToday: 0,
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(onTimeout()), ms)),
  ]);
}

/** Pull from both sources and compute every metric. */
export async function computeSnapshot(): Promise<Snapshot> {
  let inventory: ShipHeroInventory = { skus: [] };
  let summary: ShipHeroSummary = emptyShipHeroSummary();
  let shipheroStatus: "ok" | "error" = "ok";
  let shipheroMessage: string | undefined;
  const warnings: string[] = [];

  setShipHeroDeadline(Date.now() + SHIPHERO_BUDGET_MS);

  // Shopify runs concurrently (it's fast with KV, or fails fast on a bad token).
  // ShipHero inventory is awaited BEFORE the summary so stock — the core of the
  // dashboard — always gets first claim on the shared time/credit budget.
  const shopifyPromise = withTimeout<ShopifyResult>(
    getShopifyData(),
    SHOPIFY_TIMEOUT_MS,
    () => ({
      status: "error",
      message:
        "Shopify sales query timed out. Connect Vercel KV to enable the fast backfill/daily-sync model for this store's volume.",
      salesBySku: null,
      ordersCreatedToday: null,
    }),
  );

  const inventoryResult = await getShipHeroInventory().then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  const summaryResult = await getShipHeroSummary().then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  const shopify = await shopifyPromise;

  if (inventoryResult.ok) {
    inventory = inventoryResult.v.inventory;
    warnings.push(...inventoryResult.v.warnings);
  } else {
    shipheroStatus = "error";
    shipheroMessage = errMessage(inventoryResult.e);
  }

  if (summaryResult.ok) {
    summary = summaryResult.v.summary;
    warnings.push(...summaryResult.v.warnings);
  } else {
    warnings.push(`Daily summary: ${errMessage(summaryResult.e)}`);
  }

  const sales = shopify.salesBySku;

  const skus: SkuRow[] = inventory.skus
    .filter((item) => !EXCLUDED_SKUS.has(item.sku))
    .map((item) => {
      const total = item.onHand.nv + item.onHand.pa;

      // units30 is null when we have no Shopify data at all (no token / backfill
      // in progress / error / timeout). A SKU simply absent from the map means 0.
      const units30 = sales ? sales[item.sku] ?? 0 : null;
      const dailyVelocity = units30 === null ? null : units30 / ROLLING_WINDOW_DAYS;

      // Days of stock = current stock / daily velocity. Guard divide-by-zero:
      // no recent sales => null (UI shows "—" / "No recent sales").
      const daysOfStock =
        dailyVelocity && dailyVelocity > 0 ? total / dailyVelocity : null;

      return {
        sku: item.sku,
        productName: PRODUCT_NAMES[item.sku] ?? item.productName,
        stock: { nv: item.onHand.nv, pa: item.onHand.pa, total },
        units30,
        dailyVelocity,
        daysOfStock,
        lots: item.lots,
      };
    });

  // Highest total stock first, lowest last. No UI sort controls — always this order.
  skus.sort((a, b) => b.stock.total - a.stock.total);

  return {
    generatedAt: new Date().toISOString(),
    skus,
    summary: {
      ordersFulfilledToday: summary.ordersFulfilledToday,
      returnsToday: summary.returnsToday,
      newReceivalsToday: summary.newReceivalsToday,
      ordersCreatedTodayShopify: shopify.ordersCreatedToday,
    },
    shiphero: {
      status: shipheroStatus,
      message: shipheroMessage,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    shopify: { status: shopify.status, message: shopify.message },
  };
}

/** Recompute and persist to KV (no-op write when KV isn't configured). */
export async function refreshSnapshot(): Promise<Snapshot> {
  const snapshot = await computeSnapshot();
  await kvSet(KV_KEYS.snapshot, snapshot);
  return snapshot;
}

/**
 * What the dashboard calls. Prefers the stored KV snapshot (instant); on a cache
 * miss it computes once AND stores, so subsequent loads are fast. Without KV it
 * always computes live — fine for low volume, but on this store's order volume
 * connecting KV (so /api/refresh precomputes the snapshot) is what keeps page
 * loads from doing heavy work inline. See README.
 */
export async function getSnapshotForDashboard(): Promise<Snapshot> {
  if (isKvConfigured()) {
    const stored = await kvGet<Snapshot>(KV_KEYS.snapshot);
    if (stored) return stored;
    return refreshSnapshot(); // first run: compute + persist for next time
  }
  return computeSnapshot();
}

/**
 * Combines the Shopify (real) and ShipHero (stubbed) layers into the single
 * Snapshot object the dashboard renders, applying the metric formulas.
 *
 * Read path: the dashboard reads the latest snapshot from KV if present;
 * otherwise it calls computeSnapshot() directly (see app/page.tsx). /api/refresh
 * always recomputes and writes to KV.
 */
import { ROLLING_WINDOW_DAYS, KV_KEYS } from "./config";
import { isKvConfigured, kvGet, kvSet } from "./kv";
import { getShopifyData } from "./shopify";
import { getShipHeroInventory, getShipHeroSummary, isShipHeroStubbed } from "./shiphero";
import type { Snapshot, SkuRow } from "./types";

/** Pull from both sources and compute every metric. */
export async function computeSnapshot(): Promise<Snapshot> {
  const [inventory, summary, shopify] = await Promise.all([
    getShipHeroInventory(),
    getShipHeroSummary(),
    getShopifyData(),
  ]);

  const sales = shopify.salesBySku;

  const skus: SkuRow[] = inventory.skus.map((item) => {
    const total = item.onHand.nv + item.onHand.pa;

    // units30 is null when we have no Shopify data at all (no token / backfill
    // in progress / error). A SKU simply absent from the sales map means 0.
    const units30 = sales ? sales[item.sku] ?? 0 : null;
    const dailyVelocity = units30 === null ? null : units30 / ROLLING_WINDOW_DAYS;

    // Days of stock = current stock / daily velocity. Guard divide-by-zero:
    // no recent sales => null (UI shows "—" / "No recent sales").
    const daysOfStock =
      dailyVelocity && dailyVelocity > 0 ? total / dailyVelocity : null;

    return {
      sku: item.sku,
      productName: item.productName,
      stock: { nv: item.onHand.nv, pa: item.onHand.pa, total },
      units30,
      dailyVelocity,
      daysOfStock,
      lots: item.lots,
    };
  });

  // Sort lowest days-of-stock first so the most urgent SKUs surface at the top;
  // SKUs with no recent sales sort to the bottom.
  skus.sort((a, b) => {
    if (a.daysOfStock === null && b.daysOfStock === null) {
      return a.sku.localeCompare(b.sku);
    }
    if (a.daysOfStock === null) return 1;
    if (b.daysOfStock === null) return -1;
    return a.daysOfStock - b.daysOfStock;
  });

  return {
    generatedAt: new Date().toISOString(),
    skus,
    summary: {
      ordersFulfilledToday: summary.ordersFulfilledToday,
      ordersOnHold: summary.ordersOnHold,
      returnsToday: summary.returnsToday,
      newReceivalsToday: summary.newReceivalsToday,
      ordersCreatedTodayShopify: shopify.ordersCreatedToday,
    },
    shiphero: { stubbed: isShipHeroStubbed() },
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
 * What the dashboard calls. Prefers the stored KV snapshot; if KV isn't
 * configured (or nothing stored yet), computes fresh.
 */
export async function getSnapshotForDashboard(): Promise<Snapshot> {
  if (isKvConfigured()) {
    const stored = await kvGet<Snapshot>(KV_KEYS.snapshot);
    if (stored) return stored;
  }
  return computeSnapshot();
}

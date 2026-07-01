import type { WarehouseKey } from "./config";

/** A single lot of stock for a SKU in one warehouse. */
export interface Lot {
  warehouseKey: WarehouseKey;
  warehouseName: string;
  /** null when the bin has stock but no lot is assigned to it. */
  lotNumber: string | null;
  quantity: number;
  /** ISO date (YYYY-MM-DD) or null when the lot has no expiration. */
  expirationDate: string | null;
  /** Bin/shelf label, for display only. */
  location: string | null;
}

/** Per-warehouse on-hand stock for a SKU. */
export interface WarehouseStock {
  nv: number;
  pa: number;
  total: number;
}

/** Everything the dashboard shows for one SKU. */
export interface SkuRow {
  sku: string;
  productName: string | null;
  stock: WarehouseStock;
  /** Units sold for this SKU over the trailing 30 days. null = no Shopify data yet. */
  units30: number | null;
  /** Average units sold per day over the trailing window. null = no Shopify data. */
  dailyVelocity: number | null;
  /** current stock / daily velocity. null when there are no recent sales (avoid /0). */
  daysOfStock: number | null;
  lots: Lot[];
}

/** The top-of-page daily summary strip. */
export interface DailySummary {
  ordersFulfilledToday: number;
  /**
   * Returns received/processed today. In ShipHero these are a single event, so
   * we surface one number (see lib/shiphero.ts).
   */
  returnsToday: number;
  newReceivalsToday: number;
  /** Orders created today per Shopify. null when Shopify data is unavailable. */
  ordersCreatedTodayShopify: number | null;
}

export type ShopifyStatus =
  | "ok"
  | "backfill_in_progress"
  | "no_token"
  | "error";

/** The single computed object the dashboard renders. */
export interface Snapshot {
  /** ISO timestamp the snapshot was computed. */
  generatedAt: string;
  skus: SkuRow[];
  summary: DailySummary;
  shiphero: {
    /** "ok" when inventory loaded; "error" when the core ShipHero call failed. */
    status: "ok" | "error";
    /** Underlying error detail when status is "error" (shown in a banner). */
    message?: string;
    /**
     * Non-fatal, per-metric problems (e.g. a summary query that failed) so the
     * dashboard can still render the metrics that did load and flag the rest.
     */
    warnings?: string[];
  };
  shopify: {
    status: ShopifyStatus;
    message?: string;
  };
}

/** Raw per-SKU inventory + lots returned by the ShipHero layer. */
export interface ShipHeroInventory {
  skus: Array<{
    sku: string;
    productName: string | null;
    onHand: { nv: number; pa: number };
    lots: Lot[];
  }>;
}

/** Raw daily fulfillment summary returned by the ShipHero layer. */
export interface ShipHeroSummary {
  ordersFulfilledToday: number;
  returnsToday: number;
  newReceivalsToday: number;
}

/** Persisted bookkeeping for the Shopify rolling-window sync. */
export interface ShopifyMeta {
  /** YYYY-MM-DD of the last day we successfully synced. */
  lastSyncDate: string | null;
  backfill: {
    status: "none" | "in_progress" | "done";
    /** Shopify bulk operation GID, while one is running. */
    bulkOperationId: string | null;
    startedAt: string | null;
  };
  /**
   * Bumped whenever BUNDLE_MAP/SKU_ALIASES/FREEBIE_SKUS change shape so stored
   * daily units-by-SKU entries (computed under the old expansion rules) get
   * invalidated instead of silently polluting new totals. See lib/shopify.ts.
   */
  bundleMapVersion?: number;
}

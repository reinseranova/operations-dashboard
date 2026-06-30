import { getSnapshotForDashboard } from "@/lib/snapshot";
import { isKvConfigured } from "@/lib/kv";
import { SummaryStrip } from "@/components/SummaryStrip";
import { SkuTable } from "@/components/SkuTable";
import { RefreshButton } from "@/components/RefreshButton";
import { LogoutButton } from "@/components/LogoutButton";
import type { ShopifyStatus } from "@/lib/types";

// Always render fresh on request; data freshness is governed by KV / fetch cache
// inside the data layer, not by this page being statically cached.
export const dynamic = "force-dynamic";

function Banner({
  tone,
  children,
}: {
  tone: "amber" | "blue" | "red";
  children: React.ReactNode;
}) {
  const styles = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    red: "border-red-200 bg-red-50 text-red-800",
  }[tone];
  return (
    <div className={`rounded-lg border px-4 py-2.5 text-sm ${styles}`}>
      {children}
    </div>
  );
}

function shopifyBanner(status: ShopifyStatus, message?: string) {
  switch (status) {
    case "no_token":
      return (
        <Banner tone="amber">
          Shopify credentials not connected — sales velocity and “days of stock”
          will show “—” until <code>SHOPIFY_STORE_DOMAIN</code> and{" "}
          <code>SHOPIFY_ADMIN_ACCESS_TOKEN</code> are set.
        </Banner>
      );
    case "backfill_in_progress":
      return (
        <Banner tone="blue">
          Shopify historical backfill in progress — sales velocity will populate
          once the bulk export finishes (usually a few minutes; picked up on the
          next refresh).
        </Banner>
      );
    case "error":
      return (
        <Banner tone="red">
          Couldn’t load Shopify sales data{message ? `: ${message}` : ""}. Stock
          and ShipHero metrics below are still current.
        </Banner>
      );
    default:
      return null;
  }
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function DashboardPage() {
  const snapshot = await getSnapshotForDashboard();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Inventory &amp; Fulfillment Ops
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Last updated {formatTimestamp(snapshot.generatedAt)}
            {!isKvConfigured() && (
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                computed live (no KV cache)
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <RefreshButton />
          <LogoutButton />
        </div>
      </header>

      <div className="mt-5 space-y-2">
        {snapshot.shiphero.stubbed && (
          <Banner tone="amber">
            Showing sample ShipHero data — real credentials not yet connected.
          </Banner>
        )}
        {shopifyBanner(snapshot.shopify.status, snapshot.shopify.message)}
      </div>

      <div className="mt-5">
        <SummaryStrip summary={snapshot.summary} />
      </div>

      <div className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Inventory by SKU
          </h2>
          <span className="text-xs text-slate-400">
            {snapshot.skus.length} SKUs · click a row for lot detail
          </span>
        </div>
        <SkuTable skus={snapshot.skus} />
      </div>

      <footer className="mt-10 text-center text-xs text-slate-400">
        Stock &amp; fulfillment from ShipHero
        {snapshot.shiphero.stubbed ? " (sample data)" : ""} · sales velocity from
        Shopify · aggregated by SKU.
      </footer>
    </main>
  );
}

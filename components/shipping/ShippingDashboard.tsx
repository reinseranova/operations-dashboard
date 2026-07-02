"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ShippingLocationKey } from "@/lib/shipping-location";
import type { Interval, ShippingStatsResponse } from "@/lib/shipping-metrics";
import { LocationToggle, PillGroup } from "./LocationToggle";
import { ShippingKpiCard } from "./ShippingKpiCard";
import { ShippingMetricStrip } from "./ShippingMetricStrip";
import { DeliveryTrendChart } from "./DeliveryTrendChart";
import { ExceptionBreakdownChart } from "./ExceptionBreakdownChart";
import { CarrierPerformanceChart } from "./CarrierPerformanceChart";
import { DestinationChart } from "./DestinationChart";
import { ShippingSetupBanner } from "./ShippingSetupBanner";

const RANGE_OPTIONS = [
  { value: "7" as const, label: "Last 7 days" },
  { value: "30" as const, label: "Last 30 days" },
];
const INTERVAL_OPTIONS: Array<{ value: Interval; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

function pickupSubtitle(loc: ShippingLocationKey): string {
  return loc === "cn"
    ? "Fulfillment → carrier's first scan (ParcelPanel)"
    : "Label created → carrier's first scan (ShipHero × ParcelPanel)";
}

export function ShippingDashboard({
  initialData,
  initialLoc,
  initialRange,
  initialInterval,
}: {
  initialData: ShippingStatsResponse;
  initialLoc: ShippingLocationKey;
  initialRange: 7 | 30;
  initialInterval: Interval;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [loc, setLoc] = useState(initialLoc);
  const [range, setRange] = useState<7 | 30>(initialRange);
  const [interval, setInterval_] = useState<Interval>(initialInterval);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);

  const fetchStats = useCallback(
    async (nextLoc: ShippingLocationKey, nextRange: 7 | 30, nextInterval: Interval) => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/shipping-stats?location=${nextLoc}&range=${nextRange}&interval=${nextInterval}`,
        );
        if (res.ok) setData(await res.json());
      } catch (err) {
        console.error("[shipping-performance] fetch failed:", err);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Skip the initial mount — the server already fetched initialData for the
  // starting filters, so only refetch when the user actually changes one.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!mounted) {
      setMounted(true);
      return;
    }
    fetchStats(loc, range, interval);

    const params = new URLSearchParams(searchParams.toString());
    params.set("loc", loc);
    params.set("range", String(range));
    params.set("interval", interval);
    router.replace(`/shipping-performance?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, range, interval]);

  const { summary, trend, timeSeries, exceptionSeries, carrierBreakdown, countryBreakdown, dataAvailability } =
    data;

  const shipmentCounts = Object.fromEntries(timeSeries.total.map((b) => [b.bucket, b.count]));

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Shipping Performance</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Processing → pickup → transit → delivery, from ParcelPanel &amp; ShipHero
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LocationToggle value={loc} onChange={setLoc} />
          <PillGroup value={String(range) as "7" | "30"} options={RANGE_OPTIONS} onChange={(v) => setRange(Number(v) as 7 | 30)} />
          <PillGroup value={interval} options={INTERVAL_OPTIONS} onChange={setInterval_} />
        </div>
      </header>

      <div className="mt-5 space-y-2">
        {data.isStub && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            Showing sample shipping data — ParcelPanel API key not connected.
          </div>
        )}
        {loading && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
            Updating…
          </div>
        )}
      </div>

      {!dataAvailability.hasData ? (
        <div className="mt-6">
          <ShippingSetupBanner loc={loc} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ShippingKpiCard
              label="Time to Delivery"
              avg={summary.avgTotalDays}
              p85={summary.p85TotalDays}
              count={summary.totalShipments}
              trendDays={trend.total}
            />
            <ShippingKpiCard
              label="Transit Time"
              avg={summary.avgTransitDays}
              p85={summary.p85TransitDays}
              count={summary.totalShipments}
              trendDays={trend.transit}
            />
            <ShippingKpiCard
              label="Processing Time"
              avg={summary.avgProcessingDays}
              p85={summary.p85ProcessingDays}
              count={summary.totalShipments}
              trendDays={trend.processing}
            />
            <ShippingKpiCard
              label="Pickup Time"
              avg={summary.avgPickupDays}
              p85={summary.p85PickupDays}
              count={summary.totalShipments}
              trendDays={trend.pickup}
            />
          </div>

          <div className="mt-4">
            <ShippingMetricStrip summary={summary} />
          </div>

          <div className="mt-6 space-y-4">
            <DeliveryTrendChart title="Time to Delivery" data={timeSeries.total} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DeliveryTrendChart
                title="Transit Time"
                subtitle="Carrier pickup → delivery, per ParcelPanel"
                data={timeSeries.transit}
              />
              <DeliveryTrendChart
                title="Processing Time"
                subtitle="Order placed → warehouse handoff"
                data={timeSeries.processing}
              />
            </div>

            {summary.pickupDataAvailable ? (
              <DeliveryTrendChart
                title="Pickup Time"
                subtitle={pickupSubtitle(loc)}
                data={timeSeries.pickup}
              />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
                Pickup time data isn&apos;t available yet. This metric requires carrier pickup
                scans from ParcelPanel. It will populate as delivered orders accumulate.
              </div>
            )}

            <ExceptionBreakdownChart
              data={exceptionSeries}
              shipmentCounts={shipmentCounts}
              isChina={loc === "cn"}
            />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CarrierPerformanceChart data={carrierBreakdown} />
              <DestinationChart data={countryBreakdown} />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

import { Suspense } from "react";
import { getShippingStats } from "@/lib/shipping-stats";
import type { ShippingLocationKey } from "@/lib/shipping-location";
import type { Interval } from "@/lib/shipping-metrics";
import { ShippingDashboard } from "@/components/shipping/ShippingDashboard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parseLoc(v: string | undefined): ShippingLocationKey {
  return v === "us" ? "us" : "cn";
}
function parseRange(v: string | undefined): 7 | 30 {
  return v === "7" ? 7 : 30;
}
function parseInterval(v: string | undefined): Interval {
  return v === "week" || v === "month" ? v : "day";
}

export default async function ShippingPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const loc = parseLoc(single(params.loc));
  const range = parseRange(single(params.range));
  const interval = parseInterval(single(params.interval));

  const initialData = await getShippingStats(loc, interval, range);

  return (
    <Suspense fallback={null}>
      <ShippingDashboard
        initialData={initialData}
        initialLoc={loc}
        initialRange={range}
        initialInterval={interval}
      />
    </Suspense>
  );
}

/**
 * Core aggregation for the Shipping Performance feature — reads the raw daily
 * KV lists written by lib/shipping-storage.ts and produces the shape
 * ShippingDashboard renders. Shared by app/api/shipping-stats/route.ts (client
 * refetches on filter change) and app/shipping-performance/page.tsx (initial
 * server-rendered data), so both take the exact same path rather than the
 * page doing an HTTP self-fetch.
 *
 * Caches the raw 60-day pull (30 for the current window + 30 for the prior
 * window, used for the trend badges) for 15 minutes under ship:cache:{loc}.
 * Every delivery/exception write busts that cache (see lib/shipping-storage.ts),
 * so a fresh webhook shows up on the next request rather than waiting out the TTL.
 *
 * Falls straight to generateStubStats() when PARCELPANEL_API_KEY isn't set —
 * per the stub rule, no real webhook can ever verify without that key, so
 * there's nothing genuine in KV to read anyway.
 */
import { getShippingKv } from "./shipping-kv";
import { generateStubStats, isParcelPanelConfigured } from "./parcelpanel";
import { DELIVERY_SLA_DAYS, type ShippingLocationKey } from "./shipping-location";
import {
  average,
  bucketByInterval,
  computeCarrierBreakdown,
  exceptionLabel,
  parseFloats,
  percentile,
  EXCEPTION_CATEGORY_ORDER,
  type CountryStat,
  type ExceptionBucketRow,
  type Interval,
  type ShippingStatsResponse,
} from "./shipping-metrics";

const RAW_WINDOW_DAYS = 60; // 30 current + 30 prior, enough for both range options

interface DailyRaw {
  day: string;
  total: number[];
  transit: number[];
  processing: number[];
  pickup: number[];
  carriers: string[];
  countries: string[];
  excTypes: string[];
  excCount: number;
  customsDelay: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastNDays(n: number): string[] {
  const today = ymd(new Date());
  const days: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(ymd(d));
  }
  return days; // newest first
}

async function loadDailyData(loc: ShippingLocationKey, bust: boolean): Promise<DailyRaw[]> {
  const kv = getShippingKv();
  if (!kv) return [];

  const cacheKey = `ship:cache:${loc}`;
  if (!bust) {
    try {
      const cached = await kv.get<DailyRaw[]>(cacheKey);
      if (cached) return cached;
    } catch (err) {
      console.error("[shipping-stats] cache read failed:", err);
    }
  }

  const days = lastNDays(RAW_WINDOW_DAYS);
  const pipeline = kv.pipeline();
  for (const day of days) {
    pipeline.lrange(`ship:${loc}:total:${day}`, 0, -1);
    pipeline.lrange(`ship:${loc}:transit:${day}`, 0, -1);
    pipeline.lrange(`ship:${loc}:processing:${day}`, 0, -1);
    pipeline.lrange(`ship:${loc}:pickup:${day}`, 0, -1);
    pipeline.lrange(`ship:${loc}:carrier:${day}`, 0, -1);
    pipeline.lrange(`ship:${loc}:country:${day}`, 0, -1);
    pipeline.lrange(`ship:${loc}:exc_type:${day}`, 0, -1);
    pipeline.get(`ship:${loc}:exc_count:${day}`);
    pipeline.get(`ship:${loc}:customs_delay:${day}`);
  }

  let results: unknown[];
  try {
    results = (await pipeline.exec()) as unknown[];
  } catch (err) {
    console.error("[shipping-stats] KV pipeline read failed:", err);
    return [];
  }

  const perDayFields = 9;
  const dailyData: DailyRaw[] = days.map((day, i) => {
    const base = i * perDayFields;
    return {
      day,
      total: parseFloats((results[base + 0] as unknown[]) ?? []),
      transit: parseFloats((results[base + 1] as unknown[]) ?? []),
      processing: parseFloats((results[base + 2] as unknown[]) ?? []),
      pickup: parseFloats((results[base + 3] as unknown[]) ?? []),
      carriers: ((results[base + 4] as unknown[]) ?? []) as string[],
      countries: ((results[base + 5] as unknown[]) ?? []) as string[],
      excTypes: ((results[base + 6] as unknown[]) ?? []) as string[],
      excCount: Number(results[base + 7] ?? 0) || 0,
      customsDelay: Number(results[base + 8] ?? 0) || 0,
    };
  });

  try {
    await kv.set(cacheKey, dailyData, { ex: 900 });
  } catch (err) {
    console.error("[shipping-stats] cache write failed:", err);
  }

  return dailyData;
}

function bucketKeyFor(day: string, interval: Interval): string {
  if (interval === "day") return day;
  if (interval === "month") return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return ymd(d);
}

function bucketLabelFor(bucket: string, interval: Interval): string {
  if (interval === "month") {
    return new Date(`${bucket}-01T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const label = new Date(`${bucket}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return interval === "week" ? `Week of ${label}` : label;
}

function buildExceptionSeries(
  window: DailyRaw[],
  loc: ShippingLocationKey,
  interval: Interval,
): ExceptionBucketRow[] {
  const byBucketKey = new Map<string, { counts: Record<string, number>; customsDelays: number }>();

  for (const d of window) {
    const key = bucketKeyFor(d.day, interval);
    const existing = byBucketKey.get(key) ?? {
      counts: Object.fromEntries(EXCEPTION_CATEGORY_ORDER.map((c) => [c, 0])) as Record<
        string,
        number
      >,
      customsDelays: 0,
    };
    for (const substatus of d.excTypes) existing.counts[exceptionLabel(substatus)]++;
    existing.customsDelays += d.customsDelay;
    byBucketKey.set(key, existing);
  }

  return Array.from(byBucketKey.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, v]) => ({
      bucket,
      label: bucketLabelFor(bucket, interval),
      counts: v.counts,
      ...(loc === "cn" ? { customsDelays: v.customsDelays } : {}),
    }));
}

function buildCountryBreakdown(window: DailyRaw[]): CountryStat[] {
  const map = new Map<string, number[]>();
  for (const d of window) {
    d.countries.forEach((c, i) => {
      if (!map.has(c)) map.set(c, []);
      if (d.total[i] != null) map.get(c)!.push(d.total[i]);
    });
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([country, values]) => ({
      country,
      count: values.length,
      avg: average(values) ?? 0,
    }));
}

export async function getShippingStats(
  loc: ShippingLocationKey,
  interval: Interval,
  range: 7 | 30,
  bust = false,
): Promise<ShippingStatsResponse> {
  if (!isParcelPanelConfigured()) {
    return generateStubStats(loc, interval, range);
  }

  const allDays = await loadDailyData(loc, bust); // newest-first, length RAW_WINDOW_DAYS (or 0 if no KV)
  const current = allDays.slice(0, range);
  const previous = allDays.slice(range, range * 2);

  const flat = (window: DailyRaw[], key: "total" | "transit" | "processing" | "pickup") =>
    window.flatMap((d) => d[key]);

  const currentTotal = flat(current, "total");
  const currentTransit = flat(current, "transit");
  const currentProcessing = flat(current, "processing");
  const currentPickup = flat(current, "pickup");
  const currentCarriers = current.flatMap((d) => d.carriers);

  const totalShipments = currentTotal.length;
  const slaDays = DELIVERY_SLA_DAYS[loc];
  const onTimeCount = currentTotal.filter((d) => d <= slaDays).length;
  const exceptionCount = current.reduce((sum, d) => sum + (d.excCount || d.excTypes.length), 0);
  const failedAttemptCount = current.reduce(
    (sum, d) =>
      sum +
      d.excTypes.filter(
        (s) => exceptionLabel(s) === "Failed Attempt" || exceptionLabel(s) === "Recipient Unavailable",
      ).length,
    0,
  );

  const trendDelta = (curr: number[], prev: number[]): number | null => {
    const a = average(curr);
    const b = average(prev);
    if (a === null || b === null) return null;
    return a - b;
  };

  return {
    location: loc,
    interval,
    isStub: false,
    summary: {
      totalShipments,
      avgTotalDays: average(currentTotal),
      p85TotalDays: percentile(currentTotal, 0.85),
      avgTransitDays: average(currentTransit),
      p85TransitDays: percentile(currentTransit, 0.85),
      avgProcessingDays: average(currentProcessing),
      p85ProcessingDays: percentile(currentProcessing, 0.85),
      avgPickupDays: average(currentPickup),
      p85PickupDays: percentile(currentPickup, 0.85),
      exceptionCount,
      exceptionRate: totalShipments > 0 ? exceptionCount / totalShipments : null,
      onTimeRate: totalShipments > 0 ? onTimeCount / totalShipments : null,
      failedAttemptRate: totalShipments > 0 ? failedAttemptCount / totalShipments : null,
      slaDays,
      pickupDataAvailable: currentPickup.length > 0,
    },
    trend: {
      total: trendDelta(currentTotal, flat(previous, "total")),
      transit: trendDelta(currentTransit, flat(previous, "transit")),
      processing: trendDelta(currentProcessing, flat(previous, "processing")),
      pickup: trendDelta(currentPickup, flat(previous, "pickup")),
    },
    timeSeries: {
      total: bucketByInterval(current.map((d) => ({ day: d.day, values: d.total })), interval),
      transit: bucketByInterval(current.map((d) => ({ day: d.day, values: d.transit })), interval),
      processing: bucketByInterval(current.map((d) => ({ day: d.day, values: d.processing })), interval),
      pickup: bucketByInterval(current.map((d) => ({ day: d.day, values: d.pickup })), interval),
    },
    exceptionSeries: buildExceptionSeries(current, loc, interval),
    carrierBreakdown: computeCarrierBreakdown(currentCarriers, currentTransit),
    countryBreakdown: buildCountryBreakdown(current),
    dataAvailability: {
      oldestDay: current[current.length - 1]?.day ?? "",
      newestDay: current[0]?.day ?? "",
      hasData: totalShipments > 0,
    },
  };
}

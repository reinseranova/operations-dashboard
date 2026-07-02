/**
 * ParcelPanel integration layer.
 *
 * ParcelPanel has no bulk API — all data arrives via webhooks (see
 * app/api/webhooks/parcelpanel/route.ts), so this file holds the webhook
 * payload shape, HMAC signature verification, and the stub-data generator.
 *
 * Stub rule: when PARCELPANEL_API_KEY is not set, webhook signatures can never
 * verify (see verifyParcelPanelWebhook below), so no real data is ever written
 * to KV. generateStubStats() is what every shipping-stats response falls back
 * to in that case, always with isStub: true, mirroring the existing ShipHero
 * stub pattern (lib/shiphero.ts had the same role before ShipHero was live).
 */
import crypto from "crypto";
import {
  CARRIER_LOCATION_MAP,
  DELIVERY_SLA_DAYS,
  type ShippingLocationKey,
} from "./shipping-location";
import {
  average,
  percentile,
  EXCEPTION_CATEGORY_ORDER,
  type CarrierStat,
  type CountryStat,
  type ExceptionBucketRow,
  type Interval,
  type ShippingStatsResponse,
  type TimeSeriesBucket,
} from "./shipping-metrics";

export type PPStatus =
  | "DELIVERED"
  | "EXCEPTION"
  | "FAILED_ATTEMPT"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "READY_FOR_PICKUP"
  | "INFO_RECEIVED"
  | "PENDING"
  | "EXPIRED";

export type PPWebhook = {
  order_id: number;
  order_number: string;
  status: PPStatus;
  substatus: string;
  substatus_label: string;
  tracking_number: string;
  carrier: { name: string; code: string };
  transit_time: number; // days — ParcelPanel pre-computes this
  residence_time: number | null; // days since last tracking update
  order_date: string; // ISO8601
  fulfillment_date: string | null;
  pickup_date: string | null;
  delivery_date: string | null;
  location: { name: string | null };
  shipping_address: {
    country: string;
    country_code: string;
  };
};

export function isParcelPanelConfigured(): boolean {
  return Boolean(process.env.PARCELPANEL_API_KEY);
}

export function verifyParcelPanelWebhook(
  rawBody: string,
  signature: string,
): boolean {
  const key = process.env.PARCELPANEL_API_KEY;
  if (!key || !signature) return false;
  const computed = crypto.createHmac("sha256", key).update(rawBody).digest("base64");
  try {
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stub data — deterministic per (location, interval, day-offset) so charts
// stay stable across requests instead of jittering on every reload.
// ---------------------------------------------------------------------------

function seedFor(...parts: Array<string | number>): number {
  const str = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 — small deterministic PRNG, seeded so stub numbers are stable. */
function rand(seed: number): number {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return ymd(d);
}

function lastNDays(n: number): string[] {
  const today = ymd(new Date());
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(addDays(today, -i));
  return days;
}

const STUB_BASELINE: Record<
  ShippingLocationKey,
  { total: number; transit: number; processing: number; pickup: number }
> = {
  cn: { total: 13.5, transit: 8.5, processing: 1.4, pickup: 1.1 },
  us: { total: 5.5, transit: 3.2, processing: 0.9, pickup: 0.6 },
};

function stubSeries(
  loc: ShippingLocationKey,
  metric: string,
  baseline: number,
  days: string[],
  spread: number,
  countPerDay: number,
  interval: Interval,
): TimeSeriesBucket[] {
  const buckets = new Map<string, number[]>();
  days.forEach((day, i) => {
    const values: number[] = [];
    const dayCount = Math.max(3, Math.round(countPerDay * (0.7 + 0.6 * rand(seedFor(loc, metric, day, "n")))));
    for (let j = 0; j < dayCount; j++) {
      const r = rand(seedFor(loc, metric, day, j));
      const trendNudge = (i / days.length) * spread * 0.3; // gentle drift
      values.push(Math.max(0.1, baseline + (r - 0.5) * spread + trendNudge));
    }
    const key =
      interval === "day" ? day : interval === "week" ? isoWeekStart(day) : day.slice(0, 7);
    const existing = buckets.get(key) ?? [];
    existing.push(...values);
    buckets.set(key, existing);
  });
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, values]) => ({
      bucket,
      label: bucketLabel(bucket, interval),
      avg: average(values),
      p85: percentile(values, 0.85),
      count: values.length,
    }));
}

function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return ymd(d);
}

function bucketLabel(bucket: string, interval: Interval): string {
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

function stubCarriers(loc: ShippingLocationKey): CarrierStat[] {
  const carriers = Object.entries(CARRIER_LOCATION_MAP)
    .filter(([, l]) => l === loc)
    .map(([code]) => code);
  const baseline = STUB_BASELINE[loc].transit;
  return carriers
    .map((carrier, i) => {
      const r = rand(seedFor(loc, "carrier", carrier));
      return {
        carrier,
        count: Math.round(40 + r * 400),
        avg: Math.max(0.5, baseline + (r - 0.5) * 3 + i * 0.15),
        p85: Math.max(0.8, baseline + 1.5 + r * 2),
      };
    })
    .sort((a, b) => a.avg - b.avg);
}

const STUB_COUNTRIES: Record<ShippingLocationKey, string[]> = {
  cn: ["United States", "Canada", "United Kingdom", "Australia", "Germany", "France", "Spain", "Brazil"],
  us: ["United States", "Canada", "United Kingdom", "Australia", "Mexico"],
};

function stubCountries(loc: ShippingLocationKey): CountryStat[] {
  const baseline = STUB_BASELINE[loc].total;
  return STUB_COUNTRIES[loc]
    .map((country, i) => {
      const r = rand(seedFor(loc, "country", country));
      return {
        country,
        count: Math.round((STUB_COUNTRIES[loc].length - i) * (80 + r * 200)),
        avg: Math.max(1, baseline + (r - 0.3) * 4 + i * 0.6),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function stubExceptionSeries(
  loc: ShippingLocationKey,
  days: string[],
  interval: Interval,
): ExceptionBucketRow[] {
  const buckets = new Map<string, { counts: Record<string, number>; customsDelays: number }>();
  for (const day of days) {
    const key =
      interval === "day" ? day : interval === "week" ? isoWeekStart(day) : day.slice(0, 7);
    const entry = buckets.get(key) ?? {
      counts: Object.fromEntries(EXCEPTION_CATEGORY_ORDER.map((c) => [c, 0])),
      customsDelays: 0,
    };
    for (const category of EXCEPTION_CATEGORY_ORDER) {
      const r = rand(seedFor(loc, "exc", day, category));
      const weight = category === "Customs Hold" && loc === "cn" ? 1.6 : 1;
      entry.counts[category] += Math.round(r * 3 * weight);
    }
    if (loc === "cn") {
      entry.customsDelays += Math.round(rand(seedFor(loc, "customs-delay", day)) * 4);
    }
    buckets.set(key, entry);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, v]) => ({
      bucket,
      label: bucketLabel(bucket, interval),
      counts: v.counts,
      ...(loc === "cn" ? { customsDelays: v.customsDelays } : {}),
    }));
}

export function generateStubStats(
  loc: ShippingLocationKey,
  interval: Interval,
  rangeDays: 7 | 30,
): ShippingStatsResponse {
  const days = lastNDays(rangeDays);
  const baseline = STUB_BASELINE[loc];
  const slaDays = DELIVERY_SLA_DAYS[loc];

  const total = stubSeries(loc, "total", baseline.total, days, baseline.total * 0.5, 220, interval);
  const transit = stubSeries(loc, "transit", baseline.transit, days, baseline.transit * 0.45, 220, interval);
  const processing = stubSeries(loc, "processing", baseline.processing, days, 1.2, 220, interval);
  const pickup = stubSeries(loc, "pickup", baseline.pickup, days, 0.8, 220, interval);

  const allTotalAvgs = total.map((b) => b.avg).filter((v): v is number => v !== null);
  const totalShipments = total.reduce((sum, b) => sum + b.count, 0);
  const exceptionSeries = stubExceptionSeries(loc, days, interval);
  const exceptionCount = exceptionSeries.reduce(
    (sum, b) => sum + Object.values(b.counts).reduce((s, c) => s + c, 0),
    0,
  );
  const failedAttemptCount = exceptionSeries.reduce(
    (sum, b) => sum + (b.counts["Failed Attempt"] ?? 0) + (b.counts["Recipient Unavailable"] ?? 0),
    0,
  );
  const onTimeShare = 0.88 + rand(seedFor(loc, "ontime")) * 0.08;

  return {
    location: loc,
    interval,
    isStub: true,
    summary: {
      totalShipments,
      avgTotalDays: average(allTotalAvgs),
      p85TotalDays: percentile(allTotalAvgs, 0.85) ?? (allTotalAvgs[allTotalAvgs.length - 1] ?? null),
      avgTransitDays: average(transit.map((b) => b.avg).filter((v): v is number => v !== null)),
      p85TransitDays: transit[transit.length - 1]?.p85 ?? null,
      avgProcessingDays: average(processing.map((b) => b.avg).filter((v): v is number => v !== null)),
      p85ProcessingDays: processing[processing.length - 1]?.p85 ?? null,
      avgPickupDays: average(pickup.map((b) => b.avg).filter((v): v is number => v !== null)),
      p85PickupDays: pickup[pickup.length - 1]?.p85 ?? null,
      exceptionCount,
      exceptionRate: totalShipments > 0 ? exceptionCount / totalShipments : null,
      onTimeRate: onTimeShare,
      failedAttemptRate: totalShipments > 0 ? failedAttemptCount / totalShipments : null,
      slaDays,
      pickupDataAvailable: true,
    },
    trend: {
      total: (rand(seedFor(loc, "trend-total")) - 0.5) * 1.6,
      transit: (rand(seedFor(loc, "trend-transit")) - 0.5) * 1.2,
      processing: (rand(seedFor(loc, "trend-processing")) - 0.5) * 0.6,
      pickup: (rand(seedFor(loc, "trend-pickup")) - 0.5) * 0.4,
    },
    timeSeries: { total, transit, processing, pickup },
    exceptionSeries,
    carrierBreakdown: stubCarriers(loc),
    countryBreakdown: stubCountries(loc),
    dataAvailability: {
      oldestDay: days[0],
      newestDay: days[days.length - 1],
      hasData: true,
    },
  };
}

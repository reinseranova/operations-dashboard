/**
 * Pure statistics helpers + response types shared by the real (KV-backed) and
 * stub (lib/parcelpanel.ts) data paths for /api/shipping-stats, so the page
 * renders identically regardless of which one produced the numbers.
 */

export function percentile(values: number[], p: number): number | null {
  if (values.length < 5) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Parse an LRANGE result (strings from Redis) into floats, dropping nulls/NaN. */
export function parseFloats(raw: unknown[]): number[] {
  return (raw as string[])
    .map((v) => parseFloat(v))
    .filter((v) => !isNaN(v) && isFinite(v));
}

export interface DayBucketInput {
  day: string; // YYYY-MM-DD
  values: number[];
}

export interface TimeSeriesBucket {
  bucket: string; // YYYY-MM-DD (day) | YYYY-MM-DD of week start (week) | YYYY-MM (month)
  label: string; // human-readable axis label
  avg: number | null;
  p85: number | null;
  count: number;
}

export type Interval = "day" | "week" | "month";

function isoWeekStart(dayYmd: string): string {
  const d = new Date(`${dayYmd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  const diff = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatMonthLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function bucketKeyFor(day: string, interval: Interval): string {
  if (interval === "day") return day;
  if (interval === "week") return isoWeekStart(day);
  return day.slice(0, 7); // YYYY-MM
}

function labelFor(bucket: string, interval: Interval): string {
  if (interval === "day") return formatDayLabel(bucket);
  if (interval === "week") return `Week of ${formatDayLabel(bucket)}`;
  return formatMonthLabel(bucket);
}

/** Group daily [day, values[]] pairs into day/week/month buckets with avg + P85. */
export function bucketByInterval(
  dailyData: DayBucketInput[],
  interval: Interval,
): TimeSeriesBucket[] {
  const grouped = new Map<string, number[]>();
  for (const { day, values } of dailyData) {
    const key = bucketKeyFor(day, interval);
    const existing = grouped.get(key) ?? [];
    existing.push(...values);
    grouped.set(key, existing);
  }
  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, values]) => ({
      bucket,
      label: labelFor(bucket, interval),
      avg: average(values),
      p85: percentile(values, 0.85),
      count: values.length,
    }));
}

/** Group a flat [day, count] series (e.g. customs delay events) into buckets. */
export function bucketCountsByInterval(
  dailyCounts: Array<{ day: string; count: number }>,
  interval: Interval,
): Array<{ bucket: string; label: string; count: number }> {
  const grouped = new Map<string, number>();
  for (const { day, count } of dailyCounts) {
    const key = bucketKeyFor(day, interval);
    grouped.set(key, (grouped.get(key) ?? 0) + count);
  }
  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, count]) => ({ bucket, label: labelFor(bucket, interval), count }));
}

export interface CarrierStat {
  carrier: string;
  count: number;
  avg: number;
  p85: number | null;
}

/** Carrier breakdown from parallel arrays: carrier codes + transit-time values. */
export function computeCarrierBreakdown(
  carriers: string[],
  transitValues: number[],
): CarrierStat[] {
  const map = new Map<string, number[]>();
  carriers.forEach((c, i) => {
    if (transitValues[i] == null) return;
    if (!map.has(c)) map.set(c, []);
    map.get(c)!.push(transitValues[i]);
  });
  return Array.from(map.entries())
    .filter(([, v]) => v.length >= 5)
    .map(([carrier, values]) => ({
      carrier,
      count: values.length,
      avg: average(values) ?? 0,
      p85: percentile(values, 0.85),
    }))
    .sort((a, b) => a.avg - b.avg); // fastest first
}

export interface CountryStat {
  country: string;
  count: number;
  avg: number;
}

// Map substatus codes to human-readable exception types. Any substatus not
// listed here (including unrecognized ones) rolls up into "Other".
export const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  Exception_003: "Returned",
  Exception_004: "Address Issue",
  Exception_005: "Damaged",
  Exception_006: "Lost",
  Exception_007: "Customs Hold",
  FailedAttempt_001: "Failed Attempt",
  FailedAttempt_002: "Recipient Unavailable",
  FailedAttempt_004: "Weather Delay",
};

// Fixed stacking/legend order for the exception breakdown chart — colors are
// assigned to this order in ExceptionBreakdownChart, never re-sorted by value.
export const EXCEPTION_CATEGORY_ORDER = [
  "Lost",
  "Damaged",
  "Customs Hold",
  "Returned",
  "Address Issue",
  "Recipient Unavailable",
  "Failed Attempt",
  "Weather Delay",
  "Other",
] as const;

export function exceptionLabel(substatus: string): string {
  return EXCEPTION_TYPE_LABELS[substatus] ?? "Other";
}

export interface ShippingSummary {
  totalShipments: number;
  avgTotalDays: number | null;
  p85TotalDays: number | null;
  avgTransitDays: number | null;
  p85TransitDays: number | null;
  avgProcessingDays: number | null;
  p85ProcessingDays: number | null;
  avgPickupDays: number | null;
  p85PickupDays: number | null;
  exceptionCount: number;
  exceptionRate: number | null;
  onTimeRate: number | null;
  failedAttemptRate: number | null;
  slaDays: number;
  pickupDataAvailable: boolean;
}

/** avg(current window) − avg(equal-length prior window), per metric. Positive = slower. */
export interface ShippingTrend {
  total: number | null;
  transit: number | null;
  processing: number | null;
  pickup: number | null;
}

export interface ExceptionBucketRow {
  bucket: string;
  label: string;
  counts: Record<string, number>; // category label -> count
  customsDelays?: number; // cn only: InTransit_005 overlay
}

export interface ShippingStatsResponse {
  location: "cn" | "us";
  interval: Interval;
  isStub: boolean;
  summary: ShippingSummary;
  trend: ShippingTrend;
  timeSeries: {
    total: TimeSeriesBucket[];
    transit: TimeSeriesBucket[];
    processing: TimeSeriesBucket[];
    pickup: TimeSeriesBucket[];
  };
  exceptionSeries: ExceptionBucketRow[];
  carrierBreakdown: CarrierStat[];
  countryBreakdown: CountryStat[];
  dataAvailability: {
    oldestDay: string;
    newestDay: string;
    hasData: boolean;
  };
}

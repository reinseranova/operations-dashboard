/**
 * KV writes for the Shipping Performance feature — one atomic pipeline per
 * webhook event, keyed by metric/location/day per the design in the task spec
 * (ship:{loc}:{metric}:{YYYY-MM-DD} lists of floats/strings, +TTL). Every write
 * here is best-effort: a KV failure is logged and swallowed so the webhook
 * handler can still return 200 (ParcelPanel/ShipHero must not see a failure
 * and start retrying on our own storage hiccups).
 */
import { getShippingKv } from "./shipping-kv";
import type { PPWebhook } from "./parcelpanel";
import type { ShippingLocationKey } from "./shipping-location";

const TTL_SECONDS = 35 * 24 * 60 * 60; // 35 days — a little past the 30-day window
const LABEL_TTL_SECONDS = 7 * 24 * 60 * 60;

function shipKey(loc: ShippingLocationKey, metric: string, day: string): string {
  return `ship:${loc}:${metric}:${day}`;
}

function labelKey(orderNumber: string): string {
  return `ship:label:${orderNumber}`;
}

function cacheKey(loc: ShippingLocationKey): string {
  return `ship:cache:${loc}`;
}

/** Store a ShipHero shipment-label ship_date, used for precise USA pickup time. */
export async function writeShipLabel(orderNumber: string, shipDateIso: string): Promise<void> {
  const kv = getShippingKv();
  if (!kv) return;
  try {
    await kv.set(labelKey(orderNumber), shipDateIso, { ex: LABEL_TTL_SECONDS });
  } catch (err) {
    console.error("[shipping] writeShipLabel failed:", err);
  }
}

export async function readShipLabel(orderNumber: string): Promise<string | null> {
  const kv = getShippingKv();
  if (!kv) return null;
  try {
    return (await kv.get<string>(labelKey(orderNumber))) ?? null;
  } catch (err) {
    console.error("[shipping] readShipLabel failed:", err);
    return null;
  }
}

/** On a DELIVERED ParcelPanel webhook: derive + persist all four time metrics. */
export async function writeDeliveryMetrics(
  payload: PPWebhook,
  loc: ShippingLocationKey,
): Promise<void> {
  const kv = getShippingKv();
  if (!kv || !payload.delivery_date) return;

  const day = payload.delivery_date.slice(0, 10);
  const msPerDay = 86_400_000;

  const orderDate = new Date(payload.order_date).getTime();
  const fulfillmentDate = payload.fulfillment_date ? new Date(payload.fulfillment_date).getTime() : null;
  const pickupDate = payload.pickup_date ? new Date(payload.pickup_date).getTime() : null;
  const deliveryDate = new Date(payload.delivery_date).getTime();

  const totalDays = (deliveryDate - orderDate) / msPerDay;
  const transitDays = payload.transit_time; // pre-computed by ParcelPanel
  const processingDays = fulfillmentDate != null ? (fulfillmentDate - orderDate) / msPerDay : null;

  // Pickup: USA prefers the ShipHero ship_date (precise carrier handoff);
  // China only has ParcelPanel's fulfillment_date to work from.
  let pickupDays: number | null = null;
  if (pickupDate != null && fulfillmentDate != null) {
    if (loc === "us") {
      const rawShipDate = await readShipLabel(payload.order_number);
      pickupDays = rawShipDate
        ? (pickupDate - new Date(rawShipDate).getTime()) / msPerDay
        : (pickupDate - fulfillmentDate) / msPerDay;
    } else {
      pickupDays = (pickupDate - fulfillmentDate) / msPerDay;
    }
  }

  const pipeline = kv.pipeline();

  pipeline.rpush(shipKey(loc, "total", day), totalDays);
  pipeline.expire(shipKey(loc, "total", day), TTL_SECONDS);

  if (transitDays != null) {
    pipeline.rpush(shipKey(loc, "transit", day), transitDays);
    pipeline.expire(shipKey(loc, "transit", day), TTL_SECONDS);
  }
  if (processingDays != null && processingDays >= 0) {
    pipeline.rpush(shipKey(loc, "processing", day), processingDays);
    pipeline.expire(shipKey(loc, "processing", day), TTL_SECONDS);
  }
  if (pickupDays != null && pickupDays >= 0) {
    pipeline.rpush(shipKey(loc, "pickup", day), pickupDays);
    pipeline.expire(shipKey(loc, "pickup", day), TTL_SECONDS);
  }
  if (payload.carrier?.code) {
    pipeline.rpush(shipKey(loc, "carrier", day), payload.carrier.code);
    pipeline.expire(shipKey(loc, "carrier", day), TTL_SECONDS);
  }
  if (payload.shipping_address?.country) {
    pipeline.rpush(shipKey(loc, "country", day), payload.shipping_address.country);
    pipeline.expire(shipKey(loc, "country", day), TTL_SECONDS);
  }

  // Bust the 15-minute stats cache for this location so the next read is fresh.
  pipeline.del(cacheKey(loc));

  try {
    await pipeline.exec();
  } catch (err) {
    console.error("[shipping] KV write failed (delivery metrics), continuing:", err);
    // Do NOT throw — the webhook must still return 200.
  }
}

/** On an EXCEPTION or FAILED_ATTEMPT webhook: bump the day's exception counters. */
export async function writeExceptionEvent(
  payload: PPWebhook,
  loc: ShippingLocationKey,
): Promise<void> {
  const kv = getShippingKv();
  if (!kv) return;

  const day = new Date().toISOString().slice(0, 10);
  const pipeline = kv.pipeline();
  pipeline.incr(shipKey(loc, "exc_count", day));
  pipeline.expire(shipKey(loc, "exc_count", day), TTL_SECONDS);
  if (payload.substatus) {
    pipeline.rpush(shipKey(loc, "exc_type", day), payload.substatus);
    pipeline.expire(shipKey(loc, "exc_type", day), TTL_SECONDS);
  }
  pipeline.del(cacheKey(loc));

  try {
    await pipeline.exec();
  } catch (err) {
    console.error("[shipping] Exception KV write failed:", err);
  }
}

/**
 * China-only: IN_TRANSIT webhooks with substatus InTransit_005 (customs hold in
 * transit) drive the "Customs Delays" overlay line on the exception chart. This
 * is tracked separately from writeExceptionEvent because IN_TRANSIT is not an
 * EXCEPTION/FAILED_ATTEMPT status and must not inflate the exception rate.
 */
export async function writeCustomsDelayEvent(loc: ShippingLocationKey): Promise<void> {
  const kv = getShippingKv();
  if (!kv || loc !== "cn") return;

  const day = new Date().toISOString().slice(0, 10);
  const pipeline = kv.pipeline();
  pipeline.incr(shipKey(loc, "customs_delay", day));
  pipeline.expire(shipKey(loc, "customs_delay", day), TTL_SECONDS);
  pipeline.del(cacheKey(loc));

  try {
    await pipeline.exec();
  } catch (err) {
    console.error("[shipping] Customs delay KV write failed:", err);
  }
}

/**
 * POST /api/webhooks/parcelpanel — receives ParcelPanel shipment status events.
 *
 * Register in ParcelPanel Dashboard → Integration → Webhooks, event
 * "shipment_status/any_update". Always returns 200 for anything except a bad
 * signature so ParcelPanel doesn't retry-storm us over our own bugs.
 *
 * This route is exempted from the session-cookie auth middleware (see
 * middleware.ts) — ParcelPanel calls it directly and can't hold our login
 * cookie, the same reason /api/refresh is exempted. It authenticates via HMAC
 * signature instead (verifyParcelPanelWebhook).
 */
import { NextRequest } from "next/server";
import { verifyParcelPanelWebhook, type PPWebhook } from "@/lib/parcelpanel";
import { resolveLocation } from "@/lib/shipping-location";
import {
  writeCustomsDelayEvent,
  writeDeliveryMetrics,
  writeExceptionEvent,
} from "@/lib/shipping-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Set true only while verifying LOCATION_NAME_MAP against live payloads (see
// lib/shipping-location.ts) — logs payload.location.name for the first 20
// webhooks this instance sees, then stops.
let loggedPayloads = 0;
const MAX_LOGGED_PAYLOADS = 20;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("X-ParcelPanel-HMAC-SHA256") ?? "";

  if (!verifyParcelPanelWebhook(rawBody, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const payload: PPWebhook = JSON.parse(rawBody);

    if (loggedPayloads < MAX_LOGGED_PAYLOADS) {
      loggedPayloads++;
      console.log(
        `[pp-webhook] (${loggedPayloads}/${MAX_LOGGED_PAYLOADS}) location.name="${payload.location?.name}" carrier="${payload.carrier?.code}" status=${payload.status}`,
      );
    }

    const loc = resolveLocation(payload.location?.name, payload.carrier?.code ?? "");

    if (loc === "unknown") {
      console.warn("[pp-webhook] Unknown location for order:", payload.order_number);
      return new Response("OK", { status: 200 });
    }

    if (payload.status === "DELIVERED" && payload.delivery_date) {
      await writeDeliveryMetrics(payload, loc);
    } else if (payload.status === "EXCEPTION" || payload.status === "FAILED_ATTEMPT") {
      await writeExceptionEvent(payload, loc);
    } else if (payload.status === "IN_TRANSIT" && payload.substatus === "InTransit_005") {
      await writeCustomsDelayEvent(loc);
    }
    // Other statuses (OUT_FOR_DELIVERY, READY_FOR_PICKUP, INFO_RECEIVED,
    // PENDING, EXPIRED, other IN_TRANSIT substatuses): 200, no write needed.
  } catch (err) {
    console.error("[pp-webhook] Error processing webhook:", err);
    // Still 200 — don't trigger ParcelPanel retries for our own bugs.
  }

  return new Response("OK", { status: 200 });
}

/**
 * POST /api/webhooks/shiphero-shipment — receives ShipHero "Shipment Update"
 * webhooks (developer.shiphero.com/webhooks/shipment-update-webhook), fired
 * when a shipping label is created for a Lansil USA order. Stores ship_date
 * keyed by order number so writeDeliveryMetrics can compute precise USA
 * pickup time (label created → carrier's first scan) instead of falling back
 * to fulfillment_date.
 *
 * Auth: ShipHero webhooks don't carry a request signature the way ParcelPanel
 * does, so — like ShipHero's own OAuth calls in lib/shiphero.ts and like
 * /api/refresh — this route authenticates via a shared secret. Reuses
 * REFRESH_SECRET (same secret family already used for server-to-server calls
 * in this app) so no new env var is needed; configure it as a custom header
 * (x-refresh-secret) or query param when registering the webhook in ShipHero.
 *
 * This route is exempted from the session-cookie auth middleware (see
 * middleware.ts) for the same reason /api/refresh is: ShipHero calls it
 * directly and can't hold our login cookie.
 */
import { NextRequest, NextResponse } from "next/server";
import { writeShipLabel } from "@/lib/shipping-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.REFRESH_SECRET;
  if (!secret) return false;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const provided =
    req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-refresh-secret") ?? bearer ?? "";
  return provided !== "" && provided === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      order_number?: string;
      ship_date?: string;
      data?: { order_number?: string; ship_date?: string };
    };
    const orderNumber = body.order_number ?? body.data?.order_number;
    const shipDate = body.ship_date ?? body.data?.ship_date;

    if (orderNumber && shipDate) {
      await writeShipLabel(orderNumber, shipDate);
    }
  } catch (err) {
    console.error("[shiphero-shipment-webhook] Error:", err);
  }

  return new Response("OK", { status: 200 });
}

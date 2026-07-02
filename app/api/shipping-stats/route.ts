/**
 * GET /api/shipping-stats?location=cn|us&interval=day|week|month&range=7|30
 *
 * Thin wrapper around lib/shipping-stats.ts#getShippingStats — see that file
 * for the aggregation logic and caching. This route is what ShippingDashboard
 * refetches from on the client when a filter changes; the initial page load
 * calls getShippingStats directly (see app/shipping-performance/page.tsx).
 *
 * Auth: this route is exempted from the middleware's redirect-to-login
 * behavior (see middleware.ts) because vercel.json's nightly cache-warming
 * cron calls it with `Authorization: Bearer $CRON_SECRET`, which isn't the
 * session cookie the middleware normally checks for. So the check happens
 * here instead, accepting either a valid session cookie (normal dashboard
 * use) or the refresh/cron secret (the nightly warm-up cron) — the data
 * itself stays exactly as protected as before, just via a different route.
 */
import { NextRequest, NextResponse } from "next/server";
import { getShippingStats } from "@/lib/shipping-stats";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import type { ShippingLocationKey } from "@/lib/shipping-location";
import type { Interval } from "@/lib/shipping-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  if (isValidSessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return true;

  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const provided = req.nextUrl.searchParams.get("secret") ?? bearer ?? "";
  const accepted = [process.env.REFRESH_SECRET, process.env.CRON_SECRET].filter(
    Boolean,
  ) as string[];
  return provided !== "" && accepted.includes(provided);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const locParam = req.nextUrl.searchParams.get("location") ?? "cn";
  if (locParam !== "cn" && locParam !== "us") {
    return NextResponse.json({ error: "location must be cn or us" }, { status: 400 });
  }
  const loc = locParam as ShippingLocationKey;
  const interval = (req.nextUrl.searchParams.get("interval") ?? "day") as Interval;
  const range = req.nextUrl.searchParams.get("range") === "7" ? 7 : 30;
  const bust = req.nextUrl.searchParams.get("bust") === "1";

  const response = await getShippingStats(loc, interval, range, bust);
  return NextResponse.json(response);
}

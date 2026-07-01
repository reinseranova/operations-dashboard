/**
 * /api/refresh — pulls Shopify + ShipHero data, computes all metrics, and
 * writes the result to KV under a single key (dashboard:snapshot).
 *
 * Protected by a shared secret (REFRESH_SECRET) so it's safe to call from
 * outside Vercel. Pass it as `?secret=...`, an `x-refresh-secret` header, or
 * `Authorization: Bearer <secret>`. This is separate from the dashboard login
 * password. This route is exempted from the auth middleware (see middleware.ts)
 * precisely so external schedulers can hit it.
 *
 * SCHEDULING: vercel.json runs this once per day (the free-tier Vercel Cron
 * limit). Vercel automatically attaches `Authorization: Bearer $CRON_SECRET`
 * to its cron requests, so set CRON_SECRET (equal to REFRESH_SECRET is fine)
 * in the Vercel project and this route will accept the cron call.
 *
 * For MORE FREQUENT refreshes you need either a paid Vercel plan (which allows
 * more frequent built-in cron) OR a free external pinger such as cron-job.org
 * hitting `https://<your-app>/api/refresh?secret=<REFRESH_SECRET>` on whatever
 * schedule you like. The endpoint is idempotent, so calling it more often is safe.
 */
import { NextResponse, type NextRequest } from "next/server";
import { refreshSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
// Never cache the refresh endpoint itself; it does the heavy lifting on demand.
export const dynamic = "force-dynamic";
// Bulk parsing / pagination can take a little while on first run.
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  // Accept the secret from a query param, a custom header, or a bearer token.
  // The bearer form lets Vercel Cron authenticate via its auto-attached
  // `Authorization: Bearer $CRON_SECRET` header.
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const provided =
    req.nextUrl.searchParams.get("secret") ??
    req.headers.get("x-refresh-secret") ??
    bearer ??
    "";
  if (!provided) return false;

  const accepted = [process.env.REFRESH_SECRET, process.env.CRON_SECRET].filter(
    Boolean,
  ) as string[];
  return accepted.includes(provided);
}

async function handle(req: NextRequest) {
  if (!process.env.REFRESH_SECRET && !process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Server is missing REFRESH_SECRET." },
      { status: 500 },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const snapshot = await refreshSnapshot();
    return NextResponse.json({
      ok: true,
      generatedAt: snapshot.generatedAt,
      skuCount: snapshot.skus.length,
      shopifyStatus: snapshot.shopify.status,
      shipheroStatus: snapshot.shiphero.status,
      shipheroWarnings: snapshot.shiphero.warnings ?? [],
    });
  } catch (err) {
    console.error("[refresh] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refresh failed." },
      { status: 500 },
    );
  }
}

// Support both GET (easy for cron pingers) and POST (the dashboard button).
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

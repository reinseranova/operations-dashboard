/**
 * POST /api/shipping-bootstrap — seeds ~30 days of processing-time history
 * from Shopify fulfillment data, so the page isn't empty on day one while
 * transit/pickup time build up from live ParcelPanel webhooks over the
 * following weeks. Run once after deployment (safe to re-run — it only adds
 * data, keyed by day, and existing entries just grow).
 *
 * Protected the same way as /api/refresh: Authorization: Bearer REFRESH_SECRET.
 * Exempted from the session-cookie auth middleware for the same reason.
 */
import { NextRequest, NextResponse } from "next/server";
import { getShippingKv } from "@/lib/shipping-kv";
import { resolveLocation } from "@/lib/shipping-location";
import { shopifyGraphQL } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TTL_SECONDS = 35 * 24 * 60 * 60;

const BOOTSTRAP_QUERY = /* GraphQL */ `
  query GetFulfilledOrders($cursor: String, $q: String!) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          createdAt
          name
          fulfillments {
            createdAt
            location {
              name
            }
            trackingInfo {
              company
              number
            }
            events(first: 20) {
              edges {
                node {
                  status
                  happenedAt
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface FulfillmentEvent {
  status: string;
  happenedAt: string;
}

interface Fulfillment {
  createdAt: string;
  location: { name: string | null } | null;
  trackingInfo: Array<{ company: string | null; number: string | null }> | null;
  events: { edges: Array<{ node: FulfillmentEvent }> } | null;
}

interface BootstrapOrder {
  createdAt: string;
  name: string;
  fulfillments: Fulfillment[] | null;
}

interface BootstrapPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: BootstrapOrder }>;
  };
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.REFRESH_SECRET;
  if (!secret) return false;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return bearer === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const kv = getShippingKv();
  if (!kv) {
    return NextResponse.json(
      { error: "Vercel KV is not configured — nothing to seed into." },
      { status: 400 },
    );
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const fromDate = thirtyDaysAgo.toISOString().slice(0, 10);
  const msPerDay = 86_400_000;

  let cursor: string | null = null;
  let processed = 0;
  let chinaSeed = 0;
  let usaSeed = 0;

  try {
    do {
      const data: BootstrapPage = await shopifyGraphQL<BootstrapPage>(BOOTSTRAP_QUERY, {
        cursor,
        q: `created_at:>='${fromDate}' fulfillment_status:shipped`,
      });

      for (const { node: order } of data.orders.edges) {
        for (const fulfillment of order.fulfillments ?? []) {
          const loc = resolveLocation(
            fulfillment.location?.name,
            fulfillment.trackingInfo?.[0]?.company ?? "",
          );
          if (loc === "unknown") continue;

          const orderDate = new Date(order.createdAt).getTime();
          const fulfillmentDate = new Date(fulfillment.createdAt).getTime();
          const processingDays = (fulfillmentDate - orderDate) / msPerDay;

          const deliveredEvent = fulfillment.events?.edges.find(
            (e) => e.node.status === "DELIVERED",
          )?.node;
          const deliveryDate = deliveredEvent?.happenedAt
            ? new Date(deliveredEvent.happenedAt).getTime()
            : null;
          const totalDays = deliveryDate != null ? (deliveryDate - orderDate) / msPerDay : null;

          const day = fulfillment.createdAt.slice(0, 10);
          const pipeline = kv.pipeline();
          let wrote = false;

          if (processingDays >= 0) {
            pipeline.rpush(`ship:${loc}:processing:${day}`, processingDays);
            pipeline.expire(`ship:${loc}:processing:${day}`, TTL_SECONDS);
            wrote = true;
          }
          if (totalDays != null && totalDays >= 0 && deliveredEvent) {
            const deliveryDay = deliveredEvent.happenedAt.slice(0, 10);
            pipeline.rpush(`ship:${loc}:total:${deliveryDay}`, totalDays);
            pipeline.expire(`ship:${loc}:total:${deliveryDay}`, TTL_SECONDS);
            wrote = true;
          }
          if (fulfillment.trackingInfo?.[0]?.company) {
            pipeline.rpush(`ship:${loc}:carrier:${day}`, fulfillment.trackingInfo[0].company.toLowerCase());
            pipeline.expire(`ship:${loc}:carrier:${day}`, TTL_SECONDS);
            wrote = true;
          }

          if (wrote) {
            try {
              await pipeline.exec();
            } catch (err) {
              console.error("[shipping-bootstrap] KV write failed, continuing:", err);
            }
            processed++;
            if (loc === "cn") chinaSeed++;
            else usaSeed++;
          }
        }
      }

      cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    } while (cursor);
  } catch (err) {
    console.error("[shipping-bootstrap] failed:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Bootstrap failed.",
        processed,
        china: chinaSeed,
        usa: usaSeed,
      },
      { status: 500 },
    );
  }

  await kv.del("ship:cache:cn");
  await kv.del("ship:cache:us");

  return NextResponse.json({ processed, china: chinaSeed, usa: usaSeed });
}

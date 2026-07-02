import { NextRequest, NextResponse } from 'next/server';

const SHOP     = process.env.SHOPIFY_STORE_DOMAIN!;
const ID       = process.env.SHOPIFY_CLIENT_ID!;
const SECRET   = process.env.SHOPIFY_CLIENT_SECRET!;
const REDIRECT = 'https://operations-dashboard-theta.vercel.app/api/shopify-oauth';
const SCOPES   = 'read_orders,read_all_orders,read_fulfillments,read_products,read_inventory,read_locations';

export async function GET(req: NextRequest) {
  const code  = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (!code) {
    const url = `https://${SHOP}/admin/oauth/authorize?client_id=${ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=ops-dashboard`;
    return NextResponse.redirect(url);
  }

  const res  = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: ID, client_secret: SECRET, code }),
  });
  const data = await res.json() as { access_token?: string; scope?: string; error_description?: string };

  if (!data.access_token) {
    return NextResponse.json({ error: data.error_description ?? 'No token returned', raw: data }, { status: 400 });
  }

  return NextResponse.json({
    instructions: '1. Copy access_token below  2. Add it to Vercel as SHOPIFY_ADMIN_ACCESS_TOKEN  3. Redeploy  4. Ask Claude Code to delete this file',
    access_token: data.access_token,
    scopes_granted: data.scope,
  });
}

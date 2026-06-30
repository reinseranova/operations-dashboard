/**
 * Auth gate. Redirects to /login when the session cookie is missing or invalid,
 * for every route except /login and its API route (and Next internals/assets).
 *
 * Runs in the Edge runtime, so it validates the cookie's HMAC using Web Crypto
 * (crypto.subtle) rather than node:crypto. The derivation matches
 * lib/auth.ts#sessionTokenFor exactly: HMAC-SHA256(password, marker) as hex.
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "ops_session";
const SESSION_MARKER = "ops-dashboard-session-v1";

// Paths that never require auth.
const PUBLIC_PATHS = ["/login", "/api/login"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

async function expectedToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(SESSION_MARKER));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD;
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  let valid = false;
  if (password && token) {
    valid = token === (await expectedToken(password));
  }

  if (valid) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on everything except Next internals and static assets. /api/refresh is
  // intentionally covered: it's protected by its own REFRESH_SECRET, and we
  // exempt it below so external cron/pingers can reach it without the cookie.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/refresh).*)"],
};

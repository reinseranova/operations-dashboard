/**
 * Shared-password auth helpers.
 *
 * One password for the whole team (env var DASHBOARD_PASSWORD), no accounts and
 * no database. A correct login sets an HTTP-only session cookie; middleware
 * checks it on every route except /login and its API route.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE = "ops_session";

/**
 * The cookie value is an HMAC of a fixed marker keyed by the password, so it
 * can't be forged without knowing DASHBOARD_PASSWORD and isn't the password
 * itself. (Edge middleware can compare it without importing node:crypto.)
 */
function expectedToken(password: string): string {
  return createHmac("sha256", password).update("ops-dashboard-session-v1").digest("hex");
}

export function sessionTokenFor(password: string): string {
  return expectedToken(password);
}

export function isPasswordCorrect(input: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Validate a cookie value against the configured password. */
export function isValidSessionToken(token: string | undefined): boolean {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password || !token) return false;
  const expected = expectedToken(password);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

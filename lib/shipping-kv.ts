/**
 * KV client accessor for the Shipping Performance feature.
 *
 * lib/kv.ts only wraps scalar get/set/del (JSON values), but this feature
 * needs Redis list ops (RPUSH/LRANGE), INCR, and pipelines — so this module
 * creates its own @vercel/kv client using the same env vars and the same
 * "degrade to null when unconfigured" contract as lib/kv.ts, rather than
 * modifying that shared file.
 */
import { createClient, type VercelKV } from "@vercel/kv";
import { isKvConfigured } from "./kv";

let cachedClient: VercelKV | null | undefined;

export function getShippingKv(): VercelKV | null {
  if (cachedClient !== undefined) return cachedClient;
  if (!isKvConfigured()) {
    cachedClient = null;
    return cachedClient;
  }
  cachedClient = createClient({
    url: process.env.KV_REST_API_URL as string,
    token: process.env.KV_REST_API_TOKEN as string,
  });
  return cachedClient;
}

export { isKvConfigured };

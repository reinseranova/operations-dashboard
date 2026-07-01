/**
 * Thin wrapper around Vercel KV (Upstash Redis) that degrades gracefully when
 * KV is not configured.
 *
 * The build spec requires the app to work whether or not KV is set up:
 *   - If KV_REST_API_URL + KV_REST_API_TOKEN are present, we use the real store.
 *   - If they're absent, isKvConfigured() returns false and callers fall back
 *     to computing fresh data on each request (with Next fetch caching).
 *
 * Nothing here ever throws because KV is missing — callers branch on
 * isKvConfigured() and these helpers no-op / return null when it isn't.
 */
import { createClient, type VercelKV } from "@vercel/kv";

let cachedClient: VercelKV | null | undefined;

export function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN,
  );
}

function getClient(): VercelKV | null {
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

export async function kvGet<T>(key: string): Promise<T | null> {
  const client = getClient();
  if (!client) return null;
  try {
    // @vercel/kv returns the value already JSON-parsed.
    return (await client.get<T>(key)) ?? null;
  } catch (err) {
    console.error(`[kv] get failed for "${key}":`, err);
    return null;
  }
}

export async function kvSet<T>(
  key: string,
  value: T,
  opts?: { ttlSeconds?: number },
): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    if (opts?.ttlSeconds) {
      await client.set(key, value, { ex: opts.ttlSeconds });
    } else {
      await client.set(key, value);
    }
  } catch (err) {
    console.error(`[kv] set failed for "${key}":`, err);
  }
}

export async function kvDel(key: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.del(key);
  } catch (err) {
    console.error(`[kv] del failed for "${key}":`, err);
  }
}

/** Delete every key starting with `prefix`. No-op when KV isn't configured. */
export async function kvDeleteByPrefix(prefix: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } catch (err) {
    console.error(`[kv] deleteByPrefix failed for "${prefix}":`, err);
  }
}

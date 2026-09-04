/**
 * HMAC-SHA256 hex for Binance SIGNED endpoints (Web Crypto — no npm deps).
 * Query string for signing = params WITHOUT `signature`, insertion order
 * as built by the caller (Binance accepts URLSearchParams order).
 */

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build `key=value&...` then append `&signature=...` for Binance USER_DATA. */
export async function signBinanceParams(
  apiSecret: string,
  params: Record<string, string | number>,
): Promise<Record<string, string | number>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  const signature = await hmacSha256Hex(apiSecret, search.toString());
  return { ...params, signature };
}

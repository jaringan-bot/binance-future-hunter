// Cache API bawaan Cloudflare Workers runtime (`caches.default`) -- TIDAK
// butuh binding/provisioning apapun di wrangler.toml, beda dari Workers KV.
// Dipakai buat cache response upstream (Binance/Coinalyze) yang short-lived,
// supaya tool call berturut-turut ke pair yang sama dalam beberapa detik
// gak selalu roundtrip penuh ke proxy Vercel + Binance.
//
// SENGAJA gak dipakai untuk endpoint yang butuh freshness ketat (order book
// depth, aggregate trades) -- lihat NO_CACHE_PATHS di binanceProxyClient.ts.
// Cache-nya per edge location (colo), bukan global instan, dan cuma
// meng-cache response sukses (2xx) -- error tidak pernah di-cache.
export async function cachedFetch(
  url: string,
  init: RequestInit | undefined,
  ttlSeconds: number,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
  if (ttlSeconds <= 0 || typeof caches === "undefined" || !caches.default) {
    return doFetch(url, init);
  }

  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await doFetch(url, init);
  if (response.ok) {
    const cacheable = new Response(response.clone().body, response);
    cacheable.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    await cache.put(cacheKey, cacheable);
  }
  return response;
}

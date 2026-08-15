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

// withCache() menerima cache key TERPISAH dari mekanisme fetch yang
// sebenarnya (`produce`) -- dibutuhkan oleh binanceProxyClient.ts karena
// satu logical request (path+params+market) bisa dilayani oleh proxy tier
// manapun (primary/secondary/direct), tapi harus tetap 1 cache entry yang
// sama supaya failover ke tier lain tidak "membocorkan" cache terpisah per
// tier dan kehilangan hit rate.
export async function withCache(
  cacheKeyUrl: string,
  ttlSeconds: number,
  produce: () => Promise<Response>,
): Promise<Response> {
  if (ttlSeconds <= 0 || typeof caches === "undefined" || !caches.default) {
    return produce();
  }

  const cache = caches.default;
  const cacheKey = new Request(cacheKeyUrl, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await produce();
  if (response.ok) {
    const cacheable = new Response(response.clone().body, response);
    cacheable.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    await cache.put(cacheKey, cacheable);
  }
  return response;
}

// cachedFetch() -- wrapper tipis di atas withCache() untuk pemanggil yang
// cache key-nya sama persis dengan URL fetch (satu URL, satu sumber).
// Dipakai coinalyzeClient.ts.
export async function cachedFetch(
  url: string,
  init: RequestInit | undefined,
  ttlSeconds: number,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
  return withCache(url, ttlSeconds, () => doFetch(url, init));
}

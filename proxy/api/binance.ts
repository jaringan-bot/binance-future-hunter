// Vercel Serverless Function — proxy relay ke Binance Futures API.
//
// KENAPA INI ADA: Cloudflare Workers (worker `whale.jaringan.dev` di repo ini)
// diblokir total oleh WAF Binance (HTTP 403 di semua endpoint, termasuk
// /fapi/v1/ping paling dasar — sudah dites & dikonfirmasi, lihat commit
// history branch test/binance-direct-connectivity). Vercel pakai IP pool
// berbeda dari Cloudflare, jadi dicoba sebagai jalur alternatif.
//
// CARA PAKAI dari worker Cloudflare:
//   fetch(`https://<vercel-project>.vercel.app/api/binance?path=/fapi/v1/depth&symbol=BTCUSDT&limit=5`, {
//     headers: { "x-proxy-secret": PROXY_SECRET }
//   })
//
// KEAMANAN: endpoint ini publik (siapa saja bisa akses URL-nya), makanya
// wajib kirim header x-proxy-secret yang cocok dengan env var PROXY_SECRET
// di Vercel. Tanpa ini, siapapun bisa pakai proxy ini buat relay ke Binance
// atas nama kamu (potensi disalahgunakan / kena rate limit Binance karena
// orang lain).

import type { VercelRequest, VercelResponse } from "@vercel/node";

// Dua base URL: Futures (fapi, default) dan Spot (api) — dipilih lewat query
// param 'market' ('futures' default, atau 'spot'). Spot ditambahkan supaya
// worker bisa hitung basis futures-vs-spot riil (bukan cuma vs index price
// blended), berguna untuk pair likuid yang punya listing spot di Binance.
const BASE_BY_MARKET: Record<string, string> = {
  futures: "https://fapi.binance.com",
  spot: "https://api.binance.com",
};

// Whitelist path per market — JANGAN buka proxy generic tanpa whitelist,
// supaya proxy ini tidak bisa disalahgunakan untuk hit endpoint Binance
// sembarangan (termasuk endpoint yang butuh API key/trading, yang TIDAK
// boleh lewat proxy publik seperti ini).
//
// fundingRate/premiumIndex/klines/ticker-24hr ditambahkan supaya worker bisa
// pakai Binance sebagai source of truth untuk funding rate & harga OHLC,
// menggantikan Coinalyze yang ternyata punya masalah presisi/skala untuk
// pair kecil (lihat PR fix/native-binance-precision untuk detail).
//
// openInterest/openInterestHist/takerlongshortRatio ditambahkan supaya
// open interest dan taker buy/sell ratio juga bisa pindah dari Coinalyze
// ke Binance native (endpoint publik resmi, tidak perlu agregator pihak
// ketiga untuk data ini).
const ALLOWED_PATHS_BY_MARKET: Record<string, Set<string>> = {
  futures: new Set([
    "/fapi/v1/ping",
    "/fapi/v1/depth",
    "/fapi/v1/aggTrades",
    "/fapi/v1/fundingRate",
    "/fapi/v1/premiumIndex",
    "/fapi/v1/klines",
    "/fapi/v1/ticker/24hr",
    "/fapi/v1/openInterest",
    "/futures/data/topLongShortAccountRatio",
    "/futures/data/topLongShortPositionRatio",
    "/futures/data/globalLongShortAccountRatio",
    "/futures/data/openInterestHist",
    "/futures/data/takerlongshortRatio",
    // 9 endpoint publik (security NONE) tambahan dari gap-analysis vs
    // katalog resmi Market Data - Futures (USDS-M) REST API Binance.
    "/fapi/v1/symbolAdlRisk",
    "/fapi/v1/insuranceBalance",
    "/fapi/v1/markPriceKlines",
    "/fapi/v1/indexPriceKlines",
    "/fapi/v1/premiumIndexKlines",
    "/fapi/v1/indexInfo",
    "/fapi/v1/continuousKlines",
    "/futures/data/delivery-price",
    "/fapi/v1/constituents",
    // exchangeInfo (LOT_SIZE/MIN_NOTIONAL) -- trading rules utk validasi grid qty minimum
    "/fapi/v1/exchangeInfo",
  ]),
  spot: new Set([
    "/api/v3/ticker/price",
    "/api/v3/ticker/24hr",
    "/api/v3/ticker/bookTicker",
    "/api/v3/depth",
    "/api/v3/klines",
    "/api/v3/aggTrades",
    "/api/v3/avgPrice",
    "/api/v3/exchangeInfo",
  ]),
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS minimal — proxy ini dipanggil server-to-server dari worker Cloudflare,
  // bukan dari browser, jadi CORS longgar di sini tidak masalah.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-proxy-secret");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed, gunakan GET." });
    return;
  }

  const expectedSecret = process.env.PROXY_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: "PROXY_SECRET belum diset di environment variable Vercel." });
    return;
  }
  const providedSecret = req.headers["x-proxy-secret"];
  if (providedSecret !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized: header x-proxy-secret tidak cocok atau tidak ada." });
    return;
  }

  const marketParam = req.query.market;
  const market = typeof marketParam === "string" && marketParam ? marketParam : "futures";
  const binanceBase = BASE_BY_MARKET[market];
  const allowedPaths = ALLOWED_PATHS_BY_MARKET[market];
  if (!binanceBase || !allowedPaths) {
    res.status(400).json({
      error: "Parameter 'market' tidak dikenali, harus salah satu dari: futures, spot.",
    });
    return;
  }

  const path = req.query.path;
  if (typeof path !== "string" || !allowedPaths.has(path)) {
    res.status(400).json({
      error: "Parameter 'path' wajib diisi dan harus salah satu dari whitelist market ini.",
      market,
      allowedPaths: Array.from(allowedPaths),
    });
    return;
  }

  // Teruskan semua query param LAIN (selain 'path' dan 'market') apa adanya ke Binance.
  const forwardParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path" || key === "market") continue;
    if (typeof value === "string") forwardParams.set(key, value);
  }

  const targetUrl = `${binanceBase}${path}${forwardParams.toString() ? `?${forwardParams.toString()}` : ""}`;

  try {
    const binanceRes = await fetch(targetUrl, {
      headers: { Accept: "application/json" },
    });
    const contentType = binanceRes.headers.get("content-type") ?? "";
    const body = await binanceRes.text();

    res.status(binanceRes.status);
    if (contentType.includes("application/json")) {
      res.setHeader("Content-Type", "application/json");
    } else {
      // Binance kadang balas HTML block page (seperti yang kita lihat dari
      // Cloudflare) — tetap diteruskan apa adanya supaya worker bisa diagnosis.
      res.setHeader("Content-Type", "text/plain");
    }
    res.send(body);
  } catch (err) {
    res.status(502).json({
      error: `Gagal fetch ke Binance: ${(err as Error).message}`,
      targetUrl,
    });
  }
}

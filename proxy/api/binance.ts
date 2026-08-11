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

const BINANCE_BASE = "https://fapi.binance.com";

// Whitelist path yang boleh diteruskan — JANGAN buka proxy generic tanpa
// whitelist, supaya proxy ini tidak bisa disalahgunakan untuk hit endpoint
// Binance sembarangan (termasuk endpoint yang butuh API key/trading, yang
// TIDAK boleh lewat proxy publik seperti ini).
//
// fundingRate/premiumIndex/klines/ticker-24hr ditambahkan supaya worker bisa
// pakai Binance sebagai source of truth untuk funding rate & harga OHLC,
// menggantikan Coinalyze yang ternyata punya masalah presisi/skala untuk
// pair kecil (lihat PR fix/native-binance-precision untuk detail).
//
// openInterest/openInterestHist/takerlongshortratio ditambahkan supaya
// open interest dan taker buy/sell ratio juga bisa pindah dari Coinalyze
// ke Binance native (endpoint publik resmi, tidak perlu agregator pihak
// ketiga untuk data ini).
const ALLOWED_PATHS = new Set([
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
  "/futures/data/takerlongshortratio",
]);

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

  const path = req.query.path;
  if (typeof path !== "string" || !ALLOWED_PATHS.has(path)) {
    res.status(400).json({
      error: "Parameter 'path' wajib diisi dan harus salah satu dari whitelist.",
      allowedPaths: Array.from(ALLOWED_PATHS),
    });
    return;
  }

  // Teruskan semua query param LAIN (selain 'path') apa adanya ke Binance.
  const forwardParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    if (typeof value === "string") forwardParams.set(key, value);
  }

  const targetUrl = `${BINANCE_BASE}${path}${forwardParams.toString() ? `?${forwardParams.toString()}` : ""}`;

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

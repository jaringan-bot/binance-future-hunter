// Standalone Binance Futures/Spot proxy relay — platform-agnostic.
//
// Port of ../proxy/api/binance.ts (Vercel serverless) to a single
// Web-standard request handler that runs unchanged on Node (node:http),
// Deno Deploy (Deno.serve), Bun, Fly.io, Render, Koyeb, or a plain VPS.
//
// WHY THIS EXISTS: the Cloudflare Worker (whalescope-mcp) is WAF-blocked by
// Binance (HTTP 403 on every fapi.binance.com endpoint, /fapi/v1/ping
// included). It must call Binance through a relay hosted on an IP pool that
// is NOT WAF-blocked AND NOT geo-restricted (i.e. non-US region — Singapore
// / Tokyo are known-good, that is what the retired Vercel sin1 deploy used).
//
// AUTH: the caller MUST send header `x-proxy-secret` matching env
// PROXY_SECRET. Without it anyone hitting the public URL could relay through
// you and burn your Binance rate limit.
//
// SIGNED ENDPOINTS: optional caller header `x-binance-api-key` is forwarded
// to Binance as `X-MBX-APIKEY` (needed by /fapi/v1/leverageBracket). HMAC
// signing (secret) stays entirely caller-side — this relay only passes
// `signature` / `timestamp` / `recvWindow` through as ordinary query params
// and never touches the Binance secret.

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const BASE_BY_MARKET = {
  futures: "https://fapi.binance.com",
  spot: "https://api.binance.com",
};

/** Constant-time string compare (node:crypto works on Node, Deno, Bun). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb); // burn comparable time, don't early-return on length
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Drop caller-signed params before a URL touches any log. */
function redactUrl(u) {
  try {
    const parsed = new URL(u);
    for (const k of ["signature", "timestamp", "recvWindow", "apiKey"]) parsed.searchParams.delete(k);
    return parsed.toString();
  } catch {
    return "(unparseable url)";
  }
}

// Kept byte-for-byte in sync with ../proxy/api/binance.ts. If you add a path
// to the Vercel relay's whitelist, add it here too (and vice versa).
const ALLOWED_PATHS_BY_MARKET = {
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
    "/futures/data/basis",
    "/fapi/v1/symbolAdlRisk",
    "/fapi/v1/insuranceBalance",
    // expects a request that is ALREADY signed by the caller
    // (query carries signature/timestamp/recvWindow + header
    // x-binance-api-key)
    "/fapi/v1/leverageBracket",
    "/fapi/v1/markPriceKlines",
    "/fapi/v1/indexPriceKlines",
    "/fapi/v1/premiumIndexKlines",
    "/fapi/v1/indexInfo",
    "/fapi/v1/continuousKlines",
    "/futures/data/delivery-price",
    "/fapi/v1/constituents",
    "/fapi/v1/exchangeInfo",
    "/fapi/v1/trades",
    "/fapi/v1/ticker/bookTicker",
    "/fapi/v2/ticker/price",
    "/fapi/v1/fundingInfo",
    "/fapi/v1/rpiDepth",
    "/fapi/v1/tradingSchedule",
    "/fapi/v1/allForceOrders",
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-proxy-secret, x-binance-api-key",
};

/** Read an env var across Node / Deno / Bun without assuming a global. */
export function getEnv(name) {
  if (typeof process !== "undefined" && process.env && process.env[name] != null) {
    return process.env[name];
  }
  if (typeof Deno !== "undefined" && Deno.env) {
    try {
      return Deno.env.get(name) ?? undefined;
    } catch {
      return undefined; // --allow-env not granted
    }
  }
  return undefined;
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleBinanceProxy(request) {
  const method = request.method;
  const url = new URL(request.url);

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Health probe — no secret required (Render / Fly / Koyeb hit this).
  if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
    return json(200, { ok: true, service: "whale-binance-proxy-standalone" });
  }

  if (url.pathname !== "/api/binance") {
    return json(404, { error: "Not found. Endpoint is GET /api/binance?path=<binance-path>." });
  }

  if (method !== "GET") {
    return json(405, { error: "Method not allowed, gunakan GET." });
  }

  const expectedSecret = getEnv("PROXY_SECRET");
  if (!expectedSecret) {
    return json(500, { error: "PROXY_SECRET belum diset di environment variable host." });
  }
  const providedSecret = request.headers.get("x-proxy-secret");
  if (!safeEqual(providedSecret, expectedSecret)) {
    return json(401, { error: "Unauthorized: header x-proxy-secret tidak cocok atau tidak ada." });
  }

  const marketParam = url.searchParams.get("market");
  const market = marketParam || "futures";
  const binanceBase = BASE_BY_MARKET[market];
  const allowedPaths = ALLOWED_PATHS_BY_MARKET[market];
  if (!binanceBase || !allowedPaths) {
    return json(400, { error: "Parameter 'market' tidak dikenali, harus salah satu dari: futures, spot." });
  }

  const path = url.searchParams.get("path");
  if (typeof path !== "string" || !allowedPaths.has(path)) {
    return json(400, {
      error: "Parameter 'path' wajib diisi dan harus salah satu dari whitelist market ini.",
      market,
      allowedPaths: Array.from(allowedPaths),
    });
  }

  // Forward every query param except our own routing keys, preserving order
  // (matters for caller-signed endpoints).
  const forwardParams = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key === "path" || key === "market") continue;
    forwardParams.append(key, value);
  }
  const apiKeyHeader = request.headers.get("x-binance-api-key");

  const qs = forwardParams.toString();
  const targetUrl = `${binanceBase}${path}${qs ? `?${qs}` : ""}`;

  try {
    const outboundHeaders = { Accept: "application/json" };
    if (apiKeyHeader) outboundHeaders["X-MBX-APIKEY"] = apiKeyHeader;

    const binanceRes = await fetch(targetUrl, { headers: outboundHeaders });
    const contentType = binanceRes.headers.get("content-type") ?? "";
    const body = await binanceRes.text();

    return new Response(body, {
      status: binanceRes.status,
      headers: {
        "Content-Type": contentType.includes("application/json") ? "application/json" : "text/plain",
        ...CORS,
      },
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // Server-side only, signed params stripped. Never returned to the caller.
    console.error(`[relay] upstream fetch failed: ${msg} — ${redactUrl(targetUrl)}`);
    return json(502, { error: "upstream fetch failed", market, path });
  }
}

// HTTP read API for the stream gateway. Bound to 127.0.0.1 only — Caddy
// terminates TLS and forwards /stream/* here. Auth reuses the relay's
// PROXY_SECRET (x-proxy-secret header); the data served is already-public
// Binance data, the secret only gates casual abuse.

import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-proxy-secret",
};

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function num(v) {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pure router — no I/O. Returns { status, json }.
 * @param {string} method
 * @param {string} pathname
 * @param {Record<string,string>} query
 * @param {Record<string,string>} headers
 * @param {{store:object, health:object, secret:string|undefined}} deps
 */
export function route(method, pathname, query, headers, deps) {
  if (method === "OPTIONS") return { status: 204, json: null };
  if (method !== "GET") return { status: 405, json: { error: "method not allowed, use GET" } };

  const { store, health, secret } = deps;

  if (pathname === "/stream/health" || pathname === "/health" || pathname === "/") {
    const st = store.stats();
    return {
      status: 200,
      json: {
        ok: health.ok,
        connectedSince: health.connectedSince,
        lastMessageAgeMs: health.lastMessageAgeMs,
        reconnectCount: health.reconnectCount,
        malformedCount: health.malformedCount,
        lastError: health.lastError,
        liqRowCount: st.liqRowCount,
        contractRowCount: st.contractRowCount,
        oldestLiqTradeTime: st.oldestLiqTradeTime,
        newestLiqTradeTime: st.newestLiqTradeTime,
      },
    };
  }

  const protectedPaths = new Set(["/stream/liquidations", "/stream/contract-events"]);
  if (!protectedPaths.has(pathname)) return { status: 404, json: { error: "not found" } };

  if (!secret) return { status: 500, json: { error: "PROXY_SECRET not set on the gateway host" } };
  if (!safeEqual(headers["x-proxy-secret"], secret)) {
    return { status: 401, json: { error: "unauthorized: x-proxy-secret missing or wrong" } };
  }

  const streamHealth = {
    ok: health.ok,
    connectedSince: health.connectedSince,
    lastMessageAgeMs: health.lastMessageAgeMs,
    reconnectCount: health.reconnectCount,
    lastError: health.lastError,
  };

  if (pathname === "/stream/liquidations") {
    const events = store.queryLiquidations({
      symbol: query.symbol,
      sinceMs: num(query.sinceMs),
      minNotionalUsd: num(query.minNotionalUsd),
      limit: num(query.limit) ?? 100,
    });
    return {
      status: 200,
      json: {
        events,
        meta: {
          count: events.length,
          oldestTradeTime: events.length ? events[events.length - 1].trade_time : null,
          newestTradeTime: events.length ? events[0].trade_time : null,
          streamHealth,
        },
      },
    };
  }

  // /stream/contract-events
  const events = store.queryContractEvents({
    symbol: query.symbol,
    sinceMs: num(query.sinceMs),
    limit: num(query.limit) ?? 50,
  });
  return { status: 200, json: { events, meta: { count: events.length, streamHealth } } };
}

export function createServer(deps) {
  return http.createServer((req, res) => {
    let u;
    try {
      u = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: "bad url" }));
      return;
    }
    const query = Object.fromEntries(u.searchParams);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

    const { status, json } = route(req.method, u.pathname, query, headers, deps());
    res.writeHead(status, { "Content-Type": "application/json", ...CORS });
    res.end(json === null ? "" : JSON.stringify(json));
  });
}

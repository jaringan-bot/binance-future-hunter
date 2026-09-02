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
 * @param {{store:object, health:object, secret:string|undefined, depthWatch?:object}} deps
 * @param {object|null} [body]  parsed JSON body (POST only)
 */
export function route(method, pathname, query, headers, deps, body = null) {
  if (method === "OPTIONS") return { status: 204, json: null };

  const { store, health, secret, depthWatch } = deps;

  // POST /stream/watch is the ONLY non-GET route (arm/renew a depth watch).
  if (method === "POST") {
    if (pathname !== "/stream/watch") {
      return { status: 405, json: { error: "method not allowed, use GET" } };
    }
    if (!secret) return { status: 500, json: { error: "PROXY_SECRET not set on the gateway host" } };
    if (!safeEqual(headers["x-proxy-secret"], secret)) {
      return { status: 401, json: { error: "unauthorized: x-proxy-secret missing or wrong" } };
    }
    if (!depthWatch) return { status: 503, json: { error: "depth watch not available on this gateway" } };
    const b = body && typeof body === "object" ? body : {};
    const result = depthWatch.watch(b.symbol, b.ttlMs, b.wallMinNotionalUsd);
    return { status: result.ok ? 200 : (result.error && /batas/.test(result.error) ? 429 : 400), json: result };
  }

  if (method !== "GET") return { status: 405, json: { error: "method not allowed, use GET" } };

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
        depthWatch: depthWatch ? depthWatch.stats() : null,
      },
    };
  }

  const protectedPaths = new Set(["/stream/liquidations", "/stream/contract-events", "/stream/depth-diff"]);
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

  if (pathname === "/stream/depth-diff") {
    if (!depthWatch) return { status: 503, json: { error: "depth watch not available on this gateway" } };
    return { status: 200, json: depthWatch.queryDepthDiff(query.symbol, num(query.sinceMs)) };
  }

  // /stream/contract-events
  const events = store.queryContractEvents({
    symbol: query.symbol,
    sinceMs: num(query.sinceMs),
    limit: num(query.limit) ?? 50,
  });
  return { status: 200, json: { events, meta: { count: events.length, streamHealth } } };
}

const MAX_BODY_BYTES = 4096;

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

    const finish = (body) => {
      const { status, json } = route(req.method, u.pathname, query, headers, deps(), body);
      res.writeHead(status, { "Content-Type": "application/json", ...CORS });
      res.end(json === null ? "" : JSON.stringify(json));
    };

    if (req.method !== "POST") {
      finish(null);
      return;
    }
    const chunks = [];
    let bytes = 0;
    let aborted = false;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ error: "body too large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      let body = {};
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json", ...CORS });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
      finish(body);
    });
  });
}

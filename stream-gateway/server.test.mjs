import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "./server.mjs";

const SECRET = "s3cr3t";

function fakeStore() {
  return {
    queryLiquidations: (opts) => [
      { symbol: "BTCUSDT", side: "SELL", price: 80000, orig_qty: 0.5, notional_usd: 40000, trade_time: 3000, event_time: 3000 },
      { symbol: "BTCUSDT", side: "SELL", price: 79000, orig_qty: 0.1, notional_usd: 7900, trade_time: 1000, event_time: 1000 },
    ].filter((r) => !opts.symbol || r.symbol === opts.symbol),
    queryContractEvents: () => [
      { symbol: "NEWUSDT", contract_status: "TRADING", event_time: 5000, raw_json: '{"s":"NEWUSDT"}' },
    ],
    stats: () => ({ liqRowCount: 2, contractRowCount: 1, oldestLiqTradeTime: 1000, newestLiqTradeTime: 3000 }),
  };
}

const HEALTH = {
  ok: true, connectedSince: 1000, lastMessageAgeMs: 1200,
  reconnectCount: 0, malformedCount: 0, lastError: null,
};

function fakeDepthWatch(over = {}) {
  return {
    watch: (symbol, ttlMs) =>
      symbol === "FULLUSDT"
        ? { ok: false, error: "batas 2 watch bersamaan tercapai (VPS 1GB)", activeWatches: ["BTCUSDT", "ETHUSDT"] }
        : symbol
          ? { ok: true, watching: true, symbol: String(symbol).toUpperCase(), expiresAt: 9000, renewed: false }
          : { ok: false, error: "symbol tidak valid (harus [A-Z0-9]{5,20})" },
    queryDepthDiff: (symbol, sinceMs) =>
      symbol === "BTCUSDT"
        ? { watching: true, symbol: "BTCUSDT", expiresAt: 9000, events: [{ seq: 1, ts: 100, side: "bid", price: 100, type: "WALL_APPEARED", qty: 3000, notionalUsd: 300000 }], meta: { count: 1, wsOk: true } }
        : { watching: false, symbol: String(symbol ?? "").toUpperCase(), events: [], meta: { count: 0 } },
    stats: () => ({ count: 1, maxWatches: 8, activeWatches: [{ symbol: "BTCUSDT", expiresAt: 9000, events: 1, wsOk: true }] }),
    ...over,
  };
}

function deps(over = {}) {
  return { store: fakeStore(), health: HEALTH, secret: SECRET, depthWatch: fakeDepthWatch(), ...over };
}

test("GET /stream/health needs no secret and includes store counts", () => {
  const r = route("GET", "/stream/health", {}, {}, deps());
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.liqRowCount, 2);
  assert.equal(r.json.contractRowCount, 1);
});

test("GET /stream/liquidations without the secret is 401", () => {
  const r = route("GET", "/stream/liquidations", {}, {}, deps());
  assert.equal(r.status, 401);
});

test("GET /stream/liquidations with the secret returns events + meta.streamHealth", () => {
  const r = route("GET", "/stream/liquidations", { symbol: "BTCUSDT" }, { "x-proxy-secret": SECRET }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.json.events.length, 2);
  assert.equal(r.json.meta.count, 2);
  assert.equal(r.json.meta.newestTradeTime, 3000);
  assert.equal(r.json.meta.streamHealth.connectedSince, 1000);
});

test("a wrong secret is 401 (constant-time compare, but still rejects)", () => {
  const r = route("GET", "/stream/liquidations", {}, { "x-proxy-secret": "nope" }, deps());
  assert.equal(r.status, 401);
});

test("GET /stream/contract-events with the secret returns events", () => {
  const r = route("GET", "/stream/contract-events", {}, { "x-proxy-secret": SECRET }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.json.events[0].symbol, "NEWUSDT");
  assert.equal(r.json.meta.streamHealth.ok, true);
});

test("non-GET is 405", () => {
  const r = route("POST", "/stream/health", {}, {}, deps());
  assert.equal(r.status, 405);
});

test("unknown path is 404", () => {
  const r = route("GET", "/stream/nope", {}, { "x-proxy-secret": SECRET }, deps());
  assert.equal(r.status, 404);
});

test("returns 500 if the gateway secret is not configured", () => {
  const r = route("GET", "/stream/liquidations", {}, { "x-proxy-secret": "anything" }, deps({ secret: undefined }));
  assert.equal(r.status, 500);
});

// ---- depth watch (Task B) --------------------------------------------

test("POST /stream/watch without the secret is 401", () => {
  const r = route("POST", "/stream/watch", {}, {}, deps(), { symbol: "BTCUSDT" });
  assert.equal(r.status, 401);
});

test("POST /stream/watch arms a watch and returns its expiry", () => {
  const r = route("POST", "/stream/watch", {}, { "x-proxy-secret": SECRET }, deps(), { symbol: "btcusdt", ttlMs: 60000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.symbol, "BTCUSDT");
  assert.equal(r.json.expiresAt, 9000);
});

test("POST /stream/watch: an invalid symbol is 400", () => {
  const r = route("POST", "/stream/watch", {}, { "x-proxy-secret": SECRET }, deps(), {});
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("POST /stream/watch: max-watches error maps to 429", () => {
  const r = route("POST", "/stream/watch", {}, { "x-proxy-secret": SECRET }, deps(), { symbol: "FULLUSDT" });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /batas/);
});

test("POST /stream/watch: 503 when the gateway has no depth watch", () => {
  const r = route("POST", "/stream/watch", {}, { "x-proxy-secret": SECRET }, deps({ depthWatch: undefined }), { symbol: "BTCUSDT" });
  assert.equal(r.status, 503);
});

test("GET /stream/depth-diff without the secret is 401", () => {
  const r = route("GET", "/stream/depth-diff", { symbol: "BTCUSDT" }, {}, deps());
  assert.equal(r.status, 401);
});

test("GET /stream/depth-diff returns wall-lifecycle events for an active watch", () => {
  const r = route("GET", "/stream/depth-diff", { symbol: "BTCUSDT" }, { "x-proxy-secret": SECRET }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.json.watching, true);
  assert.equal(r.json.events[0].type, "WALL_APPEARED");
});

test("GET /stream/depth-diff reports watching:false for a symbol with no watch", () => {
  const r = route("GET", "/stream/depth-diff", { symbol: "ETHUSDT" }, { "x-proxy-secret": SECRET }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.json.watching, false);
});

test("GET /stream/health includes the depthWatch summary", () => {
  const r = route("GET", "/stream/health", {}, {}, deps());
  assert.equal(r.json.depthWatch.count, 1);
});

test("non-GET, non-watch POST is still 405", () => {
  const r = route("POST", "/stream/liquidations", {}, { "x-proxy-secret": SECRET }, deps(), {});
  assert.equal(r.status, 405);
});

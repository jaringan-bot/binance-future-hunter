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

function deps(over = {}) {
  return { store: fakeStore(), health: HEALTH, secret: SECRET, ...over };
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

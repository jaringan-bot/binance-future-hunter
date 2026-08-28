import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelope } from "./parse.mjs";

const FORCE_ORDER = JSON.stringify({
  stream: "!forceOrder@arr",
  data: {
    e: "forceOrder",
    E: 1568014460893,
    o: {
      s: "BTCUSDT", S: "SELL", o: "LIMIT", f: "IOC",
      q: "0.014", p: "9910", ap: "9905.5", X: "FILLED",
      l: "0.014", z: "0.014", T: 1568014460800,
    },
  },
});

const CONTRACT_INFO = JSON.stringify({
  stream: "!contractInfo",
  data: {
    e: "contractInfo", E: 1669263838518,
    s: "IOTAUSDT", ps: "IOTAUSDT", ct: "PERPETUAL",
    dt: 4133404800000, ot: 1569398400000, cs: "TRADING",
    bks: [{ bs: 1, bnf: 0, bnc: 5000, mmr: 0.01, cf: 0, mi: 21, ma: 50 }],
  },
});

test("parses a forceOrder envelope into a normalized liquidation record", () => {
  const r = parseEnvelope(FORCE_ORDER);
  assert.equal(r.kind, "liquidation");
  assert.deepEqual(r.record, {
    symbol: "BTCUSDT",
    side: "SELL",
    price: 9910,
    orig_qty: 0.014,
    avg_price: 9905.5,
    notional_usd: 9910 * 0.014,
    order_status: "FILLED",
    event_time: 1568014460893,
    trade_time: 1568014460800,
  });
});

test("parses a contractInfo envelope into a normalized contract record", () => {
  const r = parseEnvelope(CONTRACT_INFO);
  assert.equal(r.kind, "contract");
  assert.equal(r.record.symbol, "IOTAUSDT");
  assert.equal(r.record.pair, "IOTAUSDT");
  assert.equal(r.record.contract_type, "PERPETUAL");
  assert.equal(r.record.contract_status, "TRADING");
  assert.equal(r.record.delivery_date, 4133404800000);
  assert.equal(r.record.onboard_date, 1569398400000);
  assert.equal(r.record.event_time, 1669263838518);
  assert.equal(JSON.parse(r.record.raw_json).s, "IOTAUSDT");
});

test("accepts a bare (non-combined-stream) data payload too", () => {
  const bare = JSON.stringify(JSON.parse(FORCE_ORDER).data);
  assert.equal(parseEnvelope(bare).kind, "liquidation");
});

test("returns kind null for unknown event types", () => {
  assert.equal(parseEnvelope(JSON.stringify({ stream: "x", data: { e: "depthUpdate" } })).kind, null);
});

test("returns kind null (never throws) on malformed JSON", () => {
  assert.equal(parseEnvelope("{not json").kind, null);
  assert.equal(parseEnvelope("").kind, null);
  assert.equal(parseEnvelope(undefined).kind, null);
});

test("returns kind null when a forceOrder is missing required numeric fields", () => {
  const broken = JSON.stringify({ data: { e: "forceOrder", o: { s: "BTCUSDT", S: "SELL" } } });
  assert.equal(parseEnvelope(broken).kind, null);
});

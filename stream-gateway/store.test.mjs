import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";

function mkLiq(over = {}) {
  return {
    symbol: "BTCUSDT", side: "SELL", price: 80000, orig_qty: 0.5,
    avg_price: 79990, notional_usd: 40000, order_status: "FILLED",
    event_time: 1_700_000_000_000, trade_time: 1_700_000_000_000, ...over,
  };
}
function mkContract(over = {}) {
  return {
    symbol: "NEWUSDT", pair: "NEWUSDT", contract_type: "PERPETUAL",
    contract_status: "PENDING_TRADING", delivery_date: 0, onboard_date: 1_700_000_100_000,
    event_time: 1_700_000_050_000, raw_json: '{"s":"NEWUSDT"}', ...over,
  };
}

test("inserts and reads back a liquidation", () => {
  const s = createStore(":memory:");
  assert.equal(s.insertLiquidation(mkLiq()), true);
  const rows = s.queryLiquidations({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "BTCUSDT");
  assert.equal(rows[0].notional_usd, 40000);
  s.close();
});

test("dedupes on (symbol, price, orig_qty, trade_time)", () => {
  const s = createStore(":memory:");
  assert.equal(s.insertLiquidation(mkLiq()), true);
  assert.equal(s.insertLiquidation(mkLiq()), false); // identical -> ignored
  assert.equal(s.insertLiquidation(mkLiq({ trade_time: 1_700_000_000_001 })), true);
  assert.equal(s.stats().liqRowCount, 2);
  s.close();
});

test("queryLiquidations filters by symbol, sinceMs, minNotionalUsd and returns newest first", () => {
  const s = createStore(":memory:");
  s.insertLiquidation(mkLiq({ symbol: "BTCUSDT", trade_time: 1000, notional_usd: 100 }));
  s.insertLiquidation(mkLiq({ symbol: "BTCUSDT", trade_time: 3000, notional_usd: 5000 }));
  s.insertLiquidation(mkLiq({ symbol: "ETHUSDT", trade_time: 2000, notional_usd: 9000 }));

  const btc = s.queryLiquidations({ symbol: "BTCUSDT", limit: 10 });
  assert.deepEqual(btc.map((r) => r.trade_time), [3000, 1000]);

  const since = s.queryLiquidations({ sinceMs: 2500, limit: 10 });
  assert.deepEqual(since.map((r) => r.trade_time), [3000]);

  const big = s.queryLiquidations({ minNotionalUsd: 6000, limit: 10 });
  assert.deepEqual(big.map((r) => r.symbol), ["ETHUSDT"]);

  assert.equal(s.queryLiquidations({ limit: 2 }).length, 2);
  s.close();
});

test("inserts, dedupes and queries contract events", () => {
  const s = createStore(":memory:");
  assert.equal(s.insertContractEvent(mkContract()), true);
  assert.equal(s.insertContractEvent(mkContract()), false);
  assert.equal(s.insertContractEvent(mkContract({ contract_status: "TRADING", event_time: 1_700_000_060_000 })), true);
  const rows = s.queryContractEvents({ symbol: "NEWUSDT", limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contract_status, "TRADING"); // newest first
  s.close();
});

test("prune drops liquidations past the age cutoff and past the row cap", () => {
  const s = createStore(":memory:");
  const now = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) s.insertLiquidation(mkLiq({ trade_time: now - i * 1000 }));
  s.insertLiquidation(mkLiq({ trade_time: now - 48 * 3600 * 1000 })); // old

  const removed = s.prune({ now, liqMaxAgeMs: 24 * 3600 * 1000, liqMaxRows: 5, contractMaxAgeMs: 30 * 86400_000 });
  assert.ok(removed.liquidations >= 6); // 1 aged out + 5 over the cap
  assert.ok(s.stats().liqRowCount <= 5);
  s.close();
});

test("stats reports row counts and the liquidation time span", () => {
  const s = createStore(":memory:");
  s.insertLiquidation(mkLiq({ trade_time: 1000 }));
  s.insertLiquidation(mkLiq({ trade_time: 5000 }));
  const st = s.stats();
  assert.equal(st.liqRowCount, 2);
  assert.equal(st.oldestLiqTradeTime, 1000);
  assert.equal(st.newestLiqTradeTime, 5000);
  s.close();
});

// SQLite persistence for the stream gateway. node:sqlite (Node 22, zero
// dependency; needs --experimental-sqlite). Survives systemd restarts and
// Binance's 24h forced WS reconnect.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS liquidations (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  orig_qty REAL NOT NULL,
  avg_price REAL,
  notional_usd REAL NOT NULL,
  order_status TEXT,
  event_time INTEGER NOT NULL,
  trade_time INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  UNIQUE(symbol, price, orig_qty, trade_time)
);
CREATE INDEX IF NOT EXISTS idx_liq_symbol_time ON liquidations(symbol, trade_time DESC);
CREATE INDEX IF NOT EXISTS idx_liq_time ON liquidations(trade_time DESC);
CREATE INDEX IF NOT EXISTS idx_liq_notional ON liquidations(notional_usd);

CREATE TABLE IF NOT EXISTS contract_events (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  pair TEXT,
  contract_type TEXT,
  contract_status TEXT,
  delivery_date INTEGER,
  onboard_date INTEGER,
  event_time INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  UNIQUE(symbol, contract_status, event_time)
);
CREATE INDEX IF NOT EXISTS idx_ce_time ON contract_events(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_ce_symbol_time ON contract_events(symbol, event_time DESC);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  const insLiq = db.prepare(`
    INSERT OR IGNORE INTO liquidations
      (symbol, side, price, orig_qty, avg_price, notional_usd, order_status, event_time, trade_time, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const insCe = db.prepare(`
    INSERT OR IGNORE INTO contract_events
      (symbol, pair, contract_type, contract_status, delivery_date, onboard_date, event_time, raw_json, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function insertLiquidation(r) {
    const res = insLiq.run(
      r.symbol, r.side, r.price, r.orig_qty, r.avg_price ?? null,
      r.notional_usd, r.order_status ?? null, r.event_time, r.trade_time, Date.now(),
    );
    return res.changes > 0;
  }

  function insertContractEvent(r) {
    const res = insCe.run(
      r.symbol, r.pair ?? null, r.contract_type ?? null, r.contract_status ?? null,
      r.delivery_date ?? null, r.onboard_date ?? null, r.event_time, r.raw_json, Date.now(),
    );
    return res.changes > 0;
  }

  function queryLiquidations({ symbol, sinceMs, minNotionalUsd, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (symbol) { where.push("symbol = ?"); args.push(String(symbol).toUpperCase()); }
    if (Number.isFinite(sinceMs)) { where.push("trade_time >= ?"); args.push(sinceMs); }
    if (Number.isFinite(minNotionalUsd)) { where.push("notional_usd >= ?"); args.push(minNotionalUsd); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return db.prepare(`SELECT * FROM liquidations ${clause} ORDER BY trade_time DESC LIMIT ?`).all(...args, lim);
  }

  function queryContractEvents({ symbol, sinceMs, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (symbol) { where.push("symbol = ?"); args.push(String(symbol).toUpperCase()); }
    if (Number.isFinite(sinceMs)) { where.push("event_time >= ?"); args.push(sinceMs); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return db.prepare(`SELECT * FROM contract_events ${clause} ORDER BY event_time DESC LIMIT ?`).all(...args, lim);
  }

  function prune({ now = Date.now(), liqMaxAgeMs, liqMaxRows, contractMaxAgeMs } = {}) {
    let liq = 0;
    let ce = 0;
    if (Number.isFinite(liqMaxAgeMs)) {
      liq += db.prepare("DELETE FROM liquidations WHERE trade_time < ?").run(now - liqMaxAgeMs).changes;
    }
    if (Number.isFinite(liqMaxRows)) {
      liq += db.prepare(
        `DELETE FROM liquidations WHERE id NOT IN (
           SELECT id FROM liquidations ORDER BY trade_time DESC LIMIT ?
         )`,
      ).run(liqMaxRows).changes;
    }
    if (Number.isFinite(contractMaxAgeMs)) {
      ce += db.prepare("DELETE FROM contract_events WHERE event_time < ?").run(now - contractMaxAgeMs).changes;
    }
    return { liquidations: liq, contractEvents: ce };
  }

  function stats() {
    const l = db.prepare(
      "SELECT COUNT(*) c, MIN(trade_time) mn, MAX(trade_time) mx FROM liquidations",
    ).get();
    const c = db.prepare("SELECT COUNT(*) c FROM contract_events").get();
    return {
      liqRowCount: l.c,
      contractRowCount: c.c,
      oldestLiqTradeTime: l.mn ?? null,
      newestLiqTradeTime: l.mx ?? null,
    };
  }

  return {
    insertLiquidation,
    insertContractEvent,
    queryLiquidations,
    queryContractEvents,
    prune,
    stats,
    close: () => db.close(),
  };
}

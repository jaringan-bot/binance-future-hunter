// Test entry_alert_run_log read/write path in d1Client.ts. Same hand-rolled
// fake D1Database approach as d1Client.entryAlertState.test.ts (no
// miniflare/wrangler D1 harness wired into vitest) -- dispatches by matching
// the start of the SQL string.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setD1Database,
  insertEntryAlertRunLog,
  getEntryAlertRunLogSummarySince,
  pruneOldEntryAlertRunLog,
  countEntryAlertsSince,
} from "./d1Client.js";

interface FakeRunLogRow {
  run_at: number;
  total: number;
  errors: number;
  watch_count: number;
  trade_count: number;
  dca_watch_count: number;
  dca_trade_count: number;
  trad_watch_count: number;
  trad_trade_count: number;
}

interface FakeAlertStateRow {
  symbol: string;
  last_decision: string;
  last_alert_at: number | null;
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    const bound = new FakeStatement(this.db, this.sql);
    bound.args = args;
    return bound;
  }

  async run(): Promise<{ success: true }> {
    if (this.sql.startsWith("INSERT INTO entry_alert_run_log")) {
      const [run_at, total, errors, watch_count, trade_count, dca_watch_count, dca_trade_count, trad_watch_count, trad_trade_count] =
        this.args as [number, number, number, number, number, number, number, number, number];
      this.db.runLogRows.push({
        run_at,
        total,
        errors,
        watch_count,
        trade_count,
        dca_watch_count,
        dca_trade_count,
        trad_watch_count,
        trad_trade_count,
      });
      return { success: true };
    }
    if (this.sql.startsWith("DELETE FROM entry_alert_run_log")) {
      const [cutoff] = this.args as [number];
      this.db.runLogRows = this.db.runLogRows.filter((r) => r.run_at >= cutoff);
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT COALESCE(SUM(total)")) {
      const [cutoff] = this.args as [number];
      const rows = this.db.runLogRows.filter((r) => r.run_at >= cutoff);
      const total = rows.reduce((sum, r) => sum + r.total, 0);
      const errors = rows.reduce((sum, r) => sum + r.errors, 0);
      return { total, errors } as T;
    }
    if (this.sql.startsWith("SELECT COUNT(*) as count FROM entry_alert_state")) {
      const [cutoff] = this.args as [number];
      const count = this.db.alertStateRows.filter((r) => r.last_alert_at !== null && r.last_alert_at >= cutoff).length;
      return { count } as T;
    }
    throw new Error(`FakeStatement.first: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  runLogRows: FakeRunLogRow[] = [];
  alertStateRows: FakeAlertStateRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

describe("entry_alert_run_log D1 read/write path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
  });

  it("insertEntryAlertRunLog inserts a row (grid + dca + trad tallies)", async () => {
    await insertEntryAlertRunLog({
      runAt: 1000, total: 400, errors: 355, watchCount: 20, tradeCount: 0, dcaWatchCount: 7, dcaTradeCount: 2, tradWatchCount: 3, tradTradeCount: 1,
    });

    expect(fake.runLogRows).toEqual([
      { run_at: 1000, total: 400, errors: 355, watch_count: 20, trade_count: 0, dca_watch_count: 7, dca_trade_count: 2, trad_watch_count: 3, trad_trade_count: 1 },
    ]);
  });

  it("insertEntryAlertRunLog defaults the dca + trad tallies to 0 when omitted", async () => {
    await insertEntryAlertRunLog({ runAt: 2000, total: 40, errors: 1, watchCount: 5, tradeCount: 1 });

    expect(fake.runLogRows[0]).toMatchObject({ dca_watch_count: 0, dca_trade_count: 0, trad_watch_count: 0, trad_trade_count: 0 });
  });

  it("getEntryAlertRunLogSummarySince sums total/errors across runs at or after the cutoff, excluding older ones", async () => {
    await insertEntryAlertRunLog({ runAt: 1000, total: 400, errors: 355, watchCount: 20, tradeCount: 0 });
    await insertEntryAlertRunLog({ runAt: 2000, total: 400, errors: 40, watchCount: 30, tradeCount: 2 });
    await insertEntryAlertRunLog({ runAt: 500, total: 400, errors: 400, watchCount: 0, tradeCount: 0 }); // before cutoff

    const summary = await getEntryAlertRunLogSummarySince(1000);

    expect(summary).toEqual({ total: 800, errors: 395 });
  });

  it("getEntryAlertRunLogSummarySince returns zeros when no runs are in the window", async () => {
    const summary = await getEntryAlertRunLogSummarySince(1000);

    expect(summary).toEqual({ total: 0, errors: 0 });
  });

  it("pruneOldEntryAlertRunLog deletes rows older than the cutoff", async () => {
    await insertEntryAlertRunLog({ runAt: 500, total: 1, errors: 0, watchCount: 0, tradeCount: 0 });
    await insertEntryAlertRunLog({ runAt: 1500, total: 1, errors: 0, watchCount: 0, tradeCount: 0 });

    await pruneOldEntryAlertRunLog(1000);

    expect(fake.runLogRows.map((r) => r.run_at)).toEqual([1500]);
  });

  it("countEntryAlertsSince counts entry_alert_state rows with last_alert_at at or after the cutoff", async () => {
    fake.alertStateRows.push(
      { symbol: "BTCUSDT", last_decision: "TRADE", last_alert_at: 2000 },
      { symbol: "ETHUSDT", last_decision: "WATCH", last_alert_at: 500 },
      { symbol: "SOLUSDT", last_decision: "NO_TRADE", last_alert_at: null },
    );

    const count = await countEntryAlertsSince(1000);

    expect(count).toBe(1);
  });
});

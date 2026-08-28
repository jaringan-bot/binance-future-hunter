// Test entry_alert_skip_log read/write path in d1Client.ts -- hand-rolled
// fake D1 (same approach as d1Client.entryAlertRunLog.test.ts), dispatch by
// SQL prefix.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setD1Database,
  insertEntryAlertSkipLog,
  pruneOldEntryAlertSkipLog,
} from "./d1Client.js";

interface FakeSkipRow {
  run_at: number;
  skipped_symbols: string;
  skipped_count: number;
  top_n: number;
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
    if (this.sql.startsWith("INSERT INTO entry_alert_skip_log")) {
      const [run_at, skipped_symbols, skipped_count, top_n] = this.args as [number, string, number, number];
      this.db.rows.push({ run_at, skipped_symbols, skipped_count, top_n });
      return { success: true };
    }
    if (this.sql.startsWith("DELETE FROM entry_alert_skip_log")) {
      const [cutoff] = this.args as [number];
      this.db.rows = this.db.rows.filter((r) => r.run_at >= cutoff);
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  rows: FakeSkipRow[] = [];
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

describe("entry_alert_skip_log D1 read/write path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });
  afterEach(() => setD1Database(undefined));

  it("insertEntryAlertSkipLog stores the skipped symbol list as a JSON array plus count and N", async () => {
    await insertEntryAlertSkipLog({ runAt: 1000, skippedSymbols: ["AUSDT", "BUSDT", "CUSDT"], topN: 40 });

    expect(fake.rows).toEqual([
      { run_at: 1000, skipped_symbols: JSON.stringify(["AUSDT", "BUSDT", "CUSDT"]), skipped_count: 3, top_n: 40 },
    ]);
  });

  it("insertEntryAlertSkipLog handles an empty skip list (N >= watchlist)", async () => {
    await insertEntryAlertSkipLog({ runAt: 2000, skippedSymbols: [], topN: 500 });

    expect(fake.rows[0]).toEqual({ run_at: 2000, skipped_symbols: "[]", skipped_count: 0, top_n: 500 });
  });

  it("pruneOldEntryAlertSkipLog deletes rows older than the cutoff", async () => {
    await insertEntryAlertSkipLog({ runAt: 500, skippedSymbols: ["X"], topN: 40 });
    await insertEntryAlertSkipLog({ runAt: 1500, skippedSymbols: ["Y"], topN: 40 });

    await pruneOldEntryAlertSkipLog(1000);

    expect(fake.rows.map((r) => r.run_at)).toEqual([1500]);
  });
});

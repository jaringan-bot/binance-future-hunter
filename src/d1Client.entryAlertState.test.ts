// Test entry_alert_state read/write path in d1Client.ts. Same hand-rolled
// fake D1Database approach as d1Client.wallTracking.test.ts (no miniflare/
// wrangler D1 harness wired into vitest) -- dispatches by matching the start
// of the SQL string.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setD1Database, getEntryAlertState, upsertEntryAlertState } from "./d1Client.js";

interface FakeRow {
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
    if (this.sql.startsWith("INSERT INTO entry_alert_state")) {
      const [symbol, last_decision, last_alert_at] = this.args as [string, string, number | null];
      const existing = this.db.rows.find((r) => r.symbol === symbol);
      if (existing) {
        existing.last_decision = last_decision;
        existing.last_alert_at = last_alert_at;
      } else {
        this.db.rows.push({ symbol, last_decision, last_alert_at });
      }
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT symbol, last_decision, last_alert_at FROM entry_alert_state")) {
      const [symbol] = this.args as [string];
      const row = this.db.rows.find((r) => r.symbol === symbol);
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeStatement.first: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  rows: FakeRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

describe("entry_alert_state D1 read/write path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
  });

  it("getEntryAlertState returns null when the symbol has no stored state yet", async () => {
    const result = await getEntryAlertState("BTCUSDT");
    expect(result).toBeNull();
  });

  it("upsertEntryAlertState inserts a new row, then getEntryAlertState reads it back", async () => {
    await upsertEntryAlertState({ symbol: "BTCUSDT", lastDecision: "TRADE", lastAlertAt: 1000 });

    const result = await getEntryAlertState("BTCUSDT");
    expect(result).toEqual({ symbol: "BTCUSDT", lastDecision: "TRADE", lastAlertAt: 1000 });
  });

  it("upsertEntryAlertState overwrites the existing row for the same symbol instead of duplicating it", async () => {
    await upsertEntryAlertState({ symbol: "BTCUSDT", lastDecision: "TRADE", lastAlertAt: 1000 });
    await upsertEntryAlertState({ symbol: "BTCUSDT", lastDecision: "NO_TRADE", lastAlertAt: null });

    expect(fake.rows).toHaveLength(1);
    const result = await getEntryAlertState("BTCUSDT");
    expect(result).toEqual({ symbol: "BTCUSDT", lastDecision: "NO_TRADE", lastAlertAt: null });
  });
});

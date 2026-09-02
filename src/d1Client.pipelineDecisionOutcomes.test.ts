// Test forward_return_*/sl_touched_24h read/write path (migration 0013) in
// d1Client.ts -- same hand-rolled fake D1Database pattern as
// d1Client.wallTracking.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setD1Database,
  queryPendingPipelineDecisionOutcomes,
  updatePipelineDecisionOutcome,
} from "./d1Client.js";

interface FakeRow {
  id: number;
  run_at: number;
  symbol: string;
  stop_loss: number | null;
  forward_return_24h: number | null;
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
    if (this.sql.startsWith("UPDATE pipeline_decision_log SET forward_return_1h")) {
      const [forwardReturn1h, forwardReturn4h, forwardReturn24h, slTouched24h, id] = this.args as [
        number | null,
        number | null,
        number | null,
        number | null,
        number,
      ];
      const row = this.db.rows.find((r) => r.id === id);
      if (row) {
        Object.assign(row, {
          forward_return_1h: forwardReturn1h,
          forward_return_4h: forwardReturn4h,
          forward_return_24h: forwardReturn24h,
          sl_touched_24h: slTouched24h,
        });
      }
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM pipeline_decision_log") && this.sql.includes("forward_return_24h IS NULL")) {
      const [readyBefore, notOlderThan, limit] = this.args as [number, number, number];
      const results = this.db.rows
        .filter((r) => r.forward_return_24h === null && r.run_at < readyBefore && r.run_at > notOlderThan)
        .sort((a, b) => a.run_at - b.run_at)
        .slice(0, limit)
        .map((r) => ({ id: r.id, run_at: r.run_at, symbol: r.symbol, stop_loss: r.stop_loss }));
      return { results: results as T[] };
    }
    throw new Error(`FakeStatement.all: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  rows: (FakeRow & { forward_return_1h?: number | null; forward_return_4h?: number | null; sl_touched_24h?: number | null })[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

describe("pipeline_decision_log outcome backfill D1 path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
  });

  it("queryPendingPipelineDecisionOutcomes returns rows with NULL forward_return_24h inside the ready/give-up window, oldest first", async () => {
    fake.rows = [
      { id: 1, run_at: 1000, symbol: "BTCUSDT", stop_loss: 59000, forward_return_24h: null },
      { id: 2, run_at: 500, symbol: "ETHUSDT", stop_loss: null, forward_return_24h: null },
      { id: 3, run_at: 900, symbol: "SOLUSDT", stop_loss: 100, forward_return_24h: 0.02 }, // already backfilled, excluded
      { id: 4, run_at: 100, symbol: "OLDUSDT", stop_loss: 1, forward_return_24h: null }, // too old, excluded by notOlderThan
    ];

    const pending = await queryPendingPipelineDecisionOutcomes(/* readyBefore */ 1500, /* notOlderThan */ 200, /* limit */ 10);
    expect(pending.map((r) => r.id)).toEqual([2, 1]); // oldest run_at first, excludes id 3 (already backfilled) and id 4 (too old)
  });

  it("queryPendingPipelineDecisionOutcomes respects the limit", async () => {
    fake.rows = [
      { id: 1, run_at: 100, symbol: "A", stop_loss: null, forward_return_24h: null },
      { id: 2, run_at: 200, symbol: "B", stop_loss: null, forward_return_24h: null },
      { id: 3, run_at: 300, symbol: "C", stop_loss: null, forward_return_24h: null },
    ];
    const pending = await queryPendingPipelineDecisionOutcomes(1000, 0, 2);
    expect(pending).toHaveLength(2);
  });

  it("updatePipelineDecisionOutcome writes forward returns and converts slTouched24h boolean to 0/1", async () => {
    fake.rows = [{ id: 1, run_at: 1000, symbol: "BTCUSDT", stop_loss: 59000, forward_return_24h: null }];

    await updatePipelineDecisionOutcome(1, {
      forwardReturn1h: 0.001,
      forwardReturn4h: 0.005,
      forwardReturn24h: 0.02,
      slTouched24h: true,
    });

    expect(fake.rows[0]).toMatchObject({
      forward_return_1h: 0.001,
      forward_return_4h: 0.005,
      forward_return_24h: 0.02,
      sl_touched_24h: 1,
    });
  });

  it("updatePipelineDecisionOutcome writes NULL for slTouched24h when stop-loss is unknown", async () => {
    fake.rows = [{ id: 1, run_at: 1000, symbol: "BTCUSDT", stop_loss: null, forward_return_24h: null }];

    await updatePipelineDecisionOutcome(1, {
      forwardReturn1h: 0.001,
      forwardReturn4h: 0.005,
      forwardReturn24h: 0.02,
      slTouched24h: null,
    });

    expect(fake.rows[0].sl_touched_24h).toBeNull();
  });
});

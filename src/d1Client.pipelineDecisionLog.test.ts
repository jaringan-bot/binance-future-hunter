// Fake D1 for pipeline_decision_log -- same hand-rolled approach as
// d1Client.entryAlertSkipLog.test.ts. Dispatch by SQL prefix; batch()
// runs each bound statement.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setD1Database,
  insertPipelineDecisionLogs,
  queryPipelineDecisionLog,
  pruneOldPipelineDecisionLog,
} from "./d1Client.js";
import type { PipelineDecisionLogRow } from "./pipelineDecisionLog.js";

interface FakeRow {
  run_at: number;
  symbol: string;
  source: string;
  source_ref: string | null;
  decision: string;
  ranking_score: number;
  hard_screen_passed: number;
  hard_screen_reasons: string | null;
  quote_volume_usd: number | null;
  funding_rate: number | null;
  regime_1h: string | null;
  regime_4h: string | null;
  grid_risk_status: string | null;
  lower_price: number | null;
  upper_price: number | null;
  stop_loss: number | null;
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
    if (this.sql.startsWith("INSERT INTO pipeline_decision_log")) {
      const [
        run_at,
        symbol,
        source,
        source_ref,
        decision,
        ranking_score,
        hard_screen_passed,
        hard_screen_reasons,
        quote_volume_usd,
        funding_rate,
        regime_1h,
        regime_4h,
        grid_risk_status,
        lower_price,
        upper_price,
        stop_loss,
      ] = this.args as [
        number,
        string,
        string,
        string | null,
        string,
        number,
        number,
        string,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
      ];
      this.db.rows.push({
        run_at,
        symbol,
        source,
        source_ref,
        decision,
        ranking_score,
        hard_screen_passed,
        hard_screen_reasons,
        quote_volume_usd,
        funding_rate,
        regime_1h,
        regime_4h,
        grid_risk_status,
        lower_price,
        upper_price,
        stop_loss,
      });
      return { success: true };
    }
    if (this.sql.startsWith("DELETE FROM pipeline_decision_log")) {
      const [cutoff] = this.args as [number];
      this.db.rows = this.db.rows.filter((r) => r.run_at >= cutoff);
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM pipeline_decision_log WHERE")) {
      const [start, end, ...rest] = this.args as [number, number, ...unknown[]];
      const limit = rest[rest.length - 1] as number;
      let i = 0;
      let symbol: string | undefined;
      let source: string | undefined;
      let sourceRef: string | undefined;
      if (this.sql.includes("symbol = ?")) symbol = rest[i++] as string;
      if (this.sql.includes("source = ?")) source = rest[i++] as string;
      if (this.sql.includes("source_ref = ?")) sourceRef = rest[i++] as string;
      let rows = this.db.rows.filter((r) => r.run_at >= start && r.run_at <= end);
      if (symbol) rows = rows.filter((r) => r.symbol === symbol);
      if (source) rows = rows.filter((r) => r.source === source);
      if (sourceRef) rows = rows.filter((r) => r.source_ref === sourceRef);
      rows = [...rows].sort((a, b) => b.run_at - a.run_at).slice(0, limit);
      return { results: rows as T[] };
    }
    throw new Error(`FakeStatement.all: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  rows: FakeRow[] = [];
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
  async batch(stmts: FakeStatement[]): Promise<{ success: true }[]> {
    const out: { success: true }[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

function sample(partial: Partial<PipelineDecisionLogRow> = {}): PipelineDecisionLogRow {
  return {
    runAt: 1_000,
    symbol: "BTCUSDT",
    source: "entry_alert",
    sourceRef: null,
    decision: "WATCH",
    rankingScore: 41,
    hardScreenPassed: true,
    hardScreenReasons: [],
    quoteVolumeUsd: 8_000_000,
    fundingRate: 0.0001,
    regime1h: "RANGING",
    regime4h: "RANGING",
    gridRiskStatus: "SAFE",
    lowerPrice: 100,
    upperPrice: 110,
    stopLoss: 95,
    ...partial,
  };
}

describe("pipeline_decision_log D1 read/write path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });
  afterEach(() => setD1Database(undefined));

  it("insertPipelineDecisionLogs no-ops on an empty list", async () => {
    await insertPipelineDecisionLogs([]);
    expect(fake.rows).toEqual([]);
  });

  it("batch-inserts compact rows and round-trips query filters", async () => {
    await insertPipelineDecisionLogs([
      sample({ runAt: 1000, symbol: "btcusdt", decision: "TRADE", rankingScore: 60 }),
      sample({
        runAt: 2000,
        symbol: "ATOMUSDT",
        source: "dropstab",
        sourceRef: "token-matang",
        decision: "WATCH",
        rankingScore: 40.5,
        hardScreenPassed: false,
        hardScreenReasons: ["funding"],
        lowerPrice: null,
        upperPrice: null,
        stopLoss: null,
      }),
    ]);

    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0].symbol).toBe("BTCUSDT");
    expect(fake.rows[0].hard_screen_passed).toBe(1);
    expect(fake.rows[1].source_ref).toBe("token-matang");
    expect(JSON.parse(fake.rows[1].hard_screen_reasons ?? "[]")).toEqual(["funding"]);

    const all = await queryPipelineDecisionLog({ startTime: 500, endTime: 3000 });
    expect(all.map((r) => r.symbol)).toEqual(["ATOMUSDT", "BTCUSDT"]);

    const atom = await queryPipelineDecisionLog({ startTime: 500, endTime: 3000, symbol: "atomusdt" });
    expect(atom).toHaveLength(1);
    expect(atom[0].source).toBe("dropstab");
    expect(atom[0].hardScreenPassed).toBe(false);
    expect(atom[0].hardScreenReasons).toEqual(["funding"]);
    expect(atom[0].stopLoss).toBeNull();

    const dropstab = await queryPipelineDecisionLog({
      startTime: 500,
      endTime: 3000,
      source: "dropstab",
      sourceRef: "token-matang",
    });
    expect(dropstab).toHaveLength(1);
    expect(dropstab[0].symbol).toBe("ATOMUSDT");
  });

  it("pruneOldPipelineDecisionLog deletes rows older than the cutoff", async () => {
    await insertPipelineDecisionLogs([sample({ runAt: 500, symbol: "OLDUSDT" }), sample({ runAt: 1500, symbol: "NEWUSDT" })]);
    await pruneOldPipelineDecisionLog(1000);
    expect(fake.rows.map((r) => r.symbol)).toEqual(["NEWUSDT"]);
  });
});

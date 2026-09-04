import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KlineTuple } from "../binanceProxyClient.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import {
  aggregateKeyedRows,
  emptyBucket,
  evaluateDecisionForward,
  registerPipelineDecisionBacktestTools,
} from "./pipelineDecisionBacktest.js";
import type { PipelineDecisionLogRow } from "../pipelineDecisionLog.js";

vi.mock("../binanceProxyClient.js", () => ({
  getKlinesNative: vi.fn(),
}));
vi.mock("../d1Client.js", () => ({
  queryPipelineDecisionLog: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function candle(close: number, low: number): KlineTuple {
  return [0, String(close), String(close + 1), String(low), String(close), "1", 1, "1", 1, "1", "1", "0"];
}

describe("evaluateDecisionForward", () => {
  it("returns null for empty or invalid candles", () => {
    expect(evaluateDecisionForward([], 10)).toBeNull();
    expect(evaluateDecisionForward([candle(0, 0)], 10)).toBeNull();
  });

  it("uses first close as entry and last close as exit", () => {
    const fwd = evaluateDecisionForward([candle(100, 99), candle(104, 98)], 90);
    expect(fwd).toMatchObject({
      entryPrice: 100,
      exitPrice: 104,
      forwardReturn: 0.04,
      slTouch: false,
    });
  });

  it("flags SL-touch when a low crosses stopLoss", () => {
    const fwd = evaluateDecisionForward([candle(100, 99), candle(101, 94)], 95);
    expect(fwd?.slTouch).toBe(true);
    expect(fwd?.forwardReturn).toBeCloseTo(0.01);
  });
});

describe("aggregateKeyedRows", () => {
  it("returns an empty object when there are no rows", () => {
    expect(aggregateKeyedRows([])).toEqual({});
    expect(emptyBucket()).toEqual({ sampleSize: 0, winRate: 0, avgReturn: 0, slTouchRate: null, slTouchSample: 0 });
  });

  it("computes win rate, avg return, and SL-touch only on known SL rows", () => {
    const buckets = aggregateKeyedRows([
      { key: "TRADE", forwardReturn: 0.04, slTouch: false },
      { key: "TRADE", forwardReturn: -0.02, slTouch: true },
      { key: "TRADE", forwardReturn: 0.01, slTouch: null },
      { key: "NO_TRADE", forwardReturn: -0.05, slTouch: false },
    ]);
    expect(buckets.TRADE.sampleSize).toBe(3);
    expect(buckets.TRADE.winRate).toBeCloseTo(2 / 3);
    expect(buckets.TRADE.avgReturn).toBeCloseTo((0.04 - 0.02 + 0.01) / 3);
    expect(buckets.TRADE.slTouchRate).toBeCloseTo(0.5);
    expect(buckets.TRADE.slTouchSample).toBe(2);
    expect(buckets.NO_TRADE.winRate).toBe(0);
    expect(buckets.NO_TRADE.slTouchRate).toBe(0);
  });
});

function logRow(partial: Partial<PipelineDecisionLogRow> = {}): PipelineDecisionLogRow {
  return {
    runAt: Date.parse("2026-08-20T00:00:00Z"),
    symbol: "BTCUSDT",
    source: "entry_alert",
    sourceRef: null,
    decision: "TRADE",
    rankingScore: 60,
    mmComponent: 55,
    mmAdverseComponent: 20,
    smartMoneyComponent: 50,
    regimeComponent: 60,
    buyPressureComponent: 45,
    hardScreenPassed: true,
    hardScreenReasons: [],
    quoteVolumeUsd: 9_000_000,
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

describe("whalescope_backtest_pipeline_decisions tool handler", () => {
  let handler: ToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    vi.clearAllMocks();
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as ToolHandler;
        return {};
      },
    } as unknown as McpServer;
    registerPipelineDecisionBacktestTools(fakeServer);
  });

  it("returns a friendly empty message when D1 has no rows", async () => {
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
    });
    const result = await handler(args);
    expect(result.content[0].text).toContain("Tidak ada row");
    expect(binanceProxy.getKlinesNative).not.toHaveBeenCalled();
  });

  it("aggregates on-demand forward returns by decision and score bucket", async () => {
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", decision: "TRADE", rankingScore: 60, stopLoss: 95 }),
      logRow({ symbol: "ATOMUSDT", decision: "WATCH", rankingScore: 42, stopLoss: 3.9 }),
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (symbol) => {
      if (symbol === "BTCUSDT") return [candle(100, 99), candle(103, 98)];
      return [candle(4.0, 3.8), candle(3.9, 3.7)];
    });

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
      forwardWindow: "4h",
    });
    const result = await handler(args);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      evaluatedCount: number;
      byDecision: Record<string, { sampleSize: number; winRate: number }>;
      byScoreBucket: Record<string, { sampleSize: number }>;
    };
    expect(structured.evaluatedCount).toBe(2);
    expect(structured.byDecision.TRADE.sampleSize).toBe(1);
    expect(structured.byDecision.TRADE.winRate).toBe(1);
    expect(structured.byDecision.WATCH.winRate).toBe(0);
    expect(structured.byScoreBucket.gte_55.sampleSize).toBe(1);
    expect(structured.byScoreBucket["40_55"].sampleSize).toBe(1);
    expect(binanceProxy.getKlinesNative).toHaveBeenCalledTimes(2);
  });

  it("applies fee_bps + slippage_bps to forward returns before aggregating", async () => {
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", decision: "TRADE", rankingScore: 60, stopLoss: 95 }),
    ]);
    // gross forward return = (100.3 - 100) / 100 = +0.003 (+30 bps)
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(100, 99), candle(100.3, 99)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
      forwardWindow: "4h",
      fee_bps: 20,
      slippage_bps: 5,
    });
    const result = await handler(args);
    const structured = result.structuredContent as {
      feeBps: number;
      slippageBps: number;
      execCostRoundTrip: number;
      overall: { winRate: number; avgReturn: number };
      byDecision: Record<string, { winRate: number }>;
      rows: { grossReturn: number; forwardReturn: number }[];
    };

    // round-trip cost = 2 * (20 + 5) / 10000 = 0.005 (50 bps) > 30 bps gross
    expect(structured.feeBps).toBe(20);
    expect(structured.slippageBps).toBe(5);
    expect(structured.execCostRoundTrip).toBeCloseTo(0.005, 10);
    expect(structured.rows[0].grossReturn).toBeCloseTo(0.003, 10);
    expect(structured.rows[0].forwardReturn).toBeCloseTo(0.003 - 0.005, 10);
    // gross win flips to a net loss
    expect(structured.overall.winRate).toBe(0);
    expect(structured.byDecision.TRADE.winRate).toBe(0);
  });

  it("defaults fee/slippage to the Binance-taker approximation", async () => {
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", decision: "TRADE", rankingScore: 60, stopLoss: 95 }),
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(100, 99), candle(105, 99)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
    });
    const result = await handler(args);
    const structured = result.structuredContent as { execCostRoundTrip: number; rows: { forwardReturn: number }[] };
    // default = 2 * (4 + 2) / 10000 = 0.0012
    expect(structured.execCostRoundTrip).toBeCloseTo(0.0012, 10);
    expect(structured.rows[0].forwardReturn).toBeCloseTo(0.05 - 0.0012, 10);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  extractOpenInterest,
  estimateStopLossLiquidityRisk,
  registerStopLossLiquidityRiskTools,
} from "./stopLossLiquidityRisk.js";

describe("extractOpenInterest", () => {
  it("handles a raw number", () => {
    expect(extractOpenInterest(1234.5)).toBe(1234.5);
  });

  it("handles a numeric string", () => {
    expect(extractOpenInterest("1234.5")).toBe(1234.5);
  });

  it("handles an object with 'openInterest' key", () => {
    expect(extractOpenInterest({ openInterest: "5000" })).toBe(5000);
  });

  it("handles an object with 'open_interest' key", () => {
    expect(extractOpenInterest({ open_interest: 5000 })).toBe(5000);
  });

  it("handles an object with 'sumOpenInterest' key", () => {
    expect(extractOpenInterest({ sumOpenInterest: "5000" })).toBe(5000);
  });

  it("handles an object with 'oi' key", () => {
    expect(extractOpenInterest({ oi: "5000" })).toBe(5000);
  });

  it("returns 0 and never throws for an unrecognized shape", () => {
    expect(extractOpenInterest({ foo: "bar" })).toBe(0);
    expect(extractOpenInterest(null)).toBe(0);
    expect(extractOpenInterest(undefined)).toBe(0);
    expect(extractOpenInterest([1, 2, 3])).toBe(0);
    expect(extractOpenInterest("not-a-number")).toBe(0);
  });
});

describe("estimateStopLossLiquidityRisk", () => {
  const bids: [string, string][] = [
    ["99", "100"],
    ["98", "100"],
  ];
  const asks: [string, string][] = [
    ["101", "100"],
    ["102", "100"],
  ];

  it("returns LOW when OI is healthy and depth-to-SL is well above the threshold", () => {
    const deepBids: [string, string][] = [
      ["99", "1000"],
      ["98", "1000"],
    ];
    const result = estimateStopLossLiquidityRisk("LONG", 100, 98, deepBids, asks, { openInterest: "5000" }, 50_000);
    expect(result.riskLevel).toBe("LOW");
  });

  it("returns HIGH_SLIPPAGE_RISK when depth-to-SL notional is below the threshold", () => {
    const thinBids: [string, string][] = [["99", "1"]];
    const result = estimateStopLossLiquidityRisk("LONG", 100, 98, thinBids, asks, { openInterest: "5000" }, 50_000);
    expect(result.riskLevel).toBe("HIGH_SLIPPAGE_RISK");
  });

  it("returns HIGH_DATA_INCOMPLETE when OI extraction fails", () => {
    const result = estimateStopLossLiquidityRisk("LONG", 100, 98, bids, asks, { unrelated: "field" }, 50_000);
    expect(result.riskLevel).toBe("HIGH_DATA_INCOMPLETE");
  });

  it("returns HIGH_DATA_INCOMPLETE when the SL-walk is rejected (LONG, SL >= currentPrice)", () => {
    const result = estimateStopLossLiquidityRisk("LONG", 100, 100, bids, asks, { openInterest: "5000" }, 50_000);
    expect(result.riskLevel).toBe("HIGH_DATA_INCOMPLETE");
    expect(result.slWalkRejected).toBe(true);
  });

  it("SHORT walks asks upward, not bids", () => {
    const result = estimateStopLossLiquidityRisk("SHORT", 100, 102, bids, asks, { openInterest: "5000" }, 50_000);
    expect(result.slWalkRejected).toBe(false);
    // 101*100 + 102*100 = 20300 -- below 50k threshold given only 2 thin levels
    expect(result.depthToStopLossNotionalUsd).toBeCloseTo(101 * 100 + 102 * 100, 5);
    expect(result.riskLevel).toBe("HIGH_SLIPPAGE_RISK");
  });
});

type RiskToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type RiskToolHandler = (args: {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  currentPrice: number;
  stopLossPrice: number;
  bids: [string, string][];
  asks: [string, string][];
  openInterest: unknown;
  slippageThresholdUsd: number;
}) => Promise<RiskToolResult>;

describe("estimate_stop_loss_liquidity_risk tool handler", () => {
  let handler: RiskToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as RiskToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerStopLossLiquidityRiskTools(fakeServer);
  });

  it("SHORT walks asks at the handler level (wiring check)", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "BTCUSDT",
      positionSide: "SHORT",
      currentPrice: 100,
      stopLossPrice: 102,
      bids: [["99", "100"]],
      asks: [
        ["101", "100"],
        ["102", "100"],
      ],
      openInterest: { openInterest: "5000" },
    }) as Parameters<RiskToolHandler>[0];

    const result = await handler(args);

    expect(result.structuredContent?.depthToStopLossNotionalUsd).toBeCloseTo(101 * 100 + 102 * 100, 5);
  });

  it("LONG rejected when stopLossPrice >= currentPrice surfaces as HIGH_DATA_INCOMPLETE at handler level", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "BTCUSDT",
      positionSide: "LONG",
      currentPrice: 100,
      stopLossPrice: 100,
      bids: [["99", "100"]],
      asks: [["101", "100"]],
      openInterest: { openInterest: "5000" },
    }) as Parameters<RiskToolHandler>[0];

    const result = await handler(args);

    expect(result.structuredContent?.riskLevel).toBe("HIGH_DATA_INCOMPLETE");
  });
});

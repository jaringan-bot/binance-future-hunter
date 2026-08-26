import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AggTrade } from "../binanceProxyClient.js";
import { computeCvdDivergence, registerCvdDivergenceTools } from "./cvdDivergence.js";

function trade(overrides: Partial<AggTrade> = {}): AggTrade {
  return { a: 1, p: "100", q: "1", f: 1, l: 1, T: 0, m: false, ...overrides };
}

// buyPct helper: builds N trades with a given fraction buy (m=false) vs sell (m=true).
function makeTrades(count: number, buyFraction: number, startT: number, endT: number): AggTrade[] {
  const buyCount = Math.round(count * buyFraction);
  return Array.from({ length: count }, (_, i) => {
    const T = count > 1 ? startT + Math.round(((endT - startT) * i) / (count - 1)) : startT;
    return trade({ a: i, T, m: i >= buyCount });
  });
}

describe("computeCvdDivergence", () => {
  it("returns EMPTY_SPOT_TRADES when spot array is empty", () => {
    const result = computeCvdDivergence([], makeTrades(10, 0.5, 0, 1000), 0.8, 0.05);
    expect(result.errorCode).toBe("EMPTY_SPOT_TRADES");
  });

  it("returns EMPTY_FUTURES_TRADES when futures array is empty", () => {
    const result = computeCvdDivergence(makeTrades(10, 0.5, 0, 1000), [], 0.8, 0.05);
    expect(result.errorCode).toBe("EMPTY_FUTURES_TRADES");
  });

  it("returns MISALIGNED_WINDOWS when the two trade arrays' timestamp ranges barely overlap", () => {
    const spot = makeTrades(10, 0.5, 0, 1000);
    const futures = makeTrades(10, 0.5, 100_000, 200_000);
    const result = computeCvdDivergence(spot, futures, 0.8, 0.05);
    expect(result.errorCode).toBe("MISALIGNED_WINDOWS");
  });

  it("classifies as NEUTRAL when buyPct is nearly equal between spot and futures", () => {
    const spot = makeTrades(100, 0.5, 0, 1000); // buyPct ~50
    const futures = makeTrades(100, 0.52, 0, 1000); // buyPct ~52
    const result = computeCvdDivergence(spot, futures, 0.8, 0.05);
    expect(result.errorCode).toBeUndefined();
    expect(result.classification).toBe("NEUTRAL");
    expect(result.divergence).not.toBe(0);
  });

  it("classifies as DIVERGENT when buyPct differs sharply between spot and futures", () => {
    const spot = makeTrades(100, 0.5, 0, 1000); // buyPct ~50
    const futures = makeTrades(100, 0.9, 0, 1000); // buyPct ~90
    const result = computeCvdDivergence(spot, futures, 0.8, 0.05);
    expect(result.errorCode).toBeUndefined();
    expect(result.classification).toBe("DIVERGENT");
  });
});

type CvdToolResult = {
  isError?: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type CvdToolHandler = (args: {
  symbol?: string;
  spotTrades: AggTrade[];
  futuresTrades: AggTrade[];
  minOverlapRatio: number;
  neutralThresholdPct: number;
}) => Promise<CvdToolResult>;

describe("analyze_cvd_divergence tool handler", () => {
  let handler: CvdToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as CvdToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerCvdDivergenceTools(fakeServer);
  });

  it("defaults minOverlapRatio and neutralThresholdPct when not provided", async () => {
    const spot = makeTrades(50, 0.5, 0, 1000);
    const futures = makeTrades(50, 0.5, 0, 1000);
    const args = z.object(inputSchema).parse({ spotTrades: spot, futuresTrades: futures }) as Parameters<CvdToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.classification).toBe("NEUTRAL");
  });

  it("surfaces MISALIGNED_WINDOWS as isError with errorCode", async () => {
    const spot = makeTrades(10, 0.5, 0, 1000);
    const futures = makeTrades(10, 0.5, 500_000, 600_000);
    const args = z.object(inputSchema).parse({ spotTrades: spot, futuresTrades: futures }) as Parameters<CvdToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe("MISALIGNED_WINDOWS");
  });
});

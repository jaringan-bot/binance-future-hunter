import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FundingRateHistoryPoint } from "../binanceProxyClient.js";
import { computeFundingVelocity, registerFundingVelocityTools } from "./fundingVelocity.js";

const HOUR_MS = 3_600_000;

function point(fundingTime: number, fundingRate: string): FundingRateHistoryPoint {
  return { symbol: "BTCUSDT", fundingTime, fundingRate, markPrice: "50000" };
}

describe("computeFundingVelocity", () => {
  it("returns INSUFFICIENT_POINTS with fewer than 2 points in the window", () => {
    const result = computeFundingVelocity([point(0, "0.0001")], 4);
    expect(result.errorCode).toBe("INSUFFICIENT_POINTS");
  });

  it("returns NON_POSITIVE_ELAPSED_TIME when all points in the window share the same timestamp", () => {
    const result = computeFundingVelocity([point(1000, "0.0001"), point(1000, "0.0002")], 4);
    expect(result.errorCode).toBe("NON_POSITIVE_ELAPSED_TIME");
  });

  it("returns MALFORMED_PAYLOAD when a fundingRate string doesn't parse", () => {
    const result = computeFundingVelocity([point(0, "0.0001"), point(8 * HOUR_MS, "not-a-number")], 4);
    expect(result.errorCode).toBe("MALFORMED_PAYLOAD");
  });

  it("computes the correct OLS slope on a perfectly linear 3-point series (sanity check)", () => {
    const history = [point(0, "0.0001"), point(8 * HOUR_MS, "0.0002"), point(16 * HOUR_MS, "0.0003")];
    const result = computeFundingVelocity(history, 4);

    expect(result.errorCode).toBeUndefined();
    expect(result.pointsUsed).toBe(3);
    // Linear: +0.0001 per 8h = 0.0000125 per hour.
    expect(result.olsVelocityPerHour).toBeCloseTo(0.0000125, 10);
    expect(result.maxStepDelta).toBeCloseTo(0.0001, 10);
  });

  // THE critical case: a spike-then-reversal that a naive two-point endpoint
  // slope (the old buggy method) would report as ~zero velocity with NO
  // indication anything happened in between. Full OLS regression over all
  // points ALSO reports ~zero net slope here (symmetric data) -- that's
  // correct, the endpoints really are equal. What proves the fix works is
  // maxStepDelta catching the spike that the slope alone hides completely.
  // Skipping this case would let a regression to the old two-point method
  // pass every other test unnoticed.
  it("detects a hidden spike-then-reversal via maxStepDelta while olsVelocityPerHour stays near zero", () => {
    const history = [point(0, "0.0001"), point(8 * HOUR_MS, "0.0005"), point(16 * HOUR_MS, "0.0001")];
    const result = computeFundingVelocity(history, 4);

    expect(result.errorCode).toBeUndefined();
    expect(result.olsVelocityPerHour).toBeCloseTo(0, 10);
    expect(result.maxStepDelta).toBeCloseTo(0.0004, 10);
  });

  it("only uses the most recent velocityWindowIntervals points, not the whole history", () => {
    const history = [
      point(0, "0.0009"), // far outlier, outside the window of 2
      point(8 * HOUR_MS, "0.0001"),
      point(16 * HOUR_MS, "0.0002"),
    ];
    const result = computeFundingVelocity(history, 2);

    expect(result.pointsUsed).toBe(2);
    expect(result.windowStartMs).toBe(8 * HOUR_MS);
    expect(result.olsVelocityPerHour).toBeCloseTo(0.0000125, 10);
  });

  it("does not return any categorical regime label field", () => {
    const history = [point(0, "0.0001"), point(8 * HOUR_MS, "0.0002")];
    const result = computeFundingVelocity(history, 4);

    expect(result).not.toHaveProperty("regime");
    expect(result).not.toHaveProperty("label");
  });
});

type FundingVelocityToolResult = {
  isError?: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type FundingVelocityToolHandler = (args: {
  symbol?: string;
  fundingHistory: FundingRateHistoryPoint[];
  velocityWindowIntervals: number;
}) => Promise<FundingVelocityToolResult>;

describe("compute_funding_velocity tool handler", () => {
  let handler: FundingVelocityToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as FundingVelocityToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerFundingVelocityTools(fakeServer);
  });

  it("defaults velocityWindowIntervals to 4 when not provided", async () => {
    const history = [point(0, "0.0001"), point(8 * HOUR_MS, "0.0002"), point(16 * HOUR_MS, "0.0003")];
    const args = z.object(inputSchema).parse({ fundingHistory: history }) as Parameters<FundingVelocityToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.pointsUsed).toBe(3);
  });
});

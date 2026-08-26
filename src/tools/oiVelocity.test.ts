import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenInterestHistPoint } from "../binanceProxyClient.js";
import { computeOiVelocity, registerOiVelocityTools } from "./oiVelocity.js";

const HOUR_MS = 3_600_000;

function point(timestamp: number, sumOpenInterest: string): OpenInterestHistPoint {
  return { symbol: "BTCUSDT", sumOpenInterest, sumOpenInterestValue: "0", timestamp };
}

describe("computeOiVelocity", () => {
  it("returns INSUFFICIENT_POINTS with fewer than 2 points in the window", () => {
    const result = computeOiVelocity([point(0, "1000")], 4);
    expect(result.errorCode).toBe("INSUFFICIENT_POINTS");
  });

  it("returns MALFORMED_PAYLOAD when a sumOpenInterest string doesn't parse", () => {
    const result = computeOiVelocity([point(0, "1000"), point(HOUR_MS, "not-a-number")], 4);
    expect(result.errorCode).toBe("MALFORMED_PAYLOAD");
  });

  it("returns NON_CHRONOLOGICAL when timestamps are not non-decreasing", () => {
    const history = [point(0, "1000"), point(20_000, "1100"), point(10_000, "1050")];
    const result = computeOiVelocity(history, 4);
    expect(result.errorCode).toBe("NON_CHRONOLOGICAL");
  });

  it("returns NON_POSITIVE_ELAPSED_TIME when all points in the window share the same timestamp", () => {
    const result = computeOiVelocity([point(1000, "1000"), point(1000, "1100")], 4);
    expect(result.errorCode).toBe("NON_POSITIVE_ELAPSED_TIME");
  });

  it("computes a positive OLS velocity for a normal upward trend", () => {
    const history = [point(0, "1000"), point(HOUR_MS, "1100"), point(2 * HOUR_MS, "1200")];
    const result = computeOiVelocity(history, 4);

    expect(result.errorCode).toBeUndefined();
    expect(result.pointsUsed).toBe(3);
    // Linear: +100 per hour.
    expect(result.oiVelocityPerHour).toBeCloseTo(100, 6);
    expect(result.maxStepDelta).toBeCloseTo(100, 6);
  });

  it("computes a negative OLS velocity for a normal downward trend", () => {
    const history = [point(0, "1200"), point(HOUR_MS, "1100"), point(2 * HOUR_MS, "1000")];
    const result = computeOiVelocity(history, 4);

    expect(result.errorCode).toBeUndefined();
    expect(result.oiVelocityPerHour).toBeCloseTo(-100, 6);
    expect(result.maxStepDelta).toBeCloseTo(100, 6);
  });

  it("computes ~zero OLS velocity for a flat/no-change series", () => {
    const history = [point(0, "1000"), point(HOUR_MS, "1000"), point(2 * HOUR_MS, "1000")];
    const result = computeOiVelocity(history, 4);

    expect(result.errorCode).toBeUndefined();
    expect(result.oiVelocityPerHour).toBeCloseTo(0, 10);
    expect(result.maxStepDelta).toBeCloseTo(0, 10);
  });

  // THE critical ported behavior from compute_funding_velocity: a spike-then-
  // reversal that a naive two-point endpoint slope would report as ~zero
  // velocity with no indication anything happened in between. Full OLS
  // ALSO reports ~zero net slope here (symmetric data) -- that's correct.
  // What proves the port works is maxStepDelta catching the spike the
  // slope alone hides completely.
  it("detects a hidden spike-then-reversal via maxStepDelta while oiVelocityPerHour stays near zero", () => {
    const history = [point(0, "1000"), point(HOUR_MS, "5000"), point(2 * HOUR_MS, "1000")];
    const result = computeOiVelocity(history, 4);

    expect(result.errorCode).toBeUndefined();
    expect(result.oiVelocityPerHour).toBeCloseTo(0, 10);
    expect(result.maxStepDelta).toBeCloseTo(4000, 6);
  });

  it("only uses the most recent velocityWindowIntervals points, not the whole history", () => {
    const history = [
      point(0, "9000"), // far outlier, outside the window of 2
      point(HOUR_MS, "1000"),
      point(2 * HOUR_MS, "1100"),
    ];
    const result = computeOiVelocity(history, 2);

    expect(result.pointsUsed).toBe(2);
    expect(result.windowStartMs).toBe(HOUR_MS);
    expect(result.oiVelocityPerHour).toBeCloseTo(100, 6);
  });

  it("does not return any categorical regime label field", () => {
    const history = [point(0, "1000"), point(HOUR_MS, "1100")];
    const result = computeOiVelocity(history, 4);

    expect(result).not.toHaveProperty("regime");
    expect(result).not.toHaveProperty("label");
  });
});

type OiVelocityToolResult = {
  isError?: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type OiVelocityToolHandler = (args: {
  symbol?: string;
  oiHistory: OpenInterestHistPoint[];
  velocityWindowIntervals: number;
}) => Promise<OiVelocityToolResult>;

describe("whalescope_get_oi_velocity tool handler", () => {
  let handler: OiVelocityToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as OiVelocityToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerOiVelocityTools(fakeServer);
  });

  it("defaults velocityWindowIntervals to 4 when not provided", async () => {
    const history = [point(0, "1000"), point(HOUR_MS, "1100"), point(2 * HOUR_MS, "1200")];
    const args = z.object(inputSchema).parse({ oiHistory: history }) as Parameters<OiVelocityToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.pointsUsed).toBe(3);
  });

  it("surfaces NON_CHRONOLOGICAL as isError with errorCode", async () => {
    const history = [point(0, "1000"), point(20_000, "1100"), point(10_000, "1050")];
    const args = z.object(inputSchema).parse({ oiHistory: history }) as Parameters<OiVelocityToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe("NON_CHRONOLOGICAL");
  });
});

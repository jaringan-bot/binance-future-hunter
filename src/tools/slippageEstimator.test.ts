import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSlippageEstimatorTools } from "./slippageEstimator.js";

type SlippageToolResult = {
  isError?: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type SlippageToolHandler = (args: {
  symbol: string;
  side: "BUY" | "SELL";
  targetNotionalUsd: number;
  bids: [string, string][];
  asks: [string, string][];
}) => Promise<SlippageToolResult>;

describe("estimate_slippage tool handler", () => {
  let handler: SlippageToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as SlippageToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerSlippageEstimatorTools(fakeServer);
  });

  it("uses asks (not bids) when side=BUY", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "BTCUSDT",
      side: "BUY",
      targetNotionalUsd: 500,
      bids: [["90", "100"]],
      asks: [["100", "10"]],
    }) as Parameters<SlippageToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.bestPrice).toBe(100);
  });

  it("uses bids (not asks) when side=SELL", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "BTCUSDT",
      side: "SELL",
      targetNotionalUsd: 500,
      bids: [["90", "10"]],
      asks: [["100", "100"]],
    }) as Parameters<SlippageToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.bestPrice).toBe(90);
  });

  it("returns isError + errorCode in structuredContent when depth is empty", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "BTCUSDT",
      side: "BUY",
      targetNotionalUsd: 500,
      bids: [],
      asks: [],
    }) as Parameters<SlippageToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe("EMPTY_DEPTH");
  });
});

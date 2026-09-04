import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeribitOptionsTools } from "./deribitOptions.js";
import * as deribitClient from "../deribitClient.js";

vi.mock("../deribitClient.js", () => ({
  getOptionsSummary: vi.fn(),
  computeOptionsPositioning: vi.fn(),
}));

type ToolResult = { content: [{ type: "text"; text: string }]; structuredContent?: Record<string, unknown>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("binance_get_options_positioning tool", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;
    registerDeribitOptionsTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("binance_get_options_positioning");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("fetches summary, computes positioning, and surfaces put/call ratio", async () => {
    vi.mocked(deribitClient.getOptionsSummary).mockResolvedValue([
      { instrument_name: "BTC-4SEP26-100000-C", open_interest: 100, volume: 1 },
    ]);
    vi.mocked(deribitClient.computeOptionsPositioning).mockReturnValue({
      currency: "BTC",
      instrumentCount: 1,
      callCount: 1,
      putCount: 0,
      totalCallOi: 100,
      totalPutOi: 0,
      putCallRatio: 0,
      totalVolume: 1,
    });

    const result = await call({ coin: "BTC" });
    expect(deribitClient.getOptionsSummary).toHaveBeenCalledWith("BTC");
    expect(deribitClient.computeOptionsPositioning).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Put/Call Ratio");
    expect(result.structuredContent?.positioning).toMatchObject({ totalCallOi: 100 });
  });

  it("returns error result when client throws", async () => {
    vi.mocked(deribitClient.getOptionsSummary).mockRejectedValue(new Error("boom"));
    const result = await call({ coin: "ETH" });
    expect(result.isError).toBe(true);
  });
});

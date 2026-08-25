import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStablecoinSupplyTools } from "./stablecoinSupply.js";
import * as stablecoinClient from "../stablecoinClient.js";
import type { StablecoinSupply } from "../stablecoinClient.js";

vi.mock("../stablecoinClient.js", () => ({
  getStablecoinSupply: vi.fn(),
}));

function makeSupply(): StablecoinSupply {
  return {
    id: "1",
    symbol: "USDT",
    name: "Tether",
    circulating: 1000,
    circulatingPrevDay: 950,
    circulatingPrevWeek: 900,
    changeDayPct: 0.0526,
    changeWeekPct: 0.1111,
    topChains: [
      { chain: "Ethereum", circulating: 600 },
      { chain: "Tron", circulating: 300 },
    ],
  };
}

type ToolResult = { content: [{ type: "text"; text: string }]; structuredContent?: Record<string, unknown>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("whalescope_get_stablecoin_supply tool", () => {
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
    registerStablecoinSupplyTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("whalescope_get_stablecoin_supply");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("reports total supply, deltas, and top chains", async () => {
    vi.mocked(stablecoinClient.getStablecoinSupply).mockResolvedValue(makeSupply());
    const result = await call({ symbol: "USDT" });

    expect(stablecoinClient.getStablecoinSupply).toHaveBeenCalledWith("USDT");
    expect(result.content[0].text).toContain("Tether");
    expect(result.content[0].text).toContain("Ethereum");
    expect(result.structuredContent?.supply).toMatchObject({ symbol: "USDT" });
  });

  it("returns an error result when the client throws", async () => {
    vi.mocked(stablecoinClient.getStablecoinSupply).mockRejectedValue(new Error("boom"));
    const result = await call({ symbol: "USDC" });
    expect(result.isError).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRiskTools } from "./risk.js";
import * as binanceProxy from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getAdlRiskNative: vi.fn(),
  getInsuranceFundBalanceNative: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("binance_get_insurance_fund_balance", () => {
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
    registerRiskTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("binance_get_insurance_fund_balance");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("does not throw when the payload omits assets/symbols (no symbol filter)", async () => {
    vi.mocked(binanceProxy.getInsuranceFundBalanceNative).mockResolvedValue({
      assets: undefined as unknown as never,
      symbols: undefined as unknown as never,
    });
    const result = await call({});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.assets).toEqual([]);
    expect(result.structuredContent?.symbols).toEqual([]);
    expect(result.content[0].text).toMatch(/kosong|Tidak ada baris/i);
  });

  it("still renders rows when a symbol filter returns assets", async () => {
    vi.mocked(binanceProxy.getInsuranceFundBalanceNative).mockResolvedValue({
      symbols: ["BTCUSDT"],
      assets: [{ asset: "USDT", marginBalance: "1000", updateTime: 1_700_000_000_000 }],
    });
    const result = await call({ symbol: "BTCUSDT" });
    expect(result.content[0].text).toContain("USDT");
    expect((result.structuredContent?.assets as unknown[]).length).toBe(1);
  });
});

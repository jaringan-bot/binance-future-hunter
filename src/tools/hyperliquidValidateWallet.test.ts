import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHyperliquidValidateWalletTools } from "./hyperliquidValidateWallet.js";
import * as hyperliquidClient from "../hyperliquidClient.js";

vi.mock("../hyperliquidClient.js", () => ({
  getUserClearinghouseSnapshot: vi.fn(),
}));

type ToolResult = { content: [{ type: "text"; text: string }]; structuredContent?: Record<string, unknown>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ADDR = "0x31ca8395cf837de08b24da3f660e77761dfb974b";

describe("hyperliquid_validate_candidate_wallet tool", () => {
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
    registerHyperliquidValidateWalletTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("hyperliquid_validate_candidate_wallet");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("reports equity and open positions for a candidate address", async () => {
    vi.mocked(hyperliquidClient.getUserClearinghouseSnapshot).mockResolvedValue({
      address: ADDR,
      accountValue: 1_000_000,
      withdrawable: 100_000,
      totalMarginUsed: 50_000,
      positions: [{ coin: "BTC", side: "short", size: 0.5, entryPrice: 80000, leverage: 20 }],
    });

    const result = await call({ address: ADDR });
    expect(hyperliquidClient.getUserClearinghouseSnapshot).toHaveBeenCalledWith(ADDR);
    expect(result.content[0].text).toContain("Account Value");
    expect(result.content[0].text).toContain("BTC");
    expect(result.structuredContent?.snapshot).toMatchObject({ accountValue: 1_000_000 });
  });

  it("rejects invalid address via zod before calling the client", async () => {
    expect(() => call({ address: "not-an-address" })).toThrow();
    expect(hyperliquidClient.getUserClearinghouseSnapshot).not.toHaveBeenCalled();
  });

  it("returns error result when client throws", async () => {
    vi.mocked(hyperliquidClient.getUserClearinghouseSnapshot).mockRejectedValue(new Error("boom"));
    const result = await call({ address: ADDR });
    expect(result.isError).toBe(true);
  });
});

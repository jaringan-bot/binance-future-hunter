import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCftcPositioningTools } from "./cftcPositioning.js";
import * as cftcClient from "../cftcClient.js";
import type { CftcPositioningReport } from "../cftcClient.js";

vi.mock("../cftcClient.js", () => ({
  getCftcPositioning: vi.fn(),
}));

function makeReport(): CftcPositioningReport {
  return {
    contractMarketName: "BITCOIN",
    reportDate: "2026-08-18T00:00:00.000",
    openInterest: 21760,
    leveragedFunds: { long: 4488, short: 11927, netPct: -0.3418, changeLong: -509, changeShort: -122 },
    assetManagers: { long: 4531, short: 1799, netPct: 0.1256, changeLong: -210, changeShort: -708 },
  };
}

type ToolResult = { content: [{ type: "text"; text: string }]; structuredContent?: Record<string, unknown>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("cme_get_institutional_positioning tool", () => {
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
    registerCftcPositioningTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("cme_get_institutional_positioning");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("reports leveraged funds and asset manager positioning with a weekly-lag warning", async () => {
    vi.mocked(cftcClient.getCftcPositioning).mockResolvedValue(makeReport());
    const result = await call({ coin: "BTC" });

    expect(cftcClient.getCftcPositioning).toHaveBeenCalledWith("BTC");
    expect(result.content[0].text).toContain("Leveraged Funds");
    expect(result.content[0].text).toContain("mingguan");
    expect(result.structuredContent?.report).toMatchObject({ contractMarketName: "BITCOIN" });
  });

  it("returns an error result when the client throws", async () => {
    vi.mocked(cftcClient.getCftcPositioning).mockRejectedValue(new Error("boom"));
    const result = await call({ coin: "ETH" });
    expect(result.isError).toBe(true);
  });
});

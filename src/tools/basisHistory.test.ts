import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBasisHistoryTools } from "./basisHistory.js";
import * as d1Client from "../d1Client.js";
import * as queryFrequency from "../queryFrequency.js";

vi.mock("../d1Client.js", () => ({
  queryMarketSnapshots: vi.fn(),
}));

vi.mock("../queryFrequency.js", () => ({
  recordNonWatchlistQuery: vi.fn(),
  MIN_QUERY_COUNT: 3,
  TOP_N_NON_WATCHLIST: 5,
}));

type BasisToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type BasisToolHandler = (args: { symbol: string; hours: number }) => Promise<BasisToolResult>;

describe("binance_get_basis_history tool handler", () => {
  let handler: BasisToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    vi.clearAllMocks();

    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as BasisToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerBasisHistoryTools(fakeServer);
  });

  it("accepts a NON-watchlist symbol without throwing at schema validation (regression -- used to be z.enum(SNAPSHOT_WATCHLIST))", () => {
    expect(() => z.object(inputSchema).parse({ symbol: "PEPEUSDT" })).not.toThrow();
  });

  it("still accepts a watchlist symbol", () => {
    expect(() => z.object(inputSchema).parse({ symbol: "BTCUSDT" })).not.toThrow();
  });

  it("calls recordNonWatchlistQuery for a non-watchlist symbol", async () => {
    vi.mocked(d1Client.queryMarketSnapshots).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({ symbol: "PEPEUSDT" }) as { symbol: string; hours: number };
    await handler(args);
    expect(queryFrequency.recordNonWatchlistQuery).toHaveBeenCalledWith("PEPEUSDT");
  });

  it("does not record a query-frequency hit for a watchlist symbol", async () => {
    vi.mocked(d1Client.queryMarketSnapshots).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as { symbol: string; hours: number };
    await handler(args);
    expect(queryFrequency.recordNonWatchlistQuery).not.toHaveBeenCalled();
  });

  it("returns the watchlist-flavored empty-history message for a watchlist symbol with no rows", async () => {
    vi.mocked(d1Client.queryMarketSnapshots).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as { symbol: string; hours: number };
    const result = await handler(args);
    expect(result.content[0].text).toContain("Cron snapshot jalan tiap 5 menit");
    expect(result.content[0].text).not.toContain("sering di-query");
  });

  it("returns the non-watchlist-flavored empty-history message (mentions query-frequency mechanism) for a non-watchlist symbol with no rows", async () => {
    vi.mocked(d1Client.queryMarketSnapshots).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({ symbol: "PEPEUSDT" }) as { symbol: string; hours: number };
    const result = await handler(args);
    expect(result.content[0].text).toContain("sering di-query");
    expect(result.content[0].text).toContain("BUKAN bagian watchlist tetap");
  });

  it("renders non-empty history normally for a watchlist symbol", async () => {
    vi.mocked(d1Client.queryMarketSnapshots).mockResolvedValue([
      { symbol: "BTCUSDT", timestamp: 1000, spotPrice: 100, markPrice: 100.1, basis: 0.001, fundingRate: 0.0001, openInterest: 500 },
      { symbol: "BTCUSDT", timestamp: 2000, spotPrice: 101, markPrice: 101.2, basis: 0.002, fundingRate: 0.0001, openInterest: 510 },
    ]);
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as { symbol: string; hours: number };
    const result = await handler(args);
    expect(result.content[0].text).toContain("Histori Basis");
    expect(result.structuredContent?.pointCount).toBe(2);
  });
});

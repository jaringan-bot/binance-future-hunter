import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeWhaleDeltas, aggregateWhaleDeltas, registerHyperliquidWhaleTools } from "./hyperliquidWhale.js";
import * as d1Client from "../d1Client.js";
import type { HyperliquidWhaleSnapshotRow } from "../d1Client.js";

vi.mock("../d1Client.js", () => ({
  queryHyperliquidWhaleRecentByCoin: vi.fn(),
}));

function row(overrides: Partial<HyperliquidWhaleSnapshotRow>): HyperliquidWhaleSnapshotRow {
  return {
    walletAddress: "0xdefault",
    coin: "BTC",
    capturedAt: Date.now(),
    side: "long",
    size: 1,
    entryPrice: 64000,
    leverage: 10,
    ...overrides,
  };
}

describe("computeWhaleDeltas", () => {
  it("marks a wallet with only one snapshot as 'new'", () => {
    const rows = [row({ walletAddress: "0xa", capturedAt: 100 })];
    const [delta] = computeWhaleDeltas(rows);
    expect(delta).toMatchObject({ walletAddress: "0xa", direction: "new", previousSize: null, deltaPct: null });
  });

  it("marks side change between snapshots as 'flipped'", () => {
    const rows = [
      row({ walletAddress: "0xa", capturedAt: 200, side: "short", size: 2 }),
      row({ walletAddress: "0xa", capturedAt: 100, side: "long", size: 2 }),
    ];
    const [delta] = computeWhaleDeltas(rows);
    expect(delta).toMatchObject({ direction: "flipped", side: "short", deltaPct: null });
  });

  it("marks size increase beyond 5% threshold as 'accumulating'", () => {
    const rows = [
      row({ walletAddress: "0xa", capturedAt: 200, size: 2 }),
      row({ walletAddress: "0xa", capturedAt: 100, size: 1 }),
    ];
    const [delta] = computeWhaleDeltas(rows);
    expect(delta.direction).toBe("accumulating");
    expect(delta.deltaPct).toBeCloseTo(1);
  });

  it("marks size decrease beyond 5% threshold as 'reducing'", () => {
    const rows = [
      row({ walletAddress: "0xa", capturedAt: 200, size: 1 }),
      row({ walletAddress: "0xa", capturedAt: 100, size: 2 }),
    ];
    const [delta] = computeWhaleDeltas(rows);
    expect(delta.direction).toBe("reducing");
    expect(delta.deltaPct).toBeCloseTo(-0.5);
  });

  it("marks change within +/-5% as 'flat'", () => {
    const rows = [
      row({ walletAddress: "0xa", capturedAt: 200, size: 1.02 }),
      row({ walletAddress: "0xa", capturedAt: 100, size: 1 }),
    ];
    const [delta] = computeWhaleDeltas(rows);
    expect(delta.direction).toBe("flat");
  });

  it("handles multiple wallets independently", () => {
    const rows = [
      row({ walletAddress: "0xa", capturedAt: 100 }),
      row({ walletAddress: "0xb", capturedAt: 200, side: "short", size: 5 }),
      row({ walletAddress: "0xb", capturedAt: 100, side: "short", size: 5 }),
    ];
    const deltas = computeWhaleDeltas(rows);
    expect(deltas).toHaveLength(2);
  });
});

describe("aggregateWhaleDeltas", () => {
  it("counts net long/short wallets and computes confidence as the dominant side's share", () => {
    const deltas = [
      { walletAddress: "0xa", side: "long" as const, latestSize: 1, previousSize: 1, deltaPct: 0.1, direction: "accumulating" as const },
      { walletAddress: "0xb", side: "long" as const, latestSize: 1, previousSize: 1, deltaPct: 0, direction: "flat" as const },
      { walletAddress: "0xc", side: "short" as const, latestSize: 1, previousSize: null, deltaPct: null, direction: "new" as const },
    ];
    const aggregate = aggregateWhaleDeltas("BTC", deltas);
    expect(aggregate).toMatchObject({
      totalWallets: 3,
      netLongWallets: 2,
      netShortWallets: 1,
      accumulatingCount: 1,
      reducingCount: 0,
      flippedCount: 0,
    });
    expect(aggregate.confidencePct).toBeCloseTo(2 / 3);
  });

  it("returns zero confidence for an empty delta list", () => {
    expect(aggregateWhaleDeltas("BTC", []).confidencePct).toBe(0);
  });
});

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("hyperliquid_get_whale_wallet_positions tool", () => {
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
    registerHyperliquidWhaleTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("hyperliquid_get_whale_wallet_positions");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  // HYPERLIQUID_WHALE_WATCHLIST default kosong (shared.ts) -- ini exercise
  // guard clause tool tanpa perlu mock shared.js.
  it("returns an error result when the whale watchlist is empty (default state)", async () => {
    const result = await call({ coin: "BTC" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HYPERLIQUID_WHALE_WATCHLIST masih kosong");
    expect(d1Client.queryHyperliquidWhaleRecentByCoin).not.toHaveBeenCalled();
  });
});

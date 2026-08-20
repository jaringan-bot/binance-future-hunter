import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classifyRegime, registerMarketRegimeTools, type RegimeInput } from "./marketRegime.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";

function baseInput(overrides: Partial<RegimeInput> = {}): RegimeInput {
  return {
    adx: 15,
    plusDI: 20,
    minusDI: 20,
    oiChangePct: 0,
    priceChangePct: 0,
    cvdBuyPct: 50,
    volatilitySpikeRatio: 1,
    volumeSpikeRatio: 1,
    ...overrides,
  };
}

describe("classifyRegime", () => {
  it("detects BREAKOUT when volatility, OI, and volume all spike together", () => {
    const result = classifyRegime(
      baseInput({ volatilitySpikeRatio: 3, oiChangePct: 5, volumeSpikeRatio: 3 }),
    );
    expect(result.regime).toBe("BREAKOUT");
  });

  it("detects ACCUMULATION when CVD buy-dominant, OI rising, price flat", () => {
    const result = classifyRegime(baseInput({ cvdBuyPct: 60, oiChangePct: 3, priceChangePct: 0.2 }));
    expect(result.regime).toBe("ACCUMULATION");
  });

  it("detects DISTRIBUTION when CVD sell-dominant, OI falling, price flat", () => {
    const result = classifyRegime(baseInput({ cvdBuyPct: 40, oiChangePct: -3, priceChangePct: -0.2 }));
    expect(result.regime).toBe("DISTRIBUTION");
  });

  it("detects TRENDING_UP when ADX strong and +DI dominant", () => {
    const result = classifyRegime(baseInput({ adx: 30, plusDI: 25, minusDI: 10 }));
    expect(result.regime).toBe("TRENDING_UP");
  });

  it("detects TRENDING_DOWN when ADX strong and -DI dominant", () => {
    const result = classifyRegime(baseInput({ adx: 30, plusDI: 10, minusDI: 25 }));
    expect(result.regime).toBe("TRENDING_DOWN");
  });

  it("falls back to RANGING when ADX is low and nothing else matches", () => {
    const result = classifyRegime(baseInput({ adx: 10 }));
    expect(result.regime).toBe("RANGING");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("falls back to RANGING with lower confidence in the ADX 20-25 gray zone", () => {
    const result = classifyRegime(baseInput({ adx: 22, plusDI: 20, minusDI: 20 }));
    expect(result.regime).toBe("RANGING");
    expect(result.confidence).toBeLessThanOrEqual(0.3);
  });

  it("prioritizes BREAKOUT over a simultaneously-matching TRENDING pattern", () => {
    const result = classifyRegime(
      baseInput({ adx: 30, plusDI: 25, minusDI: 10, volatilitySpikeRatio: 3, oiChangePct: 5, volumeSpikeRatio: 3 }),
    );
    expect(result.regime).toBe("BREAKOUT");
  });

  it("all confidence scores stay within [0, 1]", () => {
    const scenarios: Partial<RegimeInput>[] = [
      { volatilitySpikeRatio: 10, oiChangePct: 20, volumeSpikeRatio: 10 },
      { cvdBuyPct: 100, oiChangePct: 20, priceChangePct: 0 },
      { cvdBuyPct: 0, oiChangePct: -20, priceChangePct: 0 },
      { adx: 90, plusDI: 80, minusDI: 5 },
      { adx: 0 },
    ];
    for (const overrides of scenarios) {
      const result = classifyRegime(baseInput(overrides));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

vi.mock("../binanceProxyClient.js", () => ({
  getKlinesNative: vi.fn(),
  getOpenInterestNative: vi.fn(),
  getOpenInterestHistNative: vi.fn(),
  getAggTrades: vi.fn(),
}));

type RegimeToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
};
type RegimeToolHandler = (args: { symbol: string; interval: string }) => Promise<RegimeToolResult>;

// Cukup 21 candle biar lolos REGIME_MIN_CANDLES, tapi tool selalu fetch
// REGIME_KLINE_LIMIT (40) -- pakai 40 di sini biar konsisten sama call asli.
function makeKlines(count: number): KlineTuple[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i * 0.1;
    return [
      i * 3_600_000,
      open.toFixed(2),
      (open + 1).toFixed(2),
      (open - 1).toFixed(2),
      (open + 0.5).toFixed(2),
      String(1000 + i),
      i * 3_600_000 + 3_599_999,
      "0",
      10,
      "0",
      "0",
      "0",
    ] as unknown as KlineTuple;
  });
}

// registerMarketRegimeTools() cuma butuh .registerTool dari McpServer --
// fake minimal ini menangkap handler+inputSchema yang didaftarkan
// registerSafeTool, TANPA perlu instance McpServer sungguhan (server.ts
// bikin instance asli via SDK, di luar scope test unit ini).
describe("binance_market_regime tool handler (threading interval param)", () => {
  let handler: RegimeToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(makeKlines(40));
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({
      symbol: "BTCUSDT",
      openInterest: "1000",
      time: 0,
    });
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockResolvedValue([
      { symbol: "BTCUSDT", sumOpenInterest: "900", sumOpenInterestValue: "0", timestamp: 0 },
      { symbol: "BTCUSDT", sumOpenInterest: "950", sumOpenInterestValue: "0", timestamp: 0 },
    ]);
    vi.mocked(binanceProxy.getAggTrades).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        a: i,
        p: "100",
        q: "1",
        f: i,
        l: i,
        T: i,
        m: i % 2 === 0,
      })),
    );

    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as RegimeToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerMarketRegimeTools(fakeServer);
  });

  it("defaults interval to '1h' when not provided -- regression test, matches pre-PR behavior", async () => {
    // z.object(inputSchema).parse(...) meniru resolusi default yang SDK
    // MCP lakukan sebelum panggil handler -- .default("1h") di schema
    // TIDAK otomatis kepakai kalau kita panggil handler() langsung.
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as { symbol: string; interval: string };
    await handler(args);

    expect(binanceProxy.getKlinesNative).toHaveBeenCalledWith("BTCUSDT", "1h", 40);
    expect(binanceProxy.getOpenInterestHistNative).toHaveBeenCalledWith("BTCUSDT", "1h", 2);
  });

  it("threads interval='4h' through to getKlinesNative and getOpenInterestHistNative instead of '1h'", async () => {
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT", interval: "4h" }) as {
      symbol: string;
      interval: string;
    };
    await handler(args);

    expect(binanceProxy.getKlinesNative).toHaveBeenCalledWith("BTCUSDT", "4h", 40);
    expect(binanceProxy.getOpenInterestHistNative).toHaveBeenCalledWith("BTCUSDT", "4h", 2);
    expect(binanceProxy.getKlinesNative).not.toHaveBeenCalledWith("BTCUSDT", "1h", 40);
  });

  it("reflects the requested interval in response header text and structuredContent", async () => {
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT", interval: "4h" }) as {
      symbol: string;
      interval: string;
    };
    const result = await handler(args);

    expect(result.content[0].text).toContain("Regime Pasar — BTCUSDT (4h)");
    expect(result.structuredContent.interval).toBe("4h");
  });
});

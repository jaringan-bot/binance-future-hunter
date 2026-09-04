import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pickBracketForNotional,
  fetchMaintMarginRatio,
  clearLeverageBracketCache,
  type LeverageBracketTier,
} from "./leverageBracket.js";
import * as binanceProxy from "./binanceProxyClient.js";

vi.mock("./binanceProxyClient.js", () => ({
  getLeverageBracket: vi.fn(),
  hasBinanceApiCredentials: vi.fn(() => true),
}));

const sampleTiers: LeverageBracketTier[] = [
  {
    bracket: 1,
    initialLeverage: 125,
    notionalFloor: 0,
    notionalCap: 50_000,
    maintMarginRatio: 0.004,
    cum: 0,
  },
  {
    bracket: 2,
    initialLeverage: 100,
    notionalFloor: 50_000,
    notionalCap: 250_000,
    maintMarginRatio: 0.005,
    cum: 50,
  },
  {
    bracket: 3,
    initialLeverage: 50,
    notionalFloor: 250_000,
    notionalCap: 1_000_000,
    maintMarginRatio: 0.01,
    cum: 1300,
  },
];

describe("pickBracketForNotional", () => {
  it("picks first tier below first cap", () => {
    expect(pickBracketForNotional(sampleTiers, 10_000)?.bracket).toBe(1);
  });

  it("picks next tier at floor boundary", () => {
    expect(pickBracketForNotional(sampleTiers, 50_000)?.bracket).toBe(2);
  });

  it("includes last-tier cap", () => {
    expect(pickBracketForNotional(sampleTiers, 1_000_000)?.bracket).toBe(3);
  });

  it("oversized notional uses last (conservative) tier", () => {
    expect(pickBracketForNotional(sampleTiers, 9_000_000)?.maintMarginRatio).toBe(0.01);
  });

  it("empty / invalid → undefined", () => {
    expect(pickBracketForNotional([], 100)).toBeUndefined();
    expect(pickBracketForNotional(sampleTiers, Number.NaN)).toBeUndefined();
  });
});

describe("fetchMaintMarginRatio", () => {
  beforeEach(() => {
    clearLeverageBracketCache();
    vi.mocked(binanceProxy.getLeverageBracket).mockReset();
  });

  afterEach(() => {
    clearLeverageBracketCache();
  });

  it("returns maintMarginRatio from matching bracket", async () => {
    vi.mocked(binanceProxy.getLeverageBracket).mockResolvedValue([
      { symbol: "BTCUSDT", brackets: sampleTiers },
    ]);
    await expect(fetchMaintMarginRatio("btcusdt", 60_000)).resolves.toBe(0.005);
  });

  it("caches by symbol within TTL", async () => {
    vi.mocked(binanceProxy.getLeverageBracket).mockResolvedValue([
      { symbol: "ETHUSDT", brackets: sampleTiers },
    ]);
    await fetchMaintMarginRatio("ETHUSDT", 1_000);
    await fetchMaintMarginRatio("ETHUSDT", 2_000);
    expect(binanceProxy.getLeverageBracket).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on fetch failure (caller heuristic)", async () => {
    vi.mocked(binanceProxy.getLeverageBracket).mockRejectedValue(new Error("banned"));
    await expect(fetchMaintMarginRatio("BTCUSDT", 1_000)).resolves.toBeUndefined();
  });
});

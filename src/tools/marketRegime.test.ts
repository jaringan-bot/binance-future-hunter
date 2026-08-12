import { describe, it, expect } from "vitest";
import { classifyRegime, type RegimeInput } from "./marketRegime.js";

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

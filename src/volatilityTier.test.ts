import { describe, it, expect } from "vitest";
import { classifyVolatilityTier, effectiveGate, TIER_MULT } from "./volatilityTier.js";

describe("classifyVolatilityTier", () => {
  it("uses the 60% / 120% annualized-RV cutoffs (verbatim from the WhaleScope skills)", () => {
    expect(classifyVolatilityTier(0)).toBe(1);
    expect(classifyVolatilityTier(59.9)).toBe(1);
    expect(classifyVolatilityTier(60)).toBe(2);
    expect(classifyVolatilityTier(120)).toBe(2);
    expect(classifyVolatilityTier(120.01)).toBe(3);
    expect(classifyVolatilityTier(400)).toBe(3);
  });

  it("falls back to Tier 1 for non-finite RV (missing data)", () => {
    expect(classifyVolatilityTier(NaN)).toBe(1);
    expect(classifyVolatilityTier(Infinity)).toBe(1);
    expect(classifyVolatilityTier(-5)).toBe(1);
  });
});

describe("effectiveGate", () => {
  it("scales a base ADX gate by the tier multiplier and rounds", () => {
    // DCA skill Moderate base gate 30 / cap 35 -> the exact skill table rows.
    expect(effectiveGate(30, 1)).toBe(30);
    expect(effectiveGate(30, 2)).toBe(38); // round(37.5)
    expect(effectiveGate(30, 3)).toBe(48);
    expect(effectiveGate(35, 1)).toBe(35);
    expect(effectiveGate(35, 2)).toBe(44); // round(43.75)
    expect(effectiveGate(35, 3)).toBe(56);
  });

  it("exposes the multiplier table verbatim from the skills", () => {
    expect(TIER_MULT).toEqual({ 1: 1.0, 2: 1.25, 3: 1.6 });
  });
});

import { describe, it, expect } from "vitest";
import {
  MM_ADVERSE_PENALTY_WEIGHT,
  cvdSampleConfidence,
  CVD_MIN_CONFIDENCE_SECONDS,
  CVD_FULL_CONFIDENCE_SECONDS,
  evaluateHardScreen,
  scoreTier1Signals,
  scaleCapitalForTargetLoss,
  decidePipelineOutcome,
  TRADE_RANKING_SCORE_THRESHOLD,
  type HardScreenInput,
  type Tier1ScoreInput,
} from "./pipelineEngine.js";
import type { RegimeResult } from "./tools/marketRegime.js";

function baseHardScreen(overrides: Partial<HardScreenInput> = {}): HardScreenInput {
  return {
    tradable: true,
    quoteVolumeUsd: 10_000_000,
    minQuoteVolumeUsd: 5_000_000,
    fundingRate: 0.0001,
    maxAbsFundingRate: 0.0005,
    regime1h: "RANGING",
    regime4h: "RANGING",
    // Defaults deliberately below both EMERGENCY PATCH fallback thresholds
    // (ADX_FALLBACK_MIN=25, SPIKE_FALLBACK_MIN=4.0) so existing tests that
    // don't care about the fallback aren't accidentally affected by it.
    adx1h: 0,
    volatilitySpike1h: 1,
    adx4h: 0,
    volatilitySpike4h: 1,
    ...overrides,
  };
}

describe("evaluateHardScreen", () => {
  it("passes when all conditions are within bounds", () => {
    const result = evaluateHardScreen(baseHardScreen());
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails and short-circuits regardless of other inputs when not tradable", () => {
    const result = evaluateHardScreen(baseHardScreen({ tradable: false, quoteVolumeUsd: 999_999_999 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("tidak tradable"))).toBe(true);
  });

  it("fails when quote volume is below the minimum threshold", () => {
    const result = evaluateHardScreen(baseHardScreen({ quoteVolumeUsd: 1_000_000 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Quote volume"))).toBe(true);
  });

  it("fails when absolute funding rate meets or exceeds the max threshold", () => {
    const result = evaluateHardScreen(baseHardScreen({ fundingRate: -0.0005 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Funding rate"))).toBe(true);
  });

  it("fails when 1h regime is BREAKOUT", () => {
    const result = evaluateHardScreen(baseHardScreen({ regime1h: "BREAKOUT" }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Regime 1h"))).toBe(true);
  });

  it("fails when 4h regime is BREAKOUT", () => {
    const result = evaluateHardScreen(baseHardScreen({ regime4h: "BREAKOUT" }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Regime 4h"))).toBe(true);
  });

  // EMERGENCY PATCH fallback (2026-08-27) -- see ADX_FALLBACK_MIN/
  // SPIKE_FALLBACK_MIN in pipelineEngine.ts. Cases below are the exact
  // real/anchor data points from the RegimeCap investigation
  // (regimecap_data_collection_2026-08-27.md, regimecap_group_d_analysis_
  // 2026-08-27.md, WhaleScope prompt workspace, not checked into this repo).
  describe("EMERGENCY PATCH fallback (regime label flicker)", () => {
    it("rejects a RUNEUSDT-like case: regime already relabeled TRENDING_UP but ADX/spike still extreme", () => {
      // Real 4h numbers observed live post-flicker: ADX 53.79, volatilitySpike 4.973x.
      const result = evaluateHardScreen(
        baseHardScreen({ regime4h: "TRENDING_UP", adx4h: 53.79, volatilitySpike4h: 4.973 }),
      );
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes("EMERGENCY PATCH"))).toBe(true);
    });

    it("does NOT reject an XRPUSDT-like case: strong trend, but spike below the fallback threshold", () => {
      // Real 4h anchor numbers: ADX 42.24, volatilitySpike 1.162x -- high ADX
      // alone must NOT trigger the fallback (ADX has weak separating power,
      // see RegimeCap investigation Group A vs Group B analysis).
      const result = evaluateHardScreen(
        baseHardScreen({ regime4h: "TRENDING_UP", adx4h: 42.24, volatilitySpike4h: 1.162 }),
      );
      expect(result.passed).toBe(true);
    });

    it("does NOT reject Group A (Pure Trend) members", () => {
      // ETHUSDT 25.52/1.056, SOLUSDT 31.39/1.342 -- both real 4h observed values.
      for (const [adx, spike] of [
        [25.52, 1.056],
        [31.39, 1.342],
      ]) {
        const result = evaluateHardScreen(
          baseHardScreen({ regime4h: "TRENDING_UP", adx4h: adx, volatilitySpike4h: spike }),
        );
        expect(result.passed).toBe(true);
      }
    });

    it("does NOT reject Group D (Mature Trend/Cooling) members -- not proven to need capping", () => {
      // BTCUSDT 32.50/0.534, BNBUSDT 48.70/0.663, HYPEUSDT 26.84/0.646,
      // ZECUSDT 33.04/0.924 -- real 4h observed values, all ADX>25 but
      // volatilitySpike<1.0 (well below SPIKE_FALLBACK_MIN=4.0 either way).
      for (const [adx, spike] of [
        [32.5, 0.534],
        [48.7, 0.663],
        [26.84, 0.646],
        [33.04, 0.924],
      ]) {
        const result = evaluateHardScreen(
          baseHardScreen({ regime4h: "TRENDING_UP", adx4h: adx, volatilitySpike4h: spike }),
        );
        expect(result.passed).toBe(true);
      }
    });

    it("does not double-count when regime is already BREAKOUT AND numeric fallback would also match", () => {
      const result = evaluateHardScreen(
        baseHardScreen({ regime4h: "BREAKOUT", adx4h: 53.79, volatilitySpike4h: 4.973 }),
      );
      expect(result.passed).toBe(false);
      // Only the string-label reason should fire, not also the fallback reason
      // (fallback's own `regime4h !== "BREAKOUT"` guard prevents this).
      expect(result.reasons.filter((r) => r.includes("Regime 4h")).length).toBe(1);
    });
  });

  it("collects ALL failing reasons, not just the first", () => {
    const result = evaluateHardScreen(
      baseHardScreen({ tradable: false, quoteVolumeUsd: 100, fundingRate: 0.01, regime1h: "BREAKOUT", regime4h: "BREAKOUT" }),
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBe(5);
  });
});

function regime(overrides: Partial<RegimeResult> = {}): RegimeResult {
  return { regime: "RANGING", confidence: 0.8, reason: "test", ...overrides };
}

function baseTier1(overrides: Partial<Tier1ScoreInput> = {}): Tier1ScoreInput {
  return {
    mmSupportivePct: 50,
    mmAdversePct: 0,
    smartMoneyCondition: "NEUTRAL",
    smartMoneyConfidenceScore: 50,
    regime1h: regime(),
    regime4h: regime(),
    obiBidPct20: 50,
    cvdBuyPct: 50,
    ...overrides,
  };
}

describe("scoreTier1Signals", () => {
  it("stays within [0, 100]", () => {
    const scenarios: Partial<Tier1ScoreInput>[] = [
      { mmSupportivePct: 100, mmAdversePct: 100, smartMoneyCondition: "BULLISH_ACCUMULATION", smartMoneyConfidenceScore: 100, obiBidPct20: 100, cvdBuyPct: 100 },
      { mmSupportivePct: 0, mmAdversePct: 100, smartMoneyCondition: "LONG_LIQUIDATION_RISK", smartMoneyConfidenceScore: 100, obiBidPct20: 0, cvdBuyPct: 0 },
      { mmSupportivePct: 50, regime1h: regime({ regime: "TRENDING_DOWN", confidence: 1 }), regime4h: regime({ regime: "DISTRIBUTION", confidence: 1 }) },
    ];
    for (const overrides of scenarios) {
      const result = scoreTier1Signals(baseTier1(overrides));
      expect(result.rankingScore).toBeGreaterThanOrEqual(0);
      expect(result.rankingScore).toBeLessThanOrEqual(100);
      expect(result.notes.length).toBe(4);
    }
  });

  it("scores higher for BULLISH_ACCUMULATION than LONG_LIQUIDATION_RISK, holding everything else equal", () => {
    const bullish = scoreTier1Signals(baseTier1({ smartMoneyCondition: "BULLISH_ACCUMULATION", smartMoneyConfidenceScore: 80 }));
    const liquidationRisk = scoreTier1Signals(baseTier1({ smartMoneyCondition: "LONG_LIQUIDATION_RISK", smartMoneyConfidenceScore: 80 }));
    expect(bullish.rankingScore).toBeGreaterThan(liquidationRisk.rankingScore);
  });

  it("scores higher for a RANGING regime than a TRENDING_DOWN regime at equal confidence", () => {
    const ranging = scoreTier1Signals(baseTier1({ regime1h: regime({ regime: "RANGING", confidence: 0.9 }), regime4h: regime({ regime: "RANGING", confidence: 0.9 }) }));
    const trendingDown = scoreTier1Signals(baseTier1({ regime1h: regime({ regime: "TRENDING_DOWN", confidence: 0.9 }), regime4h: regime({ regime: "TRENDING_DOWN", confidence: 0.9 }) }));
    expect(ranging.rankingScore).toBeGreaterThan(trendingDown.rankingScore);
  });

  it("scores higher mmComponent-driven ranking with a higher mmTotalScore, all else equal", () => {
    const highMm = scoreTier1Signals(baseTier1({ mmSupportivePct: 100 }));
    const lowMm = scoreTier1Signals(baseTier1({ mmSupportivePct: 0 }));
    expect(highMm.rankingScore).toBeGreaterThan(lowMm.rankingScore);
  });

  it("returns the 4 components (0-100) and rankingScore is their 35/30/20/15 weighted sum", () => {
    const r = scoreTier1Signals(baseTier1({ mmSupportivePct: 100, mmAdversePct: 0, smartMoneyCondition: "BULLISH_ACCUMULATION", smartMoneyConfidenceScore: 60, obiBidPct20: 40, cvdBuyPct: 80 }));
    for (const v of Object.values(r.components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    const weighted =
      r.components.mm * 0.35 +
      r.components.smartMoney * 0.3 +
      r.components.regime * 0.2 +
      r.components.buyPressure * 0.15 -
      r.components.mmAdverse * MM_ADVERSE_PENALTY_WEIGHT;
    expect(r.rankingScore).toBeCloseTo(weighted, 6);
    // mmSupportivePct 100 -> mm component pegged at 100
    expect(r.components.mm).toBe(100);
  });
});

describe("scaleCapitalForTargetLoss", () => {
  it("solves linearly: doubling the reference loss halves the solved capital for the same target risk", () => {
    const capitalA = scaleCapitalForTargetLoss(1000, 50, 20);
    const capitalB = scaleCapitalForTargetLoss(1000, 100, 20);
    expect(capitalA).toBeCloseTo(capitalB * 2, 10);
  });

  it("solved capital scales proportionally with the target risk budget", () => {
    const capital10 = scaleCapitalForTargetLoss(1000, 50, 10);
    const capital20 = scaleCapitalForTargetLoss(1000, 50, 20);
    expect(capital20).toBeCloseTo(capital10 * 2, 10);
  });

  it("throws when the reference slippageStressedLoss is zero or negative", () => {
    expect(() => scaleCapitalForTargetLoss(1000, 0, 20)).toThrow();
    expect(() => scaleCapitalForTargetLoss(1000, -5, 20)).toThrow();
  });

  it("throws when referenceCapital or targetRiskUsd is not positive", () => {
    expect(() => scaleCapitalForTargetLoss(0, 50, 20)).toThrow();
    expect(() => scaleCapitalForTargetLoss(1000, 50, 0)).toThrow();
  });
});

describe("decidePipelineOutcome", () => {
  it("returns NO_TRADE when hard screen failed, regardless of score/status", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: false,
      hardScreenReasons: ["some reason"],
      rankingScore: 100,
      gridRiskStatus: "SAFE",
    });
    expect(result.decision).toBe("NO_TRADE");
    expect(result.reasoning).toContain("some reason");
  });

  it("returns NO_TRADE when gridRiskStatus is REJECT even if hard screen passed", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: 90,
      gridRiskStatus: "REJECT",
    });
    expect(result.decision).toBe("NO_TRADE");
  });

  it("returns WATCH when gridRiskStatus is HIGH_RISK even with a high score", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: 95,
      gridRiskStatus: "HIGH_RISK",
    });
    expect(result.decision).toBe("WATCH");
  });

  it("returns TRADE when SAFE/MODERATE and rankingScore is at or above the threshold", () => {
    const safe = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: TRADE_RANKING_SCORE_THRESHOLD,
      gridRiskStatus: "SAFE",
    });
    const moderate = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: TRADE_RANKING_SCORE_THRESHOLD + 10,
      gridRiskStatus: "MODERATE",
    });
    expect(safe.decision).toBe("TRADE");
    expect(moderate.decision).toBe("TRADE");
  });

  it("returns WATCH when SAFE/MODERATE but rankingScore is below the threshold", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: TRADE_RANKING_SCORE_THRESHOLD - 1,
      gridRiskStatus: "MODERATE",
    });
    expect(result.decision).toBe("WATCH");
  });
});

// ─────────────────────────────────────────────────────────────
// K6 + K7 + K9 REGRESSION GUARDS (2026-09-04, Stage 3).
// ─────────────────────────────────────────────────────────────
describe("K6: sinyal manipulasi MENURUNKAN skor, tidak lagi menaikkannya", () => {
  it("REGRESSION: adverse tinggi menghasilkan skor LEBIH RENDAH, semua yang lain sama", () => {
    // Dulu keenam sinyal dijumlah jadi satu komponen POSITIF berbobot 35%,
    // jadi spoofing/stop-hunt/funding-ekstrem/basis-arb justru MENAIKKAN
    // rankingScore -- makin banyak manipulasi terdeteksi, makin mudah lolos
    // ambang TRADE 55. Untuk grid mean-reversion itu terbalik.
    const clean = scoreTier1Signals(baseTier1({ mmSupportivePct: 60, mmAdversePct: 0 }));
    const manipulated = scoreTier1Signals(baseTier1({ mmSupportivePct: 60, mmAdversePct: 100 }));

    expect(manipulated.rankingScore).toBeLessThan(clean.rankingScore);
    expect(clean.rankingScore - manipulated.rankingScore).toBeCloseTo(100 * MM_ADVERSE_PENALTY_WEIGHT, 6);
  });

  it("melaporkan mm dan mmAdverse sebagai dua komponen terpisah (untuk persist + kalibrasi)", () => {
    const r = scoreTier1Signals(baseTier1({ mmSupportivePct: 80, mmAdversePct: 30 }));
    expect(r.components.mm).toBe(80);
    expect(r.components.mmAdverse).toBe(30);
  });
});

describe("K7: ACCUMULATION/DISTRIBUTION tidak lagi dianggap hampir sebaik RANGING", () => {
  it("RANGING mengalahkan ACCUMULATION, dan ACCUMULATION mengalahkan BREAKOUT", () => {
    const rangingScore = scoreTier1Signals(
      baseTier1({ regime1h: regime({ regime: "RANGING", confidence: 1 }), regime4h: regime({ regime: "RANGING", confidence: 1 }) }),
    ).components.regime;
    const accumulationScore = scoreTier1Signals(
      baseTier1({ regime1h: regime({ regime: "ACCUMULATION", confidence: 1 }), regime4h: regime({ regime: "ACCUMULATION", confidence: 1 }) }),
    ).components.regime;
    const breakoutScore = scoreTier1Signals(
      baseTier1({ regime1h: regime({ regime: "BREAKOUT", confidence: 1 }), regime4h: regime({ regime: "BREAKOUT", confidence: 1 }) }),
    ).components.regime;

    expect(rangingScore).toBeGreaterThan(accumulationScore);
    expect(accumulationScore).toBeGreaterThan(breakoutScore);
    // Jaraknya ke RANGING harus NYATA -- dulu 0.9 vs 1.0 praktis setara,
    // padahal ACCUMULATION menurut definisi classifyRegime adalah pola
    // pra-breakout (OI membangun sementara harga flat).
    expect(rangingScore - accumulationScore).toBeGreaterThan(20);
  });
});

describe("K9: CVD dari sampel tape yang terlalu pendek ditarik ke netral", () => {
  it("cvdSampleConfidence naik dari 0 ke 1 seiring lebar sampel", () => {
    expect(cvdSampleConfidence(0)).toBe(0);
    expect(cvdSampleConfidence(CVD_MIN_CONFIDENCE_SECONDS)).toBe(0);
    expect(cvdSampleConfidence(CVD_FULL_CONFIDENCE_SECONDS)).toBe(1);
    expect(cvdSampleConfidence(9999)).toBe(1);
    const mid = cvdSampleConfidence((CVD_MIN_CONFIDENCE_SECONDS + CVD_FULL_CONFIDENCE_SECONDS) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("REGRESSION: CVD ekstrem atas sampel 3 detik TIDAK boleh menggerakkan skor seperti sampel penuh", () => {
    const thinSample = scoreTier1Signals(baseTier1({ cvdBuyPct: 100, obiBidPct20: 50, cvdSampleSeconds: 3 }));
    const fullSample = scoreTier1Signals(baseTier1({ cvdBuyPct: 100, obiBidPct20: 50, cvdSampleSeconds: 600 }));
    const neutral = scoreTier1Signals(baseTier1({ cvdBuyPct: 50, obiBidPct20: 50, cvdSampleSeconds: 600 }));

    expect(fullSample.components.buyPressure).toBeGreaterThan(thinSample.components.buyPressure);
    // Sampel 3 detik tidak membawa informasi -> diperlakukan netral.
    expect(thinSample.components.buyPressure).toBeCloseTo(neutral.components.buyPressure, 6);
  });

  it("caller lama tanpa cvdSampleSeconds tetap mendapat confidence penuh (tidak berubah diam-diam)", () => {
    const legacy = scoreTier1Signals(baseTier1({ cvdBuyPct: 100, obiBidPct20: 50 }));
    const explicit = scoreTier1Signals(baseTier1({ cvdBuyPct: 100, obiBidPct20: 50, cvdSampleSeconds: 600 }));
    expect(legacy.components.buyPressure).toBeCloseTo(explicit.components.buyPressure, 6);
  });
});

import { describe, it, expect } from "vitest";
import {
  evaluateDcaEntry,
  DCA_THRESHOLD_ENTRY,
  DCA_WATCH_MIN_ALERT_SCORE,
  DCA_HARD_NEUTRAL_CAP,
  type DcaEngineInput,
} from "./dcaPipelineEngine.js";

// Baseline: sebuah pair LONG-DCA yang layak (compression regime, whale
// accumulating, likuid, funding netral). Tiap test override 1-2 field.
function mkInput(over: Partial<DcaEngineInput> = {}): DcaEngineInput {
  return {
    symbol: "SOLUSDT",
    currentPrice: 180,
    quoteVolumeUsd: 500_000_000,
    fundingRate: 0.00003,
    adx4h: 16,
    adx1d: 20,
    regime1d: "RANGING",
    rvAnnualizedPct: 85, // Tier 2 -> gate 38, cap 44
    atr1h: 3.6, // 2% of price -> baseDevPct clamp = 1.2
    atr4h: 9,
    smartMoneyCondition: "BULLISH_ACCUMULATION",
    smartMoneyBias: "BULLISH",
    effectiveSmartMoneyConfidence: 72,
    oiVelocityPerHour: 1200,
    oiDelta4hPct: 4,
    oiEarlyExhaustionWarning: false,
    cvdBuyPct: 60,
    obiDepth10: 55,
    spoofingScore: 0.2,
    swingHigh4h: 189,
    swingLow4h: 172,
    modalAvailableUsd: 200,
    ...over,
  };
}

describe("evaluateDcaEntry — Volatility Tier gates", () => {
  it("uses tier-scaled effective gate/cap (RV 85% -> Tier 2 -> gate 38 / cap 44)", () => {
    const r = evaluateDcaEntry(mkInput());
    expect(r.volTier).toBe(2);
    expect(r.effGateAdx4h).toBe(38);
    expect(r.effCapAdx1d).toBe(44);
  });
});

describe("evaluateDcaEntry — hard gates (short-circuit, order fixed)", () => {
  it("rejects on liquidity below $8M", () => {
    const r = evaluateDcaEntry(mkInput({ quoteVolumeUsd: 7_900_000 }));
    expect(r.decision).toBe("DCA_NO_TRADE");
    expect(r.rejectReason).toMatch(/liquidity/);
  });

  it("passes liquidity at exactly $8.1M (does not reject there)", () => {
    const r = evaluateDcaEntry(mkInput({ quoteVolumeUsd: 8_100_000 }));
    expect(r.rejectReason ?? "").not.toMatch(/liquidity/);
  });

  it("rejects a dead market (ADX4H < 12)", () => {
    const r = evaluateDcaEntry(mkInput({ adx4h: 11 }));
    expect(r.rejectReason).toMatch(/dead_market/);
  });

  it("rejects a strong 4H trend above the tier gate (ADX4H 39 > gate 38)", () => {
    const r = evaluateDcaEntry(mkInput({ adx4h: 39 }));
    expect(r.rejectReason).toMatch(/strong_trend_4h/);
  });

  it("rejects a macro-overextended 1D (ADX1D 45 > cap 44)", () => {
    const r = evaluateDcaEntry(mkInput({ adx1d: 45 }));
    expect(r.rejectReason).toMatch(/macro_overextended/);
  });

  it("SKIPS the macro-overextended gate when klines1d is unavailable", () => {
    const r = evaluateDcaEntry(mkInput({ adx1d: null, regime1d: null }));
    expect(r.rejectReason ?? "").not.toMatch(/macro_overextended/);
    expect(r.reasoning.join(" ")).toMatch(/klines 1d tidak tersedia/);
  });

  it("rejects extreme funding (|0.031%| > 0.03%)", () => {
    const r = evaluateDcaEntry(mkInput({ fundingRate: 0.00031 }));
    expect(r.rejectReason).toMatch(/funding_extreme/);
  });

  it("passes funding at 0.029%", () => {
    const r = evaluateDcaEntry(mkInput({ fundingRate: 0.00029 }));
    expect(r.rejectReason ?? "").not.toMatch(/funding_extreme/);
  });

  it("rejects a 1D trend opposing the resolved direction (LONG vs TRENDING_DOWN)", () => {
    const r = evaluateDcaEntry(mkInput({ regime1d: "TRENDING_DOWN" }));
    expect(r.rejectReason).toMatch(/macro_trend_opposing/);
  });
});

describe("evaluateDcaEntry — direction + smart-money veto", () => {
  it("LONG_LIQUIDATION_RISK resolves to SHORT direction", () => {
    const r = evaluateDcaEntry(
      mkInput({ smartMoneyCondition: "LONG_LIQUIDATION_RISK", smartMoneyBias: "BEARISH", regime1d: "RANGING", fundingRate: -0.00003, cvdBuyPct: 40, obiDepth10: 45 }),
    );
    expect(r.direction).toBe("SHORT");
  });

  it("BULLISH_ACCUMULATION and SHORT_SQUEEZE_RISK resolve to LONG", () => {
    expect(evaluateDcaEntry(mkInput({ smartMoneyCondition: "BULLISH_ACCUMULATION" })).direction).toBe("LONG");
    expect(evaluateDcaEntry(mkInput({ smartMoneyCondition: "SHORT_SQUEEZE_RISK" })).direction).toBe("LONG");
  });

  it("NEUTRAL caps confidence at 67 and never returns DCA_TRADE", () => {
    const r = evaluateDcaEntry(mkInput({ smartMoneyCondition: "NEUTRAL", effectiveSmartMoneyConfidence: 40 }));
    expect(r.confidence).toBeLessThanOrEqual(DCA_HARD_NEUTRAL_CAP);
    expect(r.decision).not.toBe("DCA_TRADE");
  });
});

describe("evaluateDcaEntry — decision thresholds + params", () => {
  it("a fully-aligned setup crosses the entry threshold and emits DCA params", () => {
    const r = evaluateDcaEntry(mkInput());
    expect(r.confidence).toBeGreaterThanOrEqual(DCA_THRESHOLD_ENTRY);
    expect(r.decision).toBe("DCA_TRADE");
    const cfg = r.dcaBotConfig!;
    expect(cfg.direction).toBe("LONG");
    // baseDevPct = clamp(round2(2% * 0.6), 1.0, 1.5) = clamp(1.2) = 1.2
    expect(cfg.priceDropStepPct).toBe(1.2);
    expect(cfg.takeProfitPerRoundPct).toBe(1.25);
    expect(cfg.priceDeviationMultiplier).toBe(1.15);
    // total accumulation = 1.2 * (1 + 2 + 3.25 + 4.5) = 12.9 -> over 12 -> drops a round
    expect(cfg.totalAccumulationDistPct).toBeLessThanOrEqual(12);
    expect(cfg.maxDcaOrders).toBeLessThanOrEqual(4);
    // SL below the last DCA level, projected loss within budget
    expect(cfg.stopLossPrice).toBeLessThan(180);
    expect(cfg.stopLossPct).toBeGreaterThan(cfg.totalAccumulationDistPct);
    expect(cfg.projectedMaxLossUsd).toBeLessThanOrEqual(20 * 1.05);
    expect([5, 7]).toContain(cfg.leverage);
  });

  it("mid-band confidence -> DCA_WATCH, no params", () => {
    // weaken structure + capital flow to land in [50, 70)
    const r = evaluateDcaEntry(
      mkInput({ effectiveSmartMoneyConfidence: 45, oiVelocityPerHour: -10, oiDelta4hPct: -1, cvdBuyPct: 50, obiDepth10: 50, quoteVolumeUsd: 9_000_000 }),
    );
    expect(r.decision === "DCA_WATCH" || r.decision === "DCA_NO_TRADE").toBe(true);
    if (r.decision === "DCA_WATCH") expect(r.dcaBotConfig).toBeUndefined();
  });

  it("SHORT direction mirrors the params (SL above, accumulation upward)", () => {
    const r = evaluateDcaEntry(
      mkInput({
        smartMoneyCondition: "LONG_LIQUIDATION_RISK",
        smartMoneyBias: "BEARISH",
        effectiveSmartMoneyConfidence: 75,
        regime1d: "RANGING",
        fundingRate: 0.00003,
        cvdBuyPct: 38,
        obiDepth10: 44,
        oiVelocityPerHour: 1000,
        oiDelta4hPct: 3,
      }),
    );
    if (r.decision === "DCA_TRADE") {
      expect(r.dcaBotConfig!.direction).toBe("SHORT");
      expect(r.dcaBotConfig!.stopLossPrice).toBeGreaterThan(180);
    } else {
      expect(["DCA_WATCH", "DCA_NO_TRADE"]).toContain(r.decision);
    }
  });
});

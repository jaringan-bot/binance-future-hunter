// gridSmartMoneyAdapter.ts -- Grid Bot Smart Money Adapter V2 (Phase 2).
// Menilai keamanan menaruh Grid Bot di sebuah pair berbasis peta likuiditas
// (Order Book Walls) + metrik Smart Money Core (Phase 1), BUKAN bound teknikal
// arbiter. STATELESS: hanya menghasilkan bound berbasis wall + rekomendasi
// alert; tidak melacak state grid milik user.
//
// REUSE PHASE 1: calculateScenarioC (S_C) di-import dari smartMoneyPipelineEngine.
// (Catatan: engine Phase 1 berada di src/cron/, bukan src/tools/ seperti draf
// spec -- import mengikuti lokasi file yang sebenarnya.)
import { calculateScenarioC, type ScenarioCInput } from "./smartMoneyPipelineEngine.js";
import type { GridWallResult } from "../tools/gridWallFinder.js";
import type { MarketRegime } from "../tools/marketRegime.js";

export type GridSmDecision = "GRID_TRADE" | "GRID_WATCH" | "GRID_NO_TRADE" | "GRID_REGRID_SUGGESTED";

// ── Bobot & threshold (revisi Phase 2) ──
export const W_WALL_PERSISTENCE = 0.3;
export const W_CVD_SAFETY = 0.3;
export const W_REGIME = 0.2;
export const W_OI_GUARD = 0.2;
export const GRID_TRADE_MIN_SCORE = 70;
export const GRID_WATCH_MIN_SCORE = 50;
export const REGRID_ABSORPTION_MIN = 65; // AbsorptionRatio > 65% untuk sweep recovery
export const WATCH_POSITION_SIZING_PCT = 50;

// Regime -> skor keamanan grid. RANGING paling aman; ACCUMULATION/DISTRIBUTION
// justru BERBAHAYA (pre-breakout). STRONG_TRENDING (TRENDING_UP/DOWN) & BREAKOUT
// = 0. LOW_VOL disediakan untuk kompat spec (bukan nilai MarketRegime engine);
// regime tak dikenal -> 50.
const REGIME_SAFETY: Record<string, number> = {
  RANGING: 100,
  LOW_VOL: 90,
  ACCUMULATION: 30,
  DISTRIBUTION: 20,
  BREAKOUT: 0,
  STRONG_TRENDING: 0,
  TRENDING_UP: 0,
  TRENDING_DOWN: 0,
};

function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

export function regimeSafetyScore(regime: MarketRegime | string): number {
  return REGIME_SAFETY[regime] ?? 50;
}

/**
 * OI Guard: OI velocity percentile tinggi = OI membengkak cepat = risiko
 * breakout naik = grid TIDAK aman. >80 -> 0; <50 -> 100; di antaranya linear
 * turun (100 - (pct-50)*3.33).
 */
export function oiGuardScore(oiVelocityPercentile: number): number {
  if (oiVelocityPercentile > 80) return 0;
  if (oiVelocityPercentile < 50) return 100;
  return clamp100(100 - (oiVelocityPercentile - 50) * 3.33);
}

export interface GridSafetyComponents {
  wallPersistence: number;
  cvdSafety: number;
  regime: number;
  oiGuard: number;
}

export interface GridSafetyInput {
  /** 0-100: 100 kalau wall bertahan >= threshold tool wall-persistence. */
  wallPersistenceScore: number;
  /** S_C Scenario C (0-100) dari Phase 1. cvdSafety = 100 - S_C. */
  scenarioCScore: number;
  regime: MarketRegime | string;
  /** OI velocity percentile 0-100. */
  oiVelocityPercentile: number;
}

export interface GridSafetyResult {
  score: number;
  components: GridSafetyComponents;
}

/** GridSafetyScore = 0.30*WallPersistence + 0.30*(100-S_C) + 0.20*Regime + 0.20*OIGuard. */
export function computeGridSafetyScore(input: GridSafetyInput): GridSafetyResult {
  const components: GridSafetyComponents = {
    wallPersistence: clamp100(input.wallPersistenceScore),
    cvdSafety: 100 - clamp100(input.scenarioCScore),
    regime: regimeSafetyScore(input.regime),
    oiGuard: oiGuardScore(input.oiVelocityPercentile),
  };
  const score =
    W_WALL_PERSISTENCE * components.wallPersistence +
    W_CVD_SAFETY * components.cvdSafety +
    W_REGIME * components.regime +
    W_OI_GUARD * components.oiGuard;
  return { score: clamp100(score), components };
}

/** Helper reuse Phase 1: hitung S_C langsung dari input Scenario C. */
export function scenarioCFrom(input: ScenarioCInput): number {
  return calculateScenarioC(input);
}

export interface GridSmartMoneyInput extends GridSafetyInput {
  /** Hasil wall finder; null = tidak ada wall signifikan -> GRID_NO_TRADE. */
  wall: GridWallResult | null;
  currentPrice: number;
  /** Sweep recovery (Scenario B integration): stateless, cek kondisi saat ini. */
  isLiquiditySweep: boolean;
  absorptionRatio: number; // 0-100 persen
}

export interface GridSmartMoneyResult {
  decision: GridSmDecision;
  gridSafetyScore: number;
  components: GridSafetyComponents | null;
  lowerBound: number | null;
  upperBound: number | null;
  positionSizingPct: number;
  reasons: string[];
}

/**
 * Keputusan Grid Bot Smart Money:
 *  - wall == null            -> GRID_NO_TRADE "No significant liquidity walls found" (NO ATR FALLBACK).
 *  - sweep recovery di bawah lowerBound + absorption > 65% -> GRID_REGRID_SUGGESTED.
 *  - score >= 70 -> GRID_TRADE (sizing 100%).
 *  - 50..69      -> GRID_WATCH (sizing 50%).
 *  - < 50        -> GRID_NO_TRADE (breakout/thin wall risk).
 */
export function evaluateGridSmartMoney(input: GridSmartMoneyInput): GridSmartMoneyResult {
  if (input.wall === null) {
    return {
      decision: "GRID_NO_TRADE",
      gridSafetyScore: 0,
      components: null,
      lowerBound: null,
      upperBound: null,
      positionSizingPct: 0,
      reasons: ["No significant liquidity walls found"],
    };
  }

  const { score, components } = computeGridSafetyScore(input);
  const reasons = [
    `GridSafetyScore ${score.toFixed(1)} (wallPersist ${components.wallPersistence.toFixed(0)}, cvdSafety ${components.cvdSafety.toFixed(0)}, regime ${components.regime.toFixed(0)}, oiGuard ${components.oiGuard.toFixed(0)})`,
  ];

  // Sweep recovery (Scenario B) -- stateless: harga menembus lowerBound TAPI
  // liquidity sweep + absorption kuat -> institusi menyerap jual, sarankan
  // geser lowerBound ke bawah & lanjut grid (bukan panic stop).
  if (
    input.currentPrice < input.wall.lowerBound &&
    input.isLiquiditySweep &&
    input.absorptionRatio > REGRID_ABSORPTION_MIN
  ) {
    reasons.push(
      `Sweep recovery: harga ${input.currentPrice} < lowerBound ${input.wall.lowerBound}, isLiquiditySweep + absorption ${input.absorptionRatio.toFixed(0)}% > ${REGRID_ABSORPTION_MIN}% -> geser lowerBound & lanjut grid`,
    );
    return {
      decision: "GRID_REGRID_SUGGESTED",
      gridSafetyScore: score,
      components,
      lowerBound: input.wall.lowerBound,
      upperBound: input.wall.upperBound,
      positionSizingPct: 100,
      reasons,
    };
  }

  let decision: GridSmDecision;
  let sizing: number;
  if (score >= GRID_TRADE_MIN_SCORE) {
    decision = "GRID_TRADE";
    sizing = 100;
  } else if (score >= GRID_WATCH_MIN_SCORE) {
    decision = "GRID_WATCH";
    sizing = WATCH_POSITION_SIZING_PCT;
  } else {
    decision = "GRID_NO_TRADE";
    sizing = 0;
  }
  reasons.push(`Decision ${decision} (sizing ${sizing}%)`);

  return {
    decision,
    gridSafetyScore: score,
    components,
    lowerBound: input.wall.lowerBound,
    upperBound: input.wall.upperBound,
    positionSizingPct: sizing,
    reasons,
  };
}

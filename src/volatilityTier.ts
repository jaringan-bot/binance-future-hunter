// Volatility Tier -- helper bersama untuk skill WhaleScope Grid/DCA
// (Screening & Entry). Meng-normalisasi threshold interpretasi ADX ke
// volatilitas alami aset: alt high-beta wajar tembus ADX tinggi cuma dari
// volatilitasnya sendiri, bukan berarti trend makro sudah matang.
//
// Cutoff 60% / 120% (RV 1h annualized) dan multiplier 1.0 / 1.25 / 1.6
// diambil VERBATIM dari keempat SKILL.md (grid-screening, grid-entry,
// dca-screening, dca-entry). Framework Note dari skill: "Tier cutoffs and
// ADX multipliers are static framework heuristics, not empirically fitted
// percentiles" -- ditinjau ulang saat regime pasar ekstrem.
//
// Floor Dead-Market (mis. grid ADX4H<15, DCA ADX4H<12) TIDAK di-scale --
// caller yang menerapkannya flat. Helper ini cuma Gate/Cap.
//
// PEMAKAIAN saat ini: dcaPipelineEngine.ts. Grid engine (pipelineEngine.ts)
// BELUM mengadopsi tiering (masih pakai gate flat BREAKOUT + ADX_FALLBACK_MIN
// 25 / SPIKE_FALLBACK_MIN 4.0) -- adopsi grid = perubahan terpisah,
// lihat "deferred: grid volatility tiering" di docs/full_pipeline_framework.md.

export type VolatilityTier = 1 | 2 | 3;

export const TIER_MULT: Record<VolatilityTier, number> = { 1: 1.0, 2: 1.25, 3: 1.6 };

/**
 * RV 1h annualized (%) -> Tier. Non-finite / negatif -> Tier 1 (data hilang,
 * jangan naikkan gate berdasarkan angka yang tidak valid).
 */
export function classifyVolatilityTier(rvAnnualizedPct: number): VolatilityTier {
  if (!Number.isFinite(rvAnnualizedPct) || rvAnnualizedPct < 60) return 1;
  if (rvAnnualizedPct <= 120) return 2;
  return 3;
}

/** Effective Gate/Cap = round(base * multiplier tier). */
export function effectiveGate(base: number, tier: VolatilityTier): number {
  return Math.round(base * TIER_MULT[tier]);
}

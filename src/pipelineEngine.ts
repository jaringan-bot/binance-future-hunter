import type { MarketRegime } from "./tools/marketRegime.js";
import type { MarketStructureCondition } from "./smartMoneyAnalysis.js";

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export interface HardScreenInput {
  tradable: boolean;
  quoteVolumeUsd: number;
  minQuoteVolumeUsd: number;
  fundingRate: number;
  maxAbsFundingRate: number;
  regime1h: MarketRegime;
  regime4h: MarketRegime;
}

export interface HardScreenResult {
  passed: boolean;
  reasons: string[];
}

export function evaluateHardScreen(input: HardScreenInput): HardScreenResult {
  const reasons: string[] = [];
  if (!input.tradable) {
    reasons.push("Symbol tidak tradable (ticker24hr gagal diambil, atau harga/volume tidak valid).");
  }
  if (input.quoteVolumeUsd < input.minQuoteVolumeUsd) {
    reasons.push(
      `Quote volume 24h ($${input.quoteVolumeUsd.toLocaleString("en-US")}) di bawah ambang minimum ($${input.minQuoteVolumeUsd.toLocaleString("en-US")}).`,
    );
  }
  if (Math.abs(input.fundingRate) >= input.maxAbsFundingRate) {
    reasons.push(
      `|Funding rate| (${(Math.abs(input.fundingRate) * 100).toFixed(4)}%) >= ambang maksimum (${(input.maxAbsFundingRate * 100).toFixed(4)}%).`,
    );
  }
  if (input.regime1h === "BREAKOUT") {
    reasons.push("Regime 1h terdeteksi BREAKOUT -- grid bot tidak cocok untuk kondisi breakout.");
  }
  if (input.regime4h === "BREAKOUT") {
    reasons.push("Regime 4h terdeteksi BREAKOUT -- grid bot tidak cocok untuk kondisi breakout.");
  }
  return { passed: reasons.length === 0, reasons };
}

const REGIME_FAVORABILITY: Record<MarketRegime, number> = {
  RANGING: 1,
  ACCUMULATION: 0.9,
  DISTRIBUTION: 0.7,
  TRENDING_UP: 0.5,
  TRENDING_DOWN: 0.4,
  BREAKOUT: 0,
};

export interface Tier1ScoreInput {
  mmTotalScore: number;
  smartMoneyCondition: MarketStructureCondition;
  smartMoneyConfidenceScore: number;
  regime1h: { regime: MarketRegime; confidence: number };
  regime4h: { regime: MarketRegime; confidence: number };
  obiBidPct20: number;
  cvdBuyPct: number;
}

export interface Tier1ScoreResult {
  rankingScore: number;
  notes: string[];
}

export function scoreTier1Signals(input: Tier1ScoreInput): Tier1ScoreResult {
  const notes: string[] = [];
  const mmComponent = clampPct((input.mmTotalScore / 6) * 100);
  notes.push(`Skor MM composite ${input.mmTotalScore.toFixed(2)}/6 -> komponen ${mmComponent.toFixed(1)}/100 (bobot 35%).`);

  let smartMoneyDirectional: number;
  switch (input.smartMoneyCondition) {
    case "BULLISH_ACCUMULATION":
      smartMoneyDirectional = input.smartMoneyConfidenceScore;
      break;
    case "LONG_LIQUIDATION_RISK":
      smartMoneyDirectional = -input.smartMoneyConfidenceScore;
      break;
    case "SHORT_SQUEEZE_RISK":
      smartMoneyDirectional = input.smartMoneyConfidenceScore * 0.5;
      break;
    default:
      smartMoneyDirectional = 0;
  }
  const smartMoneyComponent = clampPct((smartMoneyDirectional + 100) / 2);
  notes.push(
    `Kondisi smart money ${input.smartMoneyCondition} (confidence ${input.smartMoneyConfidenceScore}) -> komponen ${smartMoneyComponent.toFixed(1)}/100 (bobot 30%).`,
  );

  const regime1hScore = REGIME_FAVORABILITY[input.regime1h.regime] * input.regime1h.confidence * 100;
  const regime4hScore = REGIME_FAVORABILITY[input.regime4h.regime] * input.regime4h.confidence * 100;
  const regimeComponent = clampPct((regime1hScore + regime4hScore) / 2);
  notes.push(
    `Regime 1h=${input.regime1h.regime}(${(input.regime1h.confidence * 100).toFixed(0)}%), 4h=${input.regime4h.regime}(${(input.regime4h.confidence * 100).toFixed(0)}%) -> komponen ${regimeComponent.toFixed(1)}/100 (bobot 20%).`,
  );

  const buyPressureComponent = clampPct((input.obiBidPct20 + input.cvdBuyPct) / 2);
  notes.push(
    `Tekanan beli (OBI depth-20 ${input.obiBidPct20.toFixed(1)}%, CVD buy ${input.cvdBuyPct.toFixed(1)}%) -> komponen ${buyPressureComponent.toFixed(1)}/100 (bobot 15%).`,
  );

  const rankingScore =
    mmComponent * 0.35 + smartMoneyComponent * 0.3 + regimeComponent * 0.2 + buyPressureComponent * 0.15;
  return { rankingScore: clampPct(rankingScore), notes };
}

export function scaleCapitalForTargetLoss(
  referenceCapital: number,
  referenceSlippageStressedLoss: number,
  targetRiskUsd: number,
): number {
  if (!Number.isFinite(referenceSlippageStressedLoss) || referenceSlippageStressedLoss <= 0) {
    throw new Error(
      "Tidak bisa menyelesaikan capital solve: slippageStressedLoss run referensi <= 0 (run referensi REJECT atau degenerate).",
    );
  }
  if (
    !Number.isFinite(referenceCapital) ||
    referenceCapital <= 0 ||
    !Number.isFinite(targetRiskUsd) ||
    targetRiskUsd <= 0
  ) {
    throw new Error("Tidak bisa menyelesaikan capital solve: referenceCapital dan targetRiskUsd harus > 0.");
  }
  return (targetRiskUsd / referenceSlippageStressedLoss) * referenceCapital;
}

const TRADE_RANKING_SCORE_THRESHOLD = 55;

export type PipelineDecision = "TRADE" | "WATCH" | "NO_TRADE";

export interface DecidePipelineOutcomeInput {
  hardScreenPassed: boolean;
  hardScreenReasons: string[];
  rankingScore: number;
  gridRiskStatus: "SAFE" | "MODERATE" | "HIGH_RISK" | "REJECT";
}

export interface PipelineOutcome {
  decision: PipelineDecision;
  reasoning: string[];
}

export function decidePipelineOutcome(input: DecidePipelineOutcomeInput): PipelineOutcome {
  const reasoning: string[] = [];
  if (!input.hardScreenPassed) {
    reasoning.push(...input.hardScreenReasons);
    return { decision: "NO_TRADE", reasoning };
  }
  if (input.gridRiskStatus === "REJECT") {
    reasoning.push(
      "Semua opsi leverage yang dievaluasi ditolak grid risk engine (status REJECT) -- setup tidak layak dijalankan saat ini.",
    );
    return { decision: "NO_TRADE", reasoning };
  }
  if (input.gridRiskStatus === "HIGH_RISK") {
    reasoning.push(
      `Grid risk berstatus HIGH_RISK pada leverage terpilih (skor Tier-1 ${input.rankingScore.toFixed(1)}/100) -- disarankan WATCH dulu, bukan langsung eksekusi.`,
    );
    return { decision: "WATCH", reasoning };
  }
  if (input.rankingScore >= TRADE_RANKING_SCORE_THRESHOLD) {
    reasoning.push(
      `Hard screen lolos, grid risk ${input.gridRiskStatus}, skor Tier-1 ${input.rankingScore.toFixed(1)}/100 (>= ambang ${TRADE_RANKING_SCORE_THRESHOLD}) -- kandidat TRADE.`,
    );
    return { decision: "TRADE", reasoning };
  }
  reasoning.push(
    `Hard screen lolos, grid risk ${input.gridRiskStatus}, tapi skor Tier-1 ${input.rankingScore.toFixed(1)}/100 di bawah ambang ${TRADE_RANKING_SCORE_THRESHOLD} -- WATCH, bukan TRADE langsung.`,
  );
  return { decision: "WATCH", reasoning };
}

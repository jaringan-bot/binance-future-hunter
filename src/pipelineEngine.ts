// pipelineEngine.ts -- logika murni screening/scoring/decision buat
// whalescope_full_pipeline (src/tools/fullPipeline.ts). Semua fungsi di sini
// TIDAK melakukan fetch apapun -- input murni objek/angka yang sudah dihitung
// tool wrapper dari data Wave 1/Wave 2, output murni juga. Dipisah dari
// fullPipeline.ts supaya bisa di-unit-test tanpa mock binanceProxyClient.js
// sama sekali (pola pure-engine + thin-wrapper yang sama seperti
// smartMoneyAnalysis.ts + smartMoney.ts).
import type { MarketRegime, RegimeResult } from "./tools/marketRegime.js";
import type { MarketStructureCondition } from "./smartMoneyAnalysis.js";
import type { GridRiskAnalysisResult } from "./gridRiskEngine.js";

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

// ─────────────────────────────────────────────────────────────
// HARD SCREEN -- gerbang Wave 1. Simbol yang gagal di sini LANGSUNG
// short-circuit ke NO_TRADE tanpa Wave 2 sama sekali (fullPipeline.ts) --
// inilah yang bikin "reject early" di desain 2-wave pipeline benar-benar
// menghemat call proxy, bukan cuma kosmetik urutan kode.
// ─────────────────────────────────────────────────────────────
export interface HardScreenInput {
  /**
   * DIDERIVASI dari fetch ticker24hr Wave 1, BUKAN dari fetch exchangeInfo
   * status terpisah -- FuturesExchangeInfoSymbol di codebase ini (beda dari
   * SpotSymbolInfo) tidak punya field `status` sama sekali, jadi fetch
   * tambahan cuma buat cek listing akan melanggar desain "no extra calls"
   * two-wave. Caller (fullPipeline.ts) WAJIB set false kalau
   * getTicker24hrNative() throw, lastPrice<=0, atau quoteVolume non-finite.
   * Didokumentasikan sebagai keterbatasan di docs/full_pipeline_framework.md.
   */
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
  /** SEMUA alasan gagal (bukan cuma yang pertama ketemu) -- transparansi penuh untuk symbol yang di-reject. */
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

// ─────────────────────────────────────────────────────────────
// TIER-1 SCORING -- kombinasi berbobot dari 4 komponen jadi satu rankingScore
// 0-100 dipakai buat sorting hasil multi-symbol. Bobot & threshold di bawah
// adalah PILIHAN EKSPLISIT terdokumentasi (bukan hasil kalibrasi statistik) --
// dicatat di docs/full_pipeline_framework.md Known Limitations, sama seperti
// threshold-threshold lain di codebase ini (mis. smartMoneyAnalysis.ts).
// ─────────────────────────────────────────────────────────────
export interface Tier1ScoreInput {
  /** Jumlah 6 skor sinyal MM (detectMmActivity.ts pure scorers), rentang 0-6. */
  mmTotalScore: number;
  smartMoneyCondition: MarketStructureCondition;
  /** confidenceScore dari analyzeSmartMoneyDivergence(), 0-100. */
  smartMoneyConfidenceScore: number;
  regime1h: RegimeResult;
  regime4h: RegimeResult;
  /** % volume bid dari total bid+ask di depth 20 order book, 0-100. */
  obiBidPct20: number;
  /** cvdBuyPct dari computeCvdFromTrades(), 0-100. */
  cvdBuyPct: number;
}

export interface Tier1ScoreResult {
  rankingScore: number; // 0-100
  notes: string[];
}

// RANGING paling ideal untuk grid bot (harga terkurung di range = grid
// ke-harvest terus), ACCUMULATION/DISTRIBUTION juga relatif kondusif
// (konsolidasi), TRENDING paling berisiko (harga cenderung keluar range).
// BREAKOUT didefinisikan (=0) cuma untuk exhaustiveness Record -- praktiknya
// tidak pernah sampai sini karena sudah difilter evaluateHardScreen().
const REGIME_FAVORABILITY: Record<MarketRegime, number> = {
  RANGING: 1.0,
  ACCUMULATION: 0.9,
  DISTRIBUTION: 0.7,
  TRENDING_UP: 0.5,
  TRENDING_DOWN: 0.4,
  BREAKOUT: 0,
};

export function scoreTier1Signals(input: Tier1ScoreInput): Tier1ScoreResult {
  const notes: string[] = [];

  // Komponen 1 (bobot 35%): skor MM composite (0-6 dari 6 sinyal detectMmActivity.ts) -> 0-100.
  const mmComponent = clampPct((input.mmTotalScore / 6) * 100);
  notes.push(`Skor MM composite ${input.mmTotalScore.toFixed(2)}/6 -> komponen ${mmComponent.toFixed(1)}/100 (bobot 35%).`);

  // Komponen 2 (bobot 30%): arah smart money vs retail. BULLISH_ACCUMULATION
  // mendukung long-grid (dorong skor naik), LONG_LIQUIDATION_RISK jadi
  // warning (dorong skor turun), SHORT_SQUEEZE_RISK campuran (upside tapi
  // volatil, setengah bobot confidence), NEUTRAL netral (0).
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

  // Komponen 3 (bobot 20%): favorability regime x confidence, rata-rata 1h+4h.
  const regime1hScore = REGIME_FAVORABILITY[input.regime1h.regime] * input.regime1h.confidence * 100;
  const regime4hScore = REGIME_FAVORABILITY[input.regime4h.regime] * input.regime4h.confidence * 100;
  const regimeComponent = clampPct((regime1hScore + regime4hScore) / 2);
  notes.push(
    `Regime 1h=${input.regime1h.regime}(${(input.regime1h.confidence * 100).toFixed(0)}%), 4h=${input.regime4h.regime}(${(input.regime4h.confidence * 100).toFixed(0)}%) -> komponen ${regimeComponent.toFixed(1)}/100 (bobot 20%).`,
  );

  // Komponen 4 (bobot 15%): tekanan beli (OBI depth-20 + CVD) -- tool ini
  // cuma dukung LONG grid (gridRiskEngine.ts, SIDE=+1, satu-satunya arah yang
  // didukung), jadi tekanan beli lebih tinggi = kondisi lebih mendukung.
  const buyPressureComponent = clampPct((input.obiBidPct20 + input.cvdBuyPct) / 2);
  notes.push(
    `Tekanan beli (OBI depth-20 ${input.obiBidPct20.toFixed(1)}%, CVD buy ${input.cvdBuyPct.toFixed(1)}%) -> komponen ${buyPressureComponent.toFixed(1)}/100 (bobot 15%).`,
  );

  const rankingScore = mmComponent * 0.35 + smartMoneyComponent * 0.3 + regimeComponent * 0.2 + buyPressureComponent * 0.15;

  return { rankingScore: clampPct(rankingScore), notes };
}

// ─────────────────────────────────────────────────────────────
// CAPITAL SOLVE -- "$risk_usd max loss to SL", EXACT bukan iteratif.
// calculateGridRisk() (gridRiskEngine.ts) linear di initialCapital untuk
// price/grid/leverage/SL tetap (gridQty linear di initialCapital, semua
// downstream linear/rasio linear) -- solve langsung, bukan binary-search.
// ─────────────────────────────────────────────────────────────
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
  if (!Number.isFinite(referenceCapital) || referenceCapital <= 0 || !Number.isFinite(targetRiskUsd) || targetRiskUsd <= 0) {
    throw new Error("Tidak bisa menyelesaikan capital solve: referenceCapital dan targetRiskUsd harus > 0.");
  }
  return (targetRiskUsd / referenceSlippageStressedLoss) * referenceCapital;
}

// ─────────────────────────────────────────────────────────────
// KEPUTUSAN AKHIR PIPELINE -- kombinasi hard-screen + grid-risk status
// leverage terpilih + rankingScore Tier-1 jadi satu TRADE/WATCH/NO_TRADE.
// ─────────────────────────────────────────────────────────────
export const TRADE_RANKING_SCORE_THRESHOLD = 55;

export interface DecidePipelineOutcomeInput {
  hardScreenPassed: boolean;
  hardScreenReasons: string[];
  rankingScore: number;
  /** Status calculateGridRisk() dari leverage terpilih -- pass "REJECT" kalau SEMUA leverage yang dievaluasi REJECT (tidak ada yang layak). */
  gridRiskStatus: GridRiskAnalysisResult["status"];
}

export interface DecidePipelineOutcomeResult {
  decision: "TRADE" | "WATCH" | "NO_TRADE";
  reasoning: string[];
}

export function decidePipelineOutcome(input: DecidePipelineOutcomeInput): DecidePipelineOutcomeResult {
  const reasoning: string[] = [];

  if (!input.hardScreenPassed) {
    reasoning.push(...input.hardScreenReasons);
    return { decision: "NO_TRADE", reasoning };
  }

  if (input.gridRiskStatus === "REJECT") {
    reasoning.push("Semua opsi leverage yang dievaluasi ditolak grid risk engine (status REJECT) -- setup tidak layak dijalankan saat ini.");
    return { decision: "NO_TRADE", reasoning };
  }

  if (input.gridRiskStatus === "HIGH_RISK") {
    reasoning.push(
      `Grid risk berstatus HIGH_RISK pada leverage terpilih (skor Tier-1 ${input.rankingScore.toFixed(1)}/100) -- disarankan WATCH dulu, bukan langsung eksekusi.`,
    );
    return { decision: "WATCH", reasoning };
  }

  // SAFE atau MODERATE.
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

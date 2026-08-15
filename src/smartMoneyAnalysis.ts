// Engine skor divergensi "smart money" (top trader / whale) vs "retail"
// (global account), dipakai oleh tool binance_analyze_smart_money.
//
// FILOSOFI (koreksi dari framing naif "MM memanipulasi long/short ratio"):
// Market maker murni delta-neutral (hedged) -- rasio long/short SENDIRI
// bukan bukti manipulasi. Yang diukur di sini adalah DIVERGENSI antara
// positioning akun besar (top trader) vs akun retail (global account),
// dikombinasikan dengan OI, funding rate, dan orderbook imbalance -- 5
// variabel yang semuanya independen dari asumsi "siapa yang manipulasi".
// Beda dari binance_detect_mm_activity (tools/detectMmActivity.ts) yang
// mengoperasionalkan Section 2-5 mm_detection_framework.md (absorption,
// spoofing, stop-hunt, basis arb) -- tool ini spesifik Section 4.2 (top
// trader vs retail divergence) plus OI/funding/orderbook sebagai konteks.
//
// THRESHOLD di bawah adalah BUCKET OPERASIONAL yang diminta secara eksplisit
// (bukan hasil kalibrasi statistik terhadap data historis Binance -- lihat
// docs/mm_detection_framework.md Section 4.2 untuk kenapa threshold absolut
// pada top-trader ratio harus dipakai hati-hati: pergerakan riil pair
// likuid cuma 0.4-2.35 poin/2 jam). confidenceScore di bawah dirancang
// supaya satu angka mentah tidak dibaca sebagai kepastian -- dia turun
// kalau sinyal cuma pas-pasan lewat threshold, naik kalau margin-nya lebar
// DAN sinyal pendukung (funding, orderbook) searah dengan tesis kondisi
// yang terdeteksi.
import type { PriceBias } from "./toolHelpers.js";

export interface DivergenceInputs {
  /** longShortRatio dari getTopTraderPositionRatio -- posisi akun besar (by size), bukan by jumlah akun. */
  topTraderPositionRatio: number;
  /** longShortRatio dari getGlobalAccountRatio -- blended semua akun (proxy retail). */
  globalAccountRatio: number;
  /** %change open interest window pendek (tool ini pakai ~4 jam terakhir). */
  oiDeltaPct: number;
  /** Funding rate desimal murni, misal -0.0005 = -0.05%. */
  fundingRate: number;
  /** % volume bid dari total bid+ask di depth 20 (0-100). */
  orderBookImbalancePct: number;
  /** Bias harga jangka pendek (tool ini pakai 24 candle @1h) -- khusus dibutuhkan kondisi SHORT_SQUEEZE_RISK. */
  priceBias: PriceBias;
}

export type MarketStructureCondition =
  | "LONG_LIQUIDATION_RISK"
  | "BULLISH_ACCUMULATION"
  | "SHORT_SQUEEZE_RISK"
  | "NEUTRAL";

export type SmartMoneyBias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type RetailSentiment = "CROWDED_LONG" | "CROWDED_SHORT" | "NEUTRAL";

export interface DivergenceAnalysisResult {
  condition: MarketStructureCondition;
  smartMoneyBias: SmartMoneyBias;
  retailSentiment: RetailSentiment;
  confidenceScore: number;
  divergenceScore: number;
  divergenceAnalysis: string;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Skor 0-1 seberapa jauh `value` sudah melewati `threshold` ke arah
// `direction`, saturasi di 1.0 setelah melewati threshold + saturateAt.
function marginScore(value: number, threshold: number, direction: "above" | "below", saturateAt: number): number {
  const distance = direction === "above" ? value - threshold : threshold - value;
  if (distance <= 0) return 0;
  return clamp01(distance / saturateAt);
}

function oiIncreaseScore(oiDeltaPct: number, saturateAtPct = 5): number {
  return oiDeltaPct > 0 ? clamp01(oiDeltaPct / saturateAtPct) : 0;
}

export function classifySmartMoneyBias(topTraderPositionRatio: number): SmartMoneyBias {
  if (topTraderPositionRatio > 1.05) return "BULLISH";
  if (topTraderPositionRatio < 0.95) return "BEARISH";
  return "NEUTRAL";
}

export function classifyRetailSentiment(globalAccountRatio: number): RetailSentiment {
  if (globalAccountRatio > 1.1) return "CROWDED_LONG";
  if (globalAccountRatio < 0.9) return "CROWDED_SHORT";
  return "NEUTRAL";
}

// Spread ternormalisasi antara positioning smart money vs retail, -100..100.
// Positif = smart money relatif lebih long dari retail (tesis akumulasi).
// Negatif = smart money relatif lebih short/netral dari retail (tesis trap).
// referenceSpread=1.5 adalah konstanta kalibrasi HEURISTIK (bukan
// statistik) supaya rentang output tetap masuk akal untuk longShortRatio
// yang secara empiris jarang menyentuh titik sangat ekstrem.
export function computeDivergenceScore(topTraderPositionRatio: number, globalAccountRatio: number): number {
  const referenceSpread = 1.5;
  const raw = ((topTraderPositionRatio - globalAccountRatio) / referenceSpread) * 100;
  return Math.round(Math.min(100, Math.max(-100, raw)));
}

interface ConditionScore {
  condition: MarketStructureCondition;
  matched: boolean;
  confidence: number;
}

function scoreLongLiquidationRisk(inputs: DivergenceInputs): ConditionScore {
  const matched = inputs.globalAccountRatio > 1.8 && inputs.topTraderPositionRatio < 0.95 && inputs.oiDeltaPct > 0;
  const core1 = marginScore(inputs.globalAccountRatio, 1.8, "above", 0.4);
  const core2 = marginScore(inputs.topTraderPositionRatio, 0.95, "below", 0.25);
  const core3 = oiIncreaseScore(inputs.oiDeltaPct);
  // Funding positif (retail bayar untuk tetap long) memperkuat tesis "retail trap".
  const support1 = inputs.fundingRate > 0 ? clamp01(inputs.fundingRate / 0.001) : 0;
  // Orderbook ask-heavy (resistensi menumpuk) memperkuat tesis topping.
  const support2 = inputs.orderBookImbalancePct < 50 ? clamp01((50 - inputs.orderBookImbalancePct) / 20) : 0;
  const confidence = Math.round(100 * (0.2 * core1 + 0.2 * core2 + 0.2 * core3 + 0.2 * support1 + 0.2 * support2));
  return { condition: "LONG_LIQUIDATION_RISK", matched, confidence };
}

function scoreBullishAccumulation(inputs: DivergenceInputs): ConditionScore {
  const matched = inputs.topTraderPositionRatio > 1.4 && inputs.globalAccountRatio < 0.8 && inputs.oiDeltaPct > 0;
  const core1 = marginScore(inputs.topTraderPositionRatio, 1.4, "above", 0.4);
  const core2 = marginScore(inputs.globalAccountRatio, 0.8, "below", 0.25);
  const core3 = oiIncreaseScore(inputs.oiDeltaPct);
  // Funding negatif (short crowded) memperkuat tesis "akumulasi di tengah sentimen bearish".
  const support1 = inputs.fundingRate < 0 ? clamp01(-inputs.fundingRate / 0.001) : 0;
  // Orderbook bid-heavy memperkuat tesis akumulasi.
  const support2 = inputs.orderBookImbalancePct > 50 ? clamp01((inputs.orderBookImbalancePct - 50) / 20) : 0;
  const confidence = Math.round(100 * (0.2 * core1 + 0.2 * core2 + 0.2 * core3 + 0.2 * support1 + 0.2 * support2));
  return { condition: "BULLISH_ACCUMULATION", matched, confidence };
}

function scoreShortSqueezeRisk(inputs: DivergenceInputs): ConditionScore {
  const matched =
    inputs.fundingRate < -0.0003 && inputs.topTraderPositionRatio > 1.2 && inputs.priceBias !== "BULLISH";
  const core1 = marginScore(inputs.fundingRate, -0.0003, "below", 0.001);
  const core2 = marginScore(inputs.topTraderPositionRatio, 1.2, "above", 0.4);
  const core3 = inputs.priceBias !== "BULLISH" ? 1 : 0;
  // Global ratio rendah (retail juga short) = lebih banyak "bahan bakar" squeeze.
  const support1 = inputs.globalAccountRatio < 1 ? clamp01((1 - inputs.globalAccountRatio) / 0.3) : 0;
  // Orderbook ask-heavy = short menumpuk di atas = bahan bakar squeeze.
  const support2 = inputs.orderBookImbalancePct < 50 ? clamp01((50 - inputs.orderBookImbalancePct) / 20) : 0;
  const confidence = Math.round(100 * (0.2 * core1 + 0.2 * core2 + 0.2 * core3 + 0.2 * support1 + 0.2 * support2));
  return { condition: "SHORT_SQUEEZE_RISK", matched, confidence };
}

const CONDITION_EXPLAIN: Record<MarketStructureCondition, string> = {
  LONG_LIQUIDATION_RISK:
    "Retail dominan long (global account ratio tinggi) sementara top trader justru short/netral -- pola klasik " +
    "'retail trap': OI naik seiring retail menambah long, kalau harga turun retail yang lebih dulu kena liquidasi.",
  BULLISH_ACCUMULATION:
    "Top trader dominan long sementara retail justru dominan short (dan OI naik) -- pola akumulasi smart money " +
    "di tengah sentimen retail yang justru bearish.",
  SHORT_SQUEEZE_RISK:
    "Funding rate negatif ekstrem (short crowded) sementara top trader tetap dominan long dan harga belum naik -- " +
    "posisi short berpotensi kena short squeeze kalau harga mulai bergerak naik.",
  NEUTRAL: "Tidak ada kombinasi sinyal yang cukup align untuk salah satu dari 3 kondisi divergensi di atas.",
};

function buildDivergenceAnalysisText(
  inputs: DivergenceInputs,
  result: Omit<DivergenceAnalysisResult, "divergenceAnalysis">,
): string {
  const oiWord = inputs.oiDeltaPct >= 0 ? "naik" : "turun";
  const fundingPct = (inputs.fundingRate * 100).toFixed(4);
  return (
    `Top trader position ratio ${inputs.topTraderPositionRatio.toFixed(3)} (smart money bias: ${result.smartMoneyBias}) ` +
    `vs global account ratio ${inputs.globalAccountRatio.toFixed(3)} (retail: ${result.retailSentiment}) -- ` +
    `divergence score ${result.divergenceScore >= 0 ? "+" : ""}${result.divergenceScore}. ` +
    `OI ${oiWord} ${Math.abs(inputs.oiDeltaPct).toFixed(2)}%, funding rate ${fundingPct}%, orderbook ${inputs.orderBookImbalancePct.toFixed(1)}% bid-heavy. ` +
    CONDITION_EXPLAIN[result.condition]
  );
}

// Urutan prioritas kalau lebih dari satu kondisi match bersamaan (jarang,
// tapi BULLISH_ACCUMULATION dan SHORT_SQUEEZE_RISK bisa overlap kalau top
// trader ratio > 1.4 DAN funding sangat negatif DAN OI naik sekaligus):
// liquidation risk > accumulation > squeeze -- risiko likuidasi retail
// paling actionable/urgent untuk ditampilkan duluan.
const PRIORITY_ORDER: MarketStructureCondition[] = [
  "LONG_LIQUIDATION_RISK",
  "BULLISH_ACCUMULATION",
  "SHORT_SQUEEZE_RISK",
];

export function analyzeSmartMoneyDivergence(inputs: DivergenceInputs): DivergenceAnalysisResult {
  const scores = [scoreLongLiquidationRisk(inputs), scoreBullishAccumulation(inputs), scoreShortSqueezeRisk(inputs)];
  const scoreByCondition = new Map(scores.map((s) => [s.condition, s]));

  const matchedCondition = PRIORITY_ORDER.find((c) => scoreByCondition.get(c)!.matched);
  const smartMoneyBias = classifySmartMoneyBias(inputs.topTraderPositionRatio);
  const retailSentiment = classifyRetailSentiment(inputs.globalAccountRatio);
  const divergenceScore = computeDivergenceScore(inputs.topTraderPositionRatio, inputs.globalAccountRatio);

  let condition: MarketStructureCondition;
  let confidenceScore: number;
  if (matchedCondition) {
    condition = matchedCondition;
    confidenceScore = scoreByCondition.get(matchedCondition)!.confidence;
  } else {
    // NEUTRAL: confidence merefleksikan seberapa jauh KONDISI TERDEKAT dari
    // threshold-nya -- makin dekat ada kondisi lain hampir match, makin
    // rendah keyakinan "benar-benar netral".
    condition = "NEUTRAL";
    const closestConditionConfidence = Math.max(...scores.map((s) => s.confidence)) / 100;
    confidenceScore = Math.round(100 * clamp01(1 - closestConditionConfidence));
  }

  const partial = { condition, smartMoneyBias, retailSentiment, confidenceScore, divergenceScore };
  return { ...partial, divergenceAnalysis: buildDivergenceAnalysisText(inputs, partial) };
}

// dcaSmartMoneyAdapter.ts -- DCA Smart Money Adapter V3 (Phase 3).
// Directional accumulation timing + 3-tier Pause Guard + smoothed ATR interval.
// STATEFUL via dca_active_plans (D1) untuk entry ke-N / next trigger -- dipersist
// di entryAlertCron sebelum kirim Telegram.
//
// REUSE Phase 1: calculateFlowAlignment, normalizeFunding, getOIVelocityPercentile.
import { calculateFlowAlignment, type FlowAlignmentInput } from "./smartMoneyPipelineEngine.js";
import { normalizeFunding, getOIVelocityPercentile, ema, calculateSlope, multiTfAlignScore } from "../tools/smartMoneyMetrics.js";
import { computeATR, summarizeKlines, type KlineCandle } from "../toolHelpers.js";
import type { MarketRegime } from "../tools/marketRegime.js";
import type { GridSmDecision } from "./gridSmartMoneyAdapter.js";
import { computeOiVelocity } from "../tools/oiVelocity.js";
import type { KlineTuple, OpenInterestHistPoint } from "../binanceProxyClient.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as streamGateway from "../streamGatewayClient.js";

export type DcaSide = "LONG" | "SHORT";
export type DcaPauseLevel = "NONE" | "PAUSE_SOFT" | "PAUSE_HARD" | "STOP";
export type DcaSmDecision =
  | "DCA_TRADE"
  | "DCA_WATCH"
  | "DCA_PAUSE_SOFT"
  | "DCA_PAUSE_HARD"
  | "DCA_STOP";

export const DCA_TIMING_TRADE_MIN = 75;
export const DCA_TIMING_WATCH_MIN = 60;
export const DCA_DEFAULT_MAX_ENTRIES = 6;
export const INTERVAL_FLOOR_PCT = 1.5;
export const INTERVAL_CEILING_PCT = 8.0;
export const ATR_EMA_PERIOD = 6;
export const CAPITULATION_LIQ_MULT = 5;
export const CAPITULATION_LIQ_USD = 2_000_000;

export const W_TIMING_SC = 0.4;
export const W_TIMING_SQUEEZE = 0.3;
export const W_TIMING_OI = 0.2;
export const W_TIMING_ANTI_SQUEEZE = 0.1;

const REGIME_INTERVAL_FACTOR: Record<string, number> = {
  LOW_VOL: 1.0,
  RANGING: 1.2,
  ACCUMULATION: 0.8,
  DISTRIBUTION: 1.0,
  BREAKOUT: 1.5,
  STRONG_TRENDING: 1.8,
  TRENDING_UP: 1.8,
  TRENDING_DOWN: 1.8,
};

function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

function clampInterval(x: number): number {
  return Math.min(INTERVAL_CEILING_PCT, Math.max(INTERVAL_FLOOR_PCT, x));
}

/** Short squeeze boost: funding percentile < 20 -> map (20 - pct) * 5 to 0-100. */
export function computeShortSqueezeBoost(fundingPercentile: number): number {
  if (fundingPercentile >= 20) return 0;
  return clamp100((20 - fundingPercentile) * 5);
}

/** Long squeeze risk: funding percentile > 80 -> map (pct - 80) * 5 to 0-100. */
export function computeLongSqueezeRisk(fundingPercentile: number): number {
  if (fundingPercentile <= 80) return 0;
  return clamp100((fundingPercentile - 80) * 5);
}

export interface DirectionalTimingComponents {
  flowAlignment: number;
  squeezeBoost: number;
  oiVelocity: number;
  antiSqueeze: number;
}

/**
 * Directional timing 0-100. LONG: S_C + ShortSqueezeBoost + OI + (100-LongRisk).
 * SHORT (mirror): (100-S_C) + LongRisk-as-boost + OI + (100-ShortBoost).
 */
export function computeDirectionalTiming(
  side: DcaSide,
  flowAlignmentScore: number,
  fundingPercentile: number,
  oiVelocityPercentile: number,
): { score: number; components: DirectionalTimingComponents } {
  const sC = clamp100(flowAlignmentScore);
  const shortBoost = computeShortSqueezeBoost(fundingPercentile);
  const longRisk = computeLongSqueezeRisk(fundingPercentile);
  const oi = clamp100(oiVelocityPercentile);

  let score: number;
  let squeezeBoost: number;
  let antiSqueeze: number;

  if (side === "LONG") {
    squeezeBoost = shortBoost;
    antiSqueeze = 100 - longRisk;
    score =
      W_TIMING_SC * sC +
      W_TIMING_SQUEEZE * shortBoost +
      W_TIMING_OI * oi +
      W_TIMING_ANTI_SQUEEZE * antiSqueeze;
  } else {
    // Mirror: long crowded = boost short DCA; short squeeze setup = penalty.
    squeezeBoost = longRisk;
    antiSqueeze = 100 - shortBoost;
    score =
      W_TIMING_SC * (100 - sC) +
      W_TIMING_SQUEEZE * longRisk +
      W_TIMING_OI * oi +
      W_TIMING_ANTI_SQUEEZE * antiSqueeze;
  }

  return {
    score: clamp100(score),
    components: { flowAlignment: sC, squeezeBoost, oiVelocity: oi, antiSqueeze },
  };
}

export interface DcaSafetyResult {
  score: number;
  /** Penalti "arus order melawan tesis akumulasi arah ini". */
  distributionPenalty: number;
  /** Penalti risiko squeeze YANG MERUGIKAN arah ini. */
  squeezePenalty: number;
  /** Risiko squeeze yang merugikan arah ini, 0-100. */
  adverseSqueezeRisk: number;
}

// ─────────────────────────────────────────────────────────────
// K10 (BARU, ditemukan 2026-09-04 oleh reachability test Stage 2)
// -- SAFETY/PAUSE DULU HANYA DITULIS DARI SUDUT PANDANG LONG.
//
// computeDirectionalTiming() SUDAH mencerminkan arah (SHORT = mirror), tapi
// dua fungsi di bawah tidak ikut diperbarui:
//   - distributionPenalty dipicu S_C < 25. S_C rendah = arus jual dominan --
//     buruk untuk DCA LONG, tapi justru TESIS-nya DCA SHORT.
//   - penalti squeeze memakai computeLongSqueezeRisk(). Funding di persentil
//     tinggi = long crowded -- risiko untuk LONG, tapi bahan bakar SHORT.
//
// Akibatnya: makin KUAT setup SHORT, makin besar penaltinya, sampai
// safety < 20 -> DCA_STOP. DCA SHORT secara struktural tidak terjangkau
// tepat ketika seharusnya paling layak. Ini saudara kandung K4, ditemukan
// karena test reachability -- bukan oleh 849 test lama yang menyuapkan
// angka satu per satu.
//
// Perbaikannya MENGIKUTI konvensi mirror yang SUDAH ada di
// computeDirectionalTiming(), bukan desain baru.
// ─────────────────────────────────────────────────────────────
export function computeDcaSafetyScore(
  flowAlignmentScore: number,
  fundingPercentile: number,
  side: DcaSide = "LONG",
): DcaSafetyResult {
  const sC = clamp100(flowAlignmentScore);
  // Arus yang MELAWAN tesis arah ini.
  const flowAgainst = side === "LONG" ? sC < 25 : sC > 75;
  // Squeeze yang MERUGIKAN arah ini: LONG takut long-squeeze (funding
  // percentile tinggi), SHORT takut short-squeeze (percentile rendah).
  const adverseSqueezeRisk =
    side === "LONG" ? computeLongSqueezeRisk(fundingPercentile) : computeShortSqueezeBoost(fundingPercentile);
  const distributionPenalty = flowAgainst ? 40 : 0;
  const squeezePenalty = adverseSqueezeRisk > 80 ? 50 : adverseSqueezeRisk > 60 ? 25 : 0;
  const score = Math.max(0, 100 - distributionPenalty - squeezePenalty);
  return { score, distributionPenalty, squeezePenalty, adverseSqueezeRisk };
}

export interface CapitulationInput {
  liqSpikeUsd: number;
  liqMean24hUsd: number;
  priceDropAbs?: number;
  atr1h?: number;
}

/** Capitulation: liq > 5x baseline OR (>$2M liq AND price drop > 2×ATR). */
export function isCapitulation(input: CapitulationInput): boolean {
  const { liqSpikeUsd, liqMean24hUsd, priceDropAbs, atr1h } = input;
  if (liqMean24hUsd > 0 && liqSpikeUsd > CAPITULATION_LIQ_MULT * liqMean24hUsd) return true;
  if (
    liqSpikeUsd > CAPITULATION_LIQ_USD &&
    priceDropAbs != null &&
    atr1h != null &&
    atr1h > 0 &&
    priceDropAbs > 2 * atr1h
  ) {
    return true;
  }
  return false;
}

/**
 * Pause hierarchy (severity: STOP > HARD > SOFT > NONE).
 * Spec Phase 3 prompt section 2B.
 */
export function resolvePauseLevel(
  safetyScore: number,
  flowAlignmentScore: number,
  /** Risiko squeeze yang MERUGIKAN arah yang dievaluasi (lihat K10). */
  adverseSqueezeRisk: number,
  capitulation: boolean,
  side: DcaSide = "LONG",
): DcaPauseLevel {
  if (safetyScore < 20 || capitulation) return "STOP";
  if (safetyScore < 50 || adverseSqueezeRisk > 80) return "PAUSE_HARD";
  // K10: S_C rendah = arus jual dominan. Itu melawan tesis LONG, tapi
  // MENDUKUNG tesis SHORT -- ambangnya harus dicerminkan, bukan dipakai
  // apa adanya untuk kedua arah.
  const flowAgainst = side === "LONG" ? flowAlignmentScore < 25 : flowAlignmentScore > 75;
  if (safetyScore < 70 || flowAgainst) return "PAUSE_SOFT";
  return "NONE";
}

/** ATR_1h series (trailing) then EMA(6) for smoothed interval base. */
export function computeSmoothedAtrPct(candles1h: KlineCandle[], atrPeriod = 14, emaPeriod = ATR_EMA_PERIOD): number {
  if (candles1h.length < atrPeriod + 1) return INTERVAL_FLOOR_PCT;
  const atrSeries: number[] = [];
  const start = Math.max(atrPeriod, candles1h.length - emaPeriod - atrPeriod);
  for (let end = start + atrPeriod; end <= candles1h.length; end++) {
    atrSeries.push(computeATR(candles1h.slice(0, end), atrPeriod));
  }
  if (atrSeries.length === 0) return INTERVAL_FLOOR_PCT;
  return ema(atrSeries, emaPeriod);
}

export function regimeIntervalFactor(regime: MarketRegime | string): number {
  return REGIME_INTERVAL_FACTOR[regime] ?? 1.0;
}

/** finalInterval = clamp(1.5, 8.0, (smoothedATR/price)*100 * regimeFactor). */
export function computeDynamicIntervalPct(
  candles1h: KlineCandle[],
  currentPrice: number,
  regime: MarketRegime | string,
): number {
  if (!(currentPrice > 0)) return INTERVAL_FLOOR_PCT;
  const smoothedAtr = computeSmoothedAtrPct(candles1h);
  const baseInterval = (smoothedAtr / currentPrice) * 100;
  return clampInterval(baseInterval * regimeIntervalFactor(regime));
}

export function computeNextTriggerPrice(currentPrice: number, intervalPct: number, side: DcaSide): number {
  const factor = side === "LONG" ? 1 - intervalPct / 100 : 1 + intervalPct / 100;
  return currentPrice * factor;
}

export interface DcaSmartMoneyInput {
  symbol: string;
  side: DcaSide;
  currentPrice: number;
  flowAlignment: FlowAlignmentInput;
  fundingRate: number;
  fundingHistory30d: number[];
  /** Rentang jam yang benar-benar tercakup fundingHistory30d (observabilitas). */
  fundingHistoryHours?: number;
  oiVelocityPerHour: number;
  oiVelocityHistory: number[];
  regime: MarketRegime | string;
  candles1h: KlineCandle[];
  liqSpikeUsd: number;
  liqMean24hUsd: number;
  priceDropAbs?: number;
  atr1h?: number;
  /** Cross-product: gridSmartMoneyAdapter GRID_NO_TRADE (breakout/range breakdown). */
  gridSmDecision?: GridSmDecision | null;
  entryCount?: number;
  maxEntries?: number;
}

export interface DcaSmartMoneyResult {
  decision: DcaSmDecision;
  timingScore: number;
  safetyScore: number;
  intervalPct: number;
  nextTriggerPrice: number;
  /** Harga saat evaluasi -- dipakai entryAlertCron untuk mendeteksi apakah
   *  nextTriggerPrice plan sebelumnya sudah terlampaui (D1). */
  currentPrice: number;
  side: DcaSide;
  pauseLevel: DcaPauseLevel;
  pauseReason: string | null;
  entryCount: number;
  maxEntries: number;
  fundingPercentile: number;
  oiVelocityPercentile: number;
  flowAlignmentScore: number;
  reasons: string[];
}

export function flowAlignmentFrom(input: FlowAlignmentInput): number {
  return calculateFlowAlignment(input);
}

/** Rolling OI velocity samples from openInterestHist (window 5). */
export function oiVelocityHistoryFromHist(oiHist: OpenInterestHistPoint[]): number[] {
  const out: number[] = [];
  for (let i = 5; i <= oiHist.length; i++) {
    const v = computeOiVelocity(oiHist.slice(i - 5, i), 5);
    if (!v.errorCode) out.push(v.oiVelocityPerHour);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// K4 + D3 (2026-09-04, Stage 2 signal-integrity) -- SUMBER HISTORI FUNDING.
//
// DULU: queryMarketSnapshots(symbol, 24*30) -- baca D1 `market_snapshots`.
// DUA cacat sekaligus:
//
//  K4 (fungsional, fatal). `market_snapshots` HANYA diisi untuk 50 pair
//  SNAPSHOT_WATCHLIST (+ top-5 non-watchlist yang sering di-query). Untuk
//  pair lain history-nya KOSONG -> normalizeFunding() balik 50 (netral) ->
//  computeShortSqueezeBoost(50) = 0 DAN computeLongSqueezeRisk(50) = 0.
//  Timing LONG lalu ter-cap secara aritmetika:
//      0.4*S_C + 0.3*0 + 0.2*oi + 0.1*100  <=  0.4*64 + 20 + 10 = 55.6
//  Padahal DCA_TIMING_WATCH_MIN = 60 dan DCA_TIMING_TRADE_MIN = 75.
//  Artinya: untuk mayoritas pair, head DCA V3 TIDAK PERNAH bisa keluar dari
//  DCA_PAUSE_SOFT -- nol alert DCA, selamanya, tanpa satu pun error di log.
//
//  D3 (biaya). Query itu `SELECT *` TANPA LIMIT atas tabel yang diisi tiap
//  5 menit: ~8.640 baris per symbol per 30 hari, dipanggil untuk tiap
//  symbol top-40, tiap 15 menit -> ~345k row-read per tick, ~33 juta/hari.
//  Salah satu kontributor wall-clock cron 12m13s.
//
// SEKARANG: /fapi/v1/fundingRate (weight 1, sudah LONG_CACHE 300s di
// binanceProxyClient.ts). Tersedia untuk SEMUA perp, bukan cuma watchlist.
// Biaya +1 subrequest/symbol (~40/tick, ~160/jam vs budget 1.800/menit --
// dapat diabaikan) DAN menghapus ~33 juta row-read D1/hari. Net: turun.
//
// CATATAN JUJUR: `fundingRate` yang dibandingkan adalah lastFundingRate
// (rate berjalan/prediktif dari premiumIndex), sedangkan history di sini
// adalah rate yang SUDAH settle. Sedikit apples-to-oranges, tapi itu memang
// perbandingan yang diinginkan ("posisi funding sekarang relatif terhadap
// sebulan terakhir") dan jauh lebih baik daripada konstanta 50.
//
// Interval funding berbeda per pair (8 jam mayoritas, sebagian 4 jam / 1
// jam), jadi 90 titik TIDAK selalu tepat 30 hari. Kita tidak menambah call
// ke /fapi/v1/fundingInfo cuma untuk tahu intervalnya -- window aktual
// dilaporkan lewat fundingHistoryHours supaya bisa dibaca apa adanya.
// ─────────────────────────────────────────────────────────────
export const FUNDING_HISTORY_POINTS = 90; // 90 x 8 jam = 30 hari untuk pair interval-8h
/** Di bawah ini, percentile funding dianggap terlalu tipis untuk dipercaya. */
export const FUNDING_HISTORY_MIN_POINTS = 10;

export interface FundingHistoryResult {
  rates: number[];
  /** Rentang waktu yang benar-benar tercakup (jam). 0 kalau kosong. */
  hours: number;
}

export async function loadFundingHistory30d(symbol: string): Promise<FundingHistoryResult> {
  try {
    const points = await binanceProxy.getFundingRateHistoryNative(symbol, FUNDING_HISTORY_POINTS);
    const rates: number[] = [];
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      const rate = parseFloat(p.fundingRate);
      if (!Number.isFinite(rate)) continue;
      rates.push(rate);
      if (Number.isFinite(p.fundingTime)) {
        if (p.fundingTime < minTime) minTime = p.fundingTime;
        if (p.fundingTime > maxTime) maxTime = p.fundingTime;
      }
    }
    const hours = rates.length > 1 && Number.isFinite(minTime) && Number.isFinite(maxTime) ? (maxTime - minTime) / 3_600_000 : 0;
    return { rates, hours };
  } catch {
    // Gagal fetch -> history kosong -> normalizeFunding balik 50 (netral).
    // Sama seperti perilaku lama saat D1 kosong, tapi sekarang itu kondisi
    // LANGKA (kegagalan jaringan), bukan kondisi NORMAL untuk 300 dari 350 pair.
    return { rates: [], hours: 0 };
  }
}

// ─────────────────────────────────────────────────────────────
// D2 (2026-09-04, Stage 2) -- CAPITULATION DETECTION AKHIRNYA PUNYA DATA.
//
// CACAT LAMA: buildAndEvaluateDcaSmartMoney() memakai default
// `liqSpikeUsd ?? 0` / `liqMean24hUsd ?? 0`, dan fullPipeline TIDAK PERNAH
// mengisinya. isCapitulation() karena itu SELALU false -- level DCA_STOP
// hanya bisa dicapai lewat safety < 20. Guard capitulation-nya mati total
// padahal stream gateway VPS menyimpan liquidations 24 jam di SQLite.
//
// KETERBATASAN JUJUR: queryLiquidations() di gateway di-cap 1000 baris
// (ORDER BY trade_time DESC). Untuk pair sangat likuid, 1000 baris terakhir
// bisa jadi TIDAK mencakup 24 jam penuh. Karena itu baseline dihitung atas
// rentang yang BENAR-BENAR tercakup baris yang kembali, bukan diasumsikan
// 24 jam -- mengasumsikan 24 jam akan membuat baseline terlalu KECIL
// (cuma periode terpadat yang terhitung) dan capitulation over-trigger.
//
// `meanHourlyUsd` = notional per JAM rata-rata sepanjang rentang tercakup,
// dibandingkan dengan `spikeUsd` = notional 1 jam terakhir. Dimensinya
// konsisten (jam vs jam) -- berbeda dari nama field lama `liqMean24hUsd`
// yang menyiratkan total 24 jam dibanding satu spike.
// ─────────────────────────────────────────────────────────────
export const LIQ_LOOKBACK_MS = 24 * 3_600_000;
export const LIQ_SPIKE_WINDOW_MS = 3_600_000;
export const LIQ_QUERY_LIMIT = 1000;

export interface LiquidationStats {
  spikeUsd: number;
  meanHourlyUsd: number;
  /** Rentang jam yang benar-benar tercakup sampel (bisa < 24 kalau ke-cap). */
  coveredHours: number;
  sampleCount: number;
  capped: boolean;
}

export const EMPTY_LIQUIDATION_STATS: LiquidationStats = {
  spikeUsd: 0,
  meanHourlyUsd: 0,
  coveredHours: 0,
  sampleCount: 0,
  capped: false,
};

/** Pure: hitung spike 1 jam + baseline per-jam dari event mentah gateway. */
export function computeLiquidationStats(
  events: { trade_time: number; notional_usd: number }[],
  now: number,
): LiquidationStats {
  const valid = events.filter((e) => Number.isFinite(e.trade_time) && Number.isFinite(e.notional_usd));
  if (valid.length === 0) return EMPTY_LIQUIDATION_STATS;

  let spikeUsd = 0;
  let totalUsd = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const e of valid) {
    totalUsd += e.notional_usd;
    if (e.trade_time < oldest) oldest = e.trade_time;
    if (now - e.trade_time <= LIQ_SPIKE_WINDOW_MS) spikeUsd += e.notional_usd;
  }
  const coveredHours = Math.max((now - oldest) / 3_600_000, 0);
  // < 1 jam tercakup -> tidak ada baseline yang bermakna; jangan bagi dengan
  // angka kecil dan menghasilkan "mean" raksasa yang bikin capitulation
  // tidak pernah trigger (atau sebaliknya).
  const meanHourlyUsd = coveredHours >= 1 ? totalUsd / coveredHours : 0;
  return {
    spikeUsd,
    meanHourlyUsd,
    coveredHours,
    sampleCount: valid.length,
    capped: valid.length >= LIQ_QUERY_LIMIT,
  };
}

/** Fetch + reduce. Gagal / gateway mati -> stats kosong (capitulation off). */
export async function loadLiquidationStats(symbol: string, now: number = Date.now()): Promise<LiquidationStats> {
  try {
    const res = await streamGateway.fetchLiquidations({
      symbol,
      sinceMs: now - LIQ_LOOKBACK_MS,
      limit: LIQ_QUERY_LIMIT,
    });
    return computeLiquidationStats(res.events ?? [], now);
  } catch {
    return EMPTY_LIQUIDATION_STATS;
  }
}

export interface BuildDcaSmParams {
  symbol: string;
  side: DcaSide;
  currentPrice: number;
  klines1h: KlineTuple[];
  klines4h: KlineTuple[];
  fundingRate: number;
  oiHist24: OpenInterestHistPoint[];
  oiVelocityPerHour: number;
  regime: MarketRegime | string;
  gridSmDecision?: GridSmDecision | null;
  cvdBuyPct?: number;
  entryCount?: number;
  /** D2: kalau tidak diisi, diambil dari stream gateway (loadLiquidationStats). */
  liqStats?: LiquidationStats;
}

/** Build flow-alignment + funding/OI context dari data Wave 1/2 pipeline. */
export async function buildAndEvaluateDcaSmartMoney(params: BuildDcaSmParams): Promise<DcaSmartMoneyResult> {
  const { candles: candles1h, bias: b1h } = summarizeKlines(params.klines1h);
  const { bias: b4h } = summarizeKlines(params.klines4h);
  // K3 (Stage 3): `slopeSpot: slopeFutures * 0.85` DIHAPUS di sini. Itu data
  // spot yang dikarang, dan karena bobotnya paling besar di rumus lama,
  // separuh skor "divergence" jadi konstanta 28.05. Sekarang skor hanya
  // dibangun dari dua sinyal yang datanya benar-benar ada.
  const flowAlignment: FlowAlignmentInput = {
    takerFlowNorm: params.cvdBuyPct ?? 50,
    multiTfAlign: multiTfAlignScore(b1h, b4h),
  };
  // Dua I/O ini independen -- jalankan paralel, jangan berurutan.
  const [funding, liq] = await Promise.all([
    loadFundingHistory30d(params.symbol),
    // D2: kalau caller sudah menyediakan stats (mis. test), pakai itu;
    // kalau tidak, ambil dari stream gateway.
    params.liqStats !== undefined ? Promise.resolve(params.liqStats) : loadLiquidationStats(params.symbol),
  ]);
  const atr1h = computeATR(candles1h, 14);

  return evaluateDcaSmartMoney({
    symbol: params.symbol,
    side: params.side,
    currentPrice: params.currentPrice,
    flowAlignment,
    fundingRate: params.fundingRate,
    fundingHistory30d: funding.rates,
    fundingHistoryHours: funding.hours,
    oiVelocityPerHour: params.oiVelocityPerHour,
    oiVelocityHistory: oiVelocityHistoryFromHist(params.oiHist24),
    regime: params.regime,
    candles1h,
    liqSpikeUsd: liq.spikeUsd,
    liqMean24hUsd: liq.meanHourlyUsd,
    atr1h,
    gridSmDecision: params.gridSmDecision,
    entryCount: params.entryCount,
  });
}

export function evaluateDcaSmartMoney(input: DcaSmartMoneyInput): DcaSmartMoneyResult {
  const reasons: string[] = [];
  const maxEntries = input.maxEntries ?? DCA_DEFAULT_MAX_ENTRIES;
  const entryCount = input.entryCount ?? 0;

  const flowAlignmentScore = calculateFlowAlignment(input.flowAlignment);
  const fundingPercentile = normalizeFunding(input.fundingRate, input.fundingHistory30d);
  const oiVelocityPercentile = getOIVelocityPercentile(input.oiVelocityPerHour, input.oiVelocityHistory);

  // K4: histori funding yang tipis/kosong membuat percentile jatuh ke 50
  // netral, yang secara aritmetika menutup jalan ke DCA_WATCH/DCA_TRADE.
  // Dulu ini kondisi DIAM untuk ~300 dari 350 pair; sekarang harus terlihat
  // di `reasons` supaya "nol sinyal" tidak pernah lagi salah dibaca sebagai
  // "pasar sepi".
  const fundingHistoryPoints = input.fundingHistory30d.filter((v) => Number.isFinite(v)).length;
  if (fundingHistoryPoints < FUNDING_HISTORY_MIN_POINTS) {
    reasons.push(
      `⚠ Histori funding tipis (${fundingHistoryPoints} titik${input.fundingHistoryHours ? `, ~${input.fundingHistoryHours.toFixed(0)} jam` : ""}) -> percentile ${fundingPercentile.toFixed(0)} kurang bermakna; komponen squeeze praktis netral.`,
    );
  }

  const { score: timingScore, components: timingComp } = computeDirectionalTiming(
    input.side,
    flowAlignmentScore,
    fundingPercentile,
    oiVelocityPercentile,
  );
  const safety = computeDcaSafetyScore(flowAlignmentScore, fundingPercentile, input.side);
  const capitulation = isCapitulation({
    liqSpikeUsd: input.liqSpikeUsd,
    liqMean24hUsd: input.liqMean24hUsd,
    priceDropAbs: input.priceDropAbs,
    atr1h: input.atr1h,
  });
  let pauseLevel = resolvePauseLevel(safety.score, flowAlignmentScore, safety.adverseSqueezeRisk, capitulation, input.side);
  let pauseReason: string | null = null;

  reasons.push(
    `D_timing ${timingScore.toFixed(1)} (S_C ${timingComp.flowAlignment.toFixed(0)}, squeeze ${timingComp.squeezeBoost.toFixed(0)}, OI ${timingComp.oiVelocity.toFixed(0)}, anti ${timingComp.antiSqueeze.toFixed(0)})`,
  );
  reasons.push(
    `Safety ${safety.score.toFixed(0)} (distPen ${safety.distributionPenalty}, squeezePen ${safety.squeezePenalty}, adverseSqueeze ${safety.adverseSqueezeRisk.toFixed(0)})`,
  );

  if (capitulation) reasons.push("Capitulation detected (liq spike vs baseline / $2M+ drop)");

  const intervalPct = computeDynamicIntervalPct(input.candles1h, input.currentPrice, input.regime);
  const nextTriggerPrice = computeNextTriggerPrice(input.currentPrice, intervalPct, input.side);
  reasons.push(`Interval ${intervalPct.toFixed(2)}% -> next trigger ${nextTriggerPrice.toFixed(4)}`);

  // Cross-product guard: Grid Bot NO_TRADE -> override to PAUSE_SOFT minimum.
  if (input.gridSmDecision === "GRID_NO_TRADE") {
    if (pauseLevel === "NONE") {
      pauseLevel = "PAUSE_SOFT";
      pauseReason = "Grid Bot detects range breakdown risk on same symbol";
      reasons.push(`Cross-product: GRID_NO_TRADE -> ${pauseLevel} (${pauseReason})`);
    }
  }

  if (pauseLevel === "STOP") {
    pauseReason =
      pauseReason ??
      (capitulation
        ? "Capitulation liquidation spike — manual review required"
        : `Safety score ${safety.score.toFixed(0)} < 20`);
    return {
      decision: "DCA_STOP",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      currentPrice: input.currentPrice,
      side: input.side,
      pauseLevel,
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      flowAlignmentScore,
      reasons: [...reasons, "🚨 DCA PLAN INVALIDATED - MANUAL REVIEW REQUIRED"],
    };
  }

  if (pauseLevel === "PAUSE_HARD") {
    pauseReason =
      pauseReason ??
      (safety.adverseSqueezeRisk > 80
        ? `Adverse squeeze risk ${safety.adverseSqueezeRisk.toFixed(0)} > 80 (arah ${input.side})`
        : `Safety score ${safety.score.toFixed(0)} < 50`);
    return {
      decision: "DCA_PAUSE_HARD",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      currentPrice: input.currentPrice,
      side: input.side,
      pauseLevel,
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      flowAlignmentScore,
      reasons: [...reasons, `Pause HARD: ${pauseReason}`],
    };
  }

  if (pauseLevel === "PAUSE_SOFT") {
    pauseReason =
      pauseReason ??
      (flowAlignmentScore < 25
        ? `Distribution signal S_C ${flowAlignmentScore.toFixed(0)} < 25`
        : `Safety score ${safety.score.toFixed(0)} < 70`);
    return {
      decision: "DCA_PAUSE_SOFT",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      currentPrice: input.currentPrice,
      side: input.side,
      pauseLevel,
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      flowAlignmentScore,
      reasons: [...reasons, `Pause SOFT (defer 2 ticks): ${pauseReason}`],
    };
  }

  if (entryCount >= maxEntries) {
    return {
      decision: "DCA_PAUSE_HARD",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      currentPrice: input.currentPrice,
      side: input.side,
      pauseLevel: "PAUSE_HARD",
      pauseReason: `Max entries reached (${entryCount}/${maxEntries})`,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      flowAlignmentScore,
      reasons: [...reasons, "Max entries cap — freeze DCA plan"],
    };
  }

  let decision: DcaSmDecision;
  if (timingScore >= DCA_TIMING_TRADE_MIN) {
    decision = "DCA_TRADE";
  } else if (timingScore >= DCA_TIMING_WATCH_MIN) {
    decision = "DCA_WATCH";
  } else {
    decision = "DCA_PAUSE_SOFT";
    pauseReason = `Timing ${timingScore.toFixed(0)} < ${DCA_TIMING_WATCH_MIN}`;
    return {
      decision,
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      currentPrice: input.currentPrice,
      side: input.side,
      pauseLevel: "PAUSE_SOFT",
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      flowAlignmentScore,
      reasons: [...reasons, pauseReason],
    };
  }

  reasons.push(`Decision ${decision} (timing ${timingScore.toFixed(1)})`);
  return {
    decision,
    timingScore,
    safetyScore: safety.score,
    intervalPct,
    nextTriggerPrice,
    currentPrice: input.currentPrice,
    side: input.side,
    pauseLevel: "NONE",
    pauseReason: null,
    entryCount,
    maxEntries,
    fundingPercentile,
    oiVelocityPercentile,
    flowAlignmentScore,
    reasons,
  };
}

import type { BinanceMarketData } from "./binanceFetcher.js";
import { fetchSymbolTradingRules } from "./binanceFetcher.js";
import type { GridContextualRisk } from "./marketContext.js";
import { fetchMaintMarginRatio } from "./leverageBracket.js";
import { hasBinanceApiCredentials } from "./binanceProxyClient.js";

export interface GridInputParams {
  symbol: string;
  initialCapital: number;
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  gridCount: number;
  stopLossPrice: number;
  leverage: number;
  gridType: "ARITHMETIC" | "GEOMETRIC";
  feeRate?: number;
}

export interface GridRiskAnalysisResult {
  avgEntryPrice: number;
  totalQuantity: number;
  capitalPerGridUSD: number;
  maxExposureSL: number;
  slippageStressedLoss: number;
  stressMultiplier: 1.15 | 1.25;
  liquidationPrice: number;
  dailyFundingBleedUSD: number;
  rawProfitPerCycleUSD: number;
  netProfitPerCycleUSD: number;
  minBreakevenCycles: number;
  riskPercentage: number;
  rangePercentage: number;
  filledGridCount: number;
  gridTypeMismatch: boolean;
  status: "SAFE" | "MODERATE" | "HIGH_RISK" | "REJECT";
  rejectionReason?: string;
  decisionReason?: string;
}

// gridCount = jumlah interval/grid (definisi resmi Binance), jadi titik
// harga yang dihasilkan adalah gridCount + 1, bukan gridCount.
function arithmeticGrid(lower: number, upper: number, count: number): number[] {
  const step = (upper - lower) / count;
  return Array.from({ length: count + 1 }, (_, index) => lower + step * index);
}

function geometricGrid(lower: number, upper: number, count: number): number[] {
  if (lower <= 0 || upper <= 0) return [];
  const ratio = (upper / lower) ** (1 / count);
  return Array.from({ length: count + 1 }, (_, index) => lower * ratio ** index);
}

function round(value: number, decimals = 8): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function reject(
  reason: string,
  rangePercentage = 0,
  gridTypeMismatch = false,
): GridRiskAnalysisResult {
  return {
    avgEntryPrice: 0,
    totalQuantity: 0,
    capitalPerGridUSD: 0,
    maxExposureSL: 0,
    slippageStressedLoss: 0,
    stressMultiplier: 1.15,
    liquidationPrice: 0,
    dailyFundingBleedUSD: 0,
    rawProfitPerCycleUSD: 0,
    netProfitPerCycleUSD: 0,
    minBreakevenCycles: 0,
    riskPercentage: 0,
    rangePercentage,
    filledGridCount: 0,
    gridTypeMismatch,
    status: "REJECT",
    rejectionReason: reason,
  };
}

// ── Buffer maintenance-margin-rate (MMR) untuk liquidationPrice ─────────
// liquidationPrice = avgEntryPrice * (1 - 1/leverage + BUFFER). BUFFER
// meniru maintenance margin rate: makin tinggi MMR, makin dekat likuidasi
// ke entry. Prefer `/fapi/v1/leverageBracket` (SIGNED) kalau
// BINANCE_API_KEY/SECRET tersedia; kalau tidak / fetch gagal → heuristik
// volume 24h di bawah (BELUM dikalibrasi — fallback saja).
export const HIGH_LIQUIDITY_THRESHOLD_USD = 500_000_000;
export const MID_LIQUIDITY_THRESHOLD_USD = 50_000_000;
export const MMR_BUFFER_HIGH = 0.005; // 0.5% -- BTC/ETH/top pair (default lama)
export const MMR_BUFFER_MID = 0.0075; // 0.75%
export const MMR_BUFFER_LOW = 0.015; // 1.5% -- altcoin kecil / data hilang

/**
 * Estimasi buffer MMR dari quote volume 24h (USDT). `undefined` / non-finite
 * / <= 0 -> tier PALING KONSERVATIF (1.5%) -- data hilang tidak boleh
 * diam-diam dianggap likuid. Dipakai hanya kalau leverageBracket tidak
 * tersedia.
 */
export function estimateMaintenanceMarginBufferPct(quoteVolumeUsd: number | undefined): number {
  if (quoteVolumeUsd === undefined || !Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd <= 0) {
    return MMR_BUFFER_LOW;
  }
  if (quoteVolumeUsd >= HIGH_LIQUIDITY_THRESHOLD_USD) return MMR_BUFFER_HIGH;
  if (quoteVolumeUsd >= MID_LIQUIDITY_THRESHOLD_USD) return MMR_BUFFER_MID;
  return MMR_BUFFER_LOW;
}

// Binance default adjust coefficient utk grid Futures -- docs menyebut nilai
// ini "may be adjusted based on market conditions", tapi Binance sendiri gak
// expose endpoint publik utk baca nilai real-time-nya, jadi dipakai default
// resmi 0.8 (bukan hardcode per-pair, berlaku sama utk semua symbol).
const ADJUST_COEF = 0.8;
// SIDE = +1 utk Long grid -- satu-satunya arah yang didukung tool ini saat ini.
const SIDE = 1;

function assumingPriceBuy(price: number): number {
  return price;
}

// Sisi SELL grid Long belum dipakai di tool ini (cuma Long grid yang
// didukung), tapi disertakan supaya rumus persis mengikuti definisi resmi
// Binance Futures Grid ("What Is Futures Grid Trading?").
function assumingPriceSell(price: number, markPrice: number): number {
  return Math.max(markPrice, price);
}

export async function calculateGridRisk(
  params: GridInputParams,
  marketData: BinanceMarketData,
  contextualRisk: GridContextualRisk,
): Promise<GridRiskAnalysisResult> {
  const feeRate = params.feeRate ?? 0.0005;

  if (
    !Number.isFinite(params.initialCapital) ||
    params.initialCapital <= 0 ||
    !Number.isFinite(params.lowerPrice) ||
    params.lowerPrice <= 0 ||
    !Number.isFinite(params.upperPrice) ||
    params.upperPrice <= params.lowerPrice ||
    !Number.isFinite(params.currentPrice) ||
    params.currentPrice <= 0 ||
    !Number.isFinite(params.stopLossPrice) ||
    params.stopLossPrice <= 0 ||
    params.stopLossPrice >= params.currentPrice ||
    !Number.isInteger(params.gridCount) ||
    params.gridCount < 2 ||
    !Number.isFinite(params.leverage) ||
    params.leverage <= 0 ||
    !Number.isFinite(feeRate) ||
    feeRate < 0
  ) {
    return reject("Invalid grid parameters.");
  }

  const tradingRules = await fetchSymbolTradingRules(params.symbol);
  if (tradingRules === undefined) {
    return reject(`Unable to fetch trading rules for symbol ${params.symbol}.`);
  }

  const rangePercentage =
    ((params.upperPrice - params.lowerPrice) / params.lowerPrice) * 100;

  const gridTypeMismatch =
    (params.gridType === "GEOMETRIC" && rangePercentage <= 20) ||
    (params.gridType === "ARITHMETIC" && rangePercentage > 20);

  const grid =
    params.gridType === "ARITHMETIC"
      ? arithmeticGrid(params.lowerPrice, params.upperPrice, params.gridCount)
      : geometricGrid(params.lowerPrice, params.upperPrice, params.gridCount);

  if (grid.length === 0) {
    return reject("Unable to construct a valid grid.", rangePercentage, gridTypeMismatch);
  }

  const filledGrid = grid.filter((price) => price < params.currentPrice);
  const m = filledGrid.length;

  if (m === 0) {
    return reject(
      "No grid buy orders exist below current price.",
      rangePercentage,
      gridTypeMismatch,
    );
  }

  // capitalPerGridUSD dipertahankan sebagai field output (interface tidak
  // berubah) -- tidak lagi dipakai buat hitung quantity, karena mekanisme
  // Futures Grid pakai base-asset qty KONSTAN per level, bukan USD notional
  // konstan per level (itu mekanisme grid Spot).
  const capitalPerGridUSD =
    (params.initialCapital * params.leverage) / params.gridCount;

  // grid_qty: base-asset quantity KONSTAN per order di semua level, sesuai
  // formula resmi Binance Futures Grid ("What Is Futures Grid Trading?").
  // BUY dominan utk Long grid.
  const denom = grid.reduce((sum, price) => {
    const ap = assumingPriceBuy(price);
    const riskTerm =
      params.leverage * Math.abs(Math.min(0, SIDE * (params.currentPrice - price)));
    return sum + ap + riskTerm;
  }, 0);

  const gridQty = (ADJUST_COEF * params.initialCapital * params.leverage) / denom;

  const totalQuantity = gridQty * m;
  const avgEntryPrice = filledGrid.reduce((sum, price) => sum + price, 0) / m;

  // Notional-per-order dicek duluan sebelum margin minimum: gridQty yang
  // gagal minNotional SELALU juga gagal margin minimum (minGridQty di bawah
  // dibangun dari minNotional juga), jadi kalau margin dicek duluan pesan
  // minNotional gak akan pernah kelihatan -- dicek di sini dulu supaya
  // pesan reject paling spesifik (root cause) yang muncul.
  const notionalPerOrder = gridQty * params.lowerPrice;
  if (notionalPerOrder < tradingRules.minNotional) {
    return reject(
      `Notional per grid order ($${notionalPerOrder.toFixed(2)}) is below Binance minimum notional ($${tradingRules.minNotional}). Reduce gridCount or increase initialCapital.`,
      rangePercentage,
      gridTypeMismatch,
    );
  }

  const rawMinGridQty = Math.max(
    tradingRules.minQty,
    tradingRules.minNotional / params.lowerPrice,
  );
  const minGridQty = Math.ceil(rawMinGridQty / tradingRules.stepSize) * tradingRules.stepSize;

  const minInitialMarginDenom = grid.reduce((sum, price) => {
    const riskTerm =
      params.leverage * minGridQty * Math.abs(Math.min(0, SIDE * (params.currentPrice - price)));
    return sum + minGridQty * price + riskTerm;
  }, 0);
  const minInitialMargin = minInitialMarginDenom / (params.leverage * ADJUST_COEF);

  if (params.initialCapital < minInitialMargin) {
    return reject(
      `Initial capital $${params.initialCapital} is below the minimum required for ${params.leverage}x leverage on this grid: needs at least $${minInitialMargin.toFixed(2)}.`,
      rangePercentage,
      gridTypeMismatch,
    );
  }

  const maxExposureSL =
    totalQuantity * (avgEntryPrice - params.stopLossPrice) +
    totalQuantity * params.stopLossPrice * feeRate;

  const stressMultiplier = contextualRisk.stressMultiplier;
  const slippageStressedLoss = Math.max(maxExposureSL, 0) * stressMultiplier;

  const notionalUsd = totalQuantity * avgEntryPrice;
  let mmrBufferPct = estimateMaintenanceMarginBufferPct(marketData.quoteVolumeUsd);
  // Skip signed round-trip when secrets unset (keeps entry-alert path lean).
  if (typeof hasBinanceApiCredentials === "function" && hasBinanceApiCredentials()) {
    const fromBracket = await fetchMaintMarginRatio(params.symbol, notionalUsd);
    if (fromBracket !== undefined) mmrBufferPct = fromBracket;
  }
  const liquidationPrice =
    avgEntryPrice * (1 - 1 / params.leverage + mmrBufferPct);

  const fundingRate = Number.isFinite(marketData.predictedFundingRate)
    ? marketData.predictedFundingRate
    : 0;

  const dailyFundingBleedUSD =
    totalQuantity * avgEntryPrice * fundingRate * 3;

  let rawProfitPerCycleUSD = 0;

  for (let index = 0; index < filledGrid.length; index += 1) {
    const nextGridPrice = grid.find((price) => price > filledGrid[index]);
    if (nextGridPrice !== undefined) {
      rawProfitPerCycleUSD += gridQty * (nextGridPrice - filledGrid[index]);
    }
  }

  const fundingPerCycleUSD = dailyFundingBleedUSD / params.gridCount;
  const netProfitPerCycleUSD = rawProfitPerCycleUSD - fundingPerCycleUSD;
  const minBreakevenCycles =
    netProfitPerCycleUSD > 0
      ? Math.ceil(slippageStressedLoss / netProfitPerCycleUSD)
      : 0;

  const riskPercentage =
    (slippageStressedLoss / params.initialCapital) * 100;

  let status: GridRiskAnalysisResult["status"] = "SAFE";
  let rejectionReason: string | undefined;
  let decisionReason: string | undefined;

  if (
    contextualRisk.marketRegime === "BREAKOUT" &&
    (contextualRisk.priceChangePct ?? 0) < 0
  ) {
    status = "REJECT";
    rejectionReason =
      "Bearish breakout detected: price is breaking down outside the grid regime toward the long-grid stop loss.";
  } else if (liquidationPrice >= params.stopLossPrice) {
    status = "REJECT";
    rejectionReason =
      "Dynamic liquidation price is at or above the configured stop-loss price.";
  } else if (netProfitPerCycleUSD <= 0) {
    status = "REJECT";
    rejectionReason =
      "Net profit per cycle is zero or negative after funding bleed.";
  } else if (
    contextualRisk.marketRegime === "BREAKOUT" &&
    (contextualRisk.priceChangePct ?? 0) > 0
  ) {
    status = "HIGH_RISK";
    decisionReason =
      "Bullish breakout detected: capital is directionally safer, but the grid range has been exceeded and grid harvesting is ineffective.";
  } else if (riskPercentage > 15 || minBreakevenCycles > 75) {
    status = "HIGH_RISK";
  } else if (riskPercentage > 5 || minBreakevenCycles > 35) {
    status = "MODERATE";
  }

  if (gridTypeMismatch && status === "SAFE") {
    status = "MODERATE";
    decisionReason =
      "Grid type is mismatched with the configured range threshold; review grid construction before deployment.";
  }

  return {
    avgEntryPrice: round(avgEntryPrice),
    totalQuantity: round(totalQuantity),
    capitalPerGridUSD: round(capitalPerGridUSD),
    maxExposureSL: round(maxExposureSL),
    slippageStressedLoss: round(slippageStressedLoss),
    stressMultiplier,
    liquidationPrice: round(liquidationPrice),
    dailyFundingBleedUSD: round(dailyFundingBleedUSD),
    rawProfitPerCycleUSD: round(rawProfitPerCycleUSD),
    netProfitPerCycleUSD: round(netProfitPerCycleUSD),
    minBreakevenCycles,
    riskPercentage: round(riskPercentage, 4),
    rangePercentage: round(rangePercentage, 4),
    filledGridCount: m,
    gridTypeMismatch,
    status,
    ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    ...(decisionReason !== undefined ? { decisionReason } : {}),
  };
}

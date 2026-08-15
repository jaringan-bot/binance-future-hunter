import type { BinanceMarketData } from "./binanceFetcher.js";

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
}

function arithmeticGrid(lower: number, upper: number, count: number): number[] {
  const step = (upper - lower) / (count - 1);
  return Array.from({ length: count }, (_, index) => lower + step * index);
}

function geometricGrid(lower: number, upper: number, count: number): number[] {
  if (lower <= 0 || upper <= 0) return [];
  const ratio = (upper / lower) ** (1 / (count - 1));
  return Array.from({ length: count }, (_, index) => lower * ratio ** index);
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

export function calculateGridRisk(
  params: GridInputParams,
  marketData: BinanceMarketData,
): GridRiskAnalysisResult {
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

  const capitalPerGridUSD =
    (params.initialCapital * params.leverage) / params.gridCount;

  const quantities = filledGrid.map((price) => capitalPerGridUSD / price);
  const totalQuantity = quantities.reduce((sum, quantity) => sum + quantity, 0);
  const avgEntryPrice = (capitalPerGridUSD * m) / totalQuantity;

  const maxExposureSL =
    totalQuantity * (avgEntryPrice - params.stopLossPrice) +
    totalQuantity * params.stopLossPrice * feeRate;

  const slippageStressedLoss = Math.max(maxExposureSL, 0) * 1.15;

  const liquidationPrice =
    avgEntryPrice * (1 - 1 / params.leverage + 0.005);

  const fundingRate = Number.isFinite(marketData.predictedFundingRate)
    ? marketData.predictedFundingRate
    : 0;

  const dailyFundingBleedUSD =
    totalQuantity * avgEntryPrice * fundingRate * 3;

  let rawProfitPerCycleUSD = 0;

  for (let index = 0; index < filledGrid.length; index += 1) {
    const nextGridPrice = grid.find((price) => price > filledGrid[index]);
    if (nextGridPrice !== undefined) {
      rawProfitPerCycleUSD +=
        quantities[index] * (nextGridPrice - filledGrid[index]);
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

  if (liquidationPrice >= params.stopLossPrice) {
    status = "REJECT";
    rejectionReason =
      "Dynamic liquidation price is at or above the configured stop-loss price.";
  } else if (netProfitPerCycleUSD <= 0) {
    status = "REJECT";
    rejectionReason =
      "Net profit per cycle is zero or negative after funding bleed.";
  } else if (riskPercentage > 15 || minBreakevenCycles > 75) {
    status = "HIGH_RISK";
  } else if (riskPercentage > 5 || minBreakevenCycles > 35) {
    status = "MODERATE";
  }

  return {
    avgEntryPrice: round(avgEntryPrice),
    totalQuantity: round(totalQuantity),
    capitalPerGridUSD: round(capitalPerGridUSD),
    maxExposureSL: round(maxExposureSL),
    slippageStressedLoss: round(slippageStressedLoss),
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
  };
}

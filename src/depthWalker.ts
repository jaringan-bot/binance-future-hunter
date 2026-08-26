// Jalan-kan order book depth ke target notional/harga -- dipakai
// estimate_slippage (target notional) dan estimate_stop_loss_liquidity_risk
// (target harga stop-loss). Sebelum ini logic serupa terduplikasi 2x
// (fullPipeline.ts orderBookBidDepthSL, binanceFetcher.ts fetchSymbolTradingRules
// area) tapi keduanya cuma LONG-only dan cuma jumlah notional (bukan avg
// fill price) -- helper ini generalisasi keduanya, dipakai tool BARU, TIDAK
// menggantikan 2 implementasi lama itu (di luar scope task ini).
export type DepthSide = "BUY" | "SELL";

export interface DepthWalkTarget {
  side: DepthSide;
  targetNotionalUsd: number;
  depth: [string, string][];
}

export interface SlippageWalkResult {
  bestPrice: number;
  avgFillPrice: number;
  filledNotionalUsd: number;
  filledQty: number;
  slippagePct: number;
  impactCostUsd: number;
  partialFill: boolean;
  errorCode?: "EMPTY_DEPTH" | "INVALID_BEST_PRICE" | "ZERO_FILL";
}

const EMPTY_SLIPPAGE_RESULT: Omit<SlippageWalkResult, "errorCode"> = {
  bestPrice: 0,
  avgFillPrice: 0,
  filledNotionalUsd: 0,
  filledQty: 0,
  slippagePct: 0,
  impactCostUsd: 0,
  partialFill: false,
};

export function walkDepthForNotional(params: DepthWalkTarget): SlippageWalkResult {
  const { side, targetNotionalUsd, depth } = params;

  if (depth.length === 0) {
    return { ...EMPTY_SLIPPAGE_RESULT, errorCode: "EMPTY_DEPTH" };
  }

  const bestPrice = parseFloat(depth[0][0]);
  if (!Number.isFinite(bestPrice) || bestPrice <= 0) {
    return { ...EMPTY_SLIPPAGE_RESULT, errorCode: "INVALID_BEST_PRICE" };
  }

  let filledNotionalUsd = 0;
  let filledQty = 0;
  let partialFill = false;

  for (const [priceStr, qtyStr] of depth) {
    if (filledNotionalUsd >= targetNotionalUsd) break;
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;

    const levelNotional = price * qty;
    const remaining = targetNotionalUsd - filledNotionalUsd;

    if (levelNotional <= remaining) {
      filledNotionalUsd += levelNotional;
      filledQty += qty;
    } else {
      const partialQty = remaining / price;
      filledNotionalUsd += remaining;
      filledQty += partialQty;
    }
  }

  if (filledNotionalUsd < targetNotionalUsd) partialFill = true;

  if (filledQty === 0) {
    return { ...EMPTY_SLIPPAGE_RESULT, bestPrice, errorCode: "ZERO_FILL" };
  }

  const avgFillPrice = filledNotionalUsd / filledQty;
  const slippagePct =
    side === "BUY" ? ((avgFillPrice - bestPrice) / bestPrice) * 100 : ((bestPrice - avgFillPrice) / bestPrice) * 100;
  const impactCostUsd = Math.abs(avgFillPrice - bestPrice) * filledQty;

  return { bestPrice, avgFillPrice, filledNotionalUsd, filledQty, slippagePct, impactCostUsd, partialFill };
}

export type PositionSide = "LONG" | "SHORT";

export interface StopLossWalkParams {
  positionSide: PositionSide;
  currentPrice: number;
  stopLossPrice: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface StopLossWalkResult {
  notionalUsd: number;
  levelsWalked: number;
  rejected: boolean;
  errorCode?: "INVALID_SL_ORDERING_LONG" | "INVALID_SL_ORDERING_SHORT";
}

export function walkDepthToStopLoss(params: StopLossWalkParams): StopLossWalkResult {
  const { positionSide, currentPrice, stopLossPrice, bids, asks } = params;

  if (positionSide === "LONG") {
    if (stopLossPrice >= currentPrice) {
      return { notionalUsd: 0, levelsWalked: 0, rejected: true, errorCode: "INVALID_SL_ORDERING_LONG" };
    }
    let notionalUsd = 0;
    let levelsWalked = 0;
    for (const [priceStr, qtyStr] of bids) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
      if (price < stopLossPrice) break;
      notionalUsd += price * qty;
      levelsWalked += 1;
    }
    return { notionalUsd, levelsWalked, rejected: false };
  }

  // SHORT
  if (stopLossPrice <= currentPrice) {
    return { notionalUsd: 0, levelsWalked: 0, rejected: true, errorCode: "INVALID_SL_ORDERING_SHORT" };
  }
  let notionalUsd = 0;
  let levelsWalked = 0;
  for (const [priceStr, qtyStr] of asks) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
    if (price > stopLossPrice) break;
    notionalUsd += price * qty;
    levelsWalked += 1;
  }
  return { notionalUsd, levelsWalked, rejected: false };
}

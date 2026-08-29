import * as binanceProxy from "./binanceProxyClient.js";
import {
  computeCvdFromTrades,
  summarizeKlines,
  calculateADX,
  type KlineCandle,
} from "./toolHelpers.js";
import { classifyRegime, type MarketRegime } from "./tools/marketRegime.js";

export interface GridContextualRisk {
  contextAvailable: boolean;
  marketRegime: MarketRegime | "REGIME_UNAVAILABLE";
  regimeConfidence: number;
  volatilitySpikeRatio: number | null;
  adx: number | null;
  priceChangePct: number | null;
  topTraderLongPct: number | null;
  topTraderShortPct: number | null;
  topTraderRatio: number | null;
  oiChangePct: number | null;
  oiDivergence: boolean;
  longSqueezeRisk: boolean;
  stressMultiplier: 1.15 | 1.25;
}

export const FALLBACK_CONTEXT: GridContextualRisk = {
  contextAvailable: false,
  marketRegime: "REGIME_UNAVAILABLE",
  regimeConfidence: 0,
  volatilitySpikeRatio: null,
  adx: null,
  priceChangePct: null,
  topTraderLongPct: null,
  topTraderShortPct: null,
  topTraderRatio: null,
  oiChangePct: null,
  oiDivergence: false,
  longSqueezeRisk: false,
  stressMultiplier: 1.15,
};

const CONTEXT_TIMEOUT_MS = 1_500;

// Data mentah yang dibutuhkan fetchMarketContext -- kalau caller sudah
// punya semuanya (mis. fullPipeline.ts Wave 1 + Wave 2 sudah fetch
// klines1h/OI/oiHist/aggTrades/topTrader untuk keperluan lain), dioper ke
// sini supaya TIDAK di-fetch ulang. Menghemat 5 subrequest per symbol.
// klines1h harus >= 21 bar (idealnya >= 40, sama seperti fetch internal
// lama limit=40) supaya window ADX/volatility valid.
export interface MarketContextInputs {
  klines1h: binanceProxy.KlineTuple[];
  oiCurrent: Awaited<ReturnType<typeof binanceProxy.getOpenInterestNative>>;
  oiHist2: Awaited<ReturnType<typeof binanceProxy.getOpenInterestHistNative>>;
  aggTrades: Awaited<ReturnType<typeof binanceProxy.getAggTrades>>;
  topTrader: Awaited<ReturnType<typeof binanceProxy.getTopTraderPositionRatio>>;
}

function realizedVolPct(candles: KlineCandle[]): number {
  const closes = candles.map((candle) => candle.close);
  const periodsPerYear = 24 * 365;
  const returns = closes.slice(1).map((close, index) => {
    const previous = closes[index];
    return previous > 0 ? Math.log(close / previous) : 0;
  });

  if (returns.length < 2) return 0;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);

  return Math.sqrt(Math.max(variance, 0) * periodsPerYear) * 100;
}

export async function fetchMarketContext(
  symbol: string,
  inputs?: MarketContextInputs,
): Promise<GridContextualRisk> {
  const formattedSymbol = symbol.trim().toUpperCase().replace("/", "");

  try {
    let rawKlines1h: MarketContextInputs["klines1h"];
    let rawOiCurrent: MarketContextInputs["oiCurrent"];
    let rawOiHist2: MarketContextInputs["oiHist2"];
    let rawAggTrades: MarketContextInputs["aggTrades"];
    let rawTopTrader: MarketContextInputs["topTrader"];

    if (inputs) {
      // Jalur prefetched -- TIDAK ada subrequest ke proxy. Caller
      // (fullPipeline.ts) sudah punya kelima data ini dari Wave 1 + Wave 2.
      ({
        klines1h: rawKlines1h,
        oiCurrent: rawOiCurrent,
        oiHist2: rawOiHist2,
        aggTrades: rawAggTrades,
        topTrader: rawTopTrader,
      } = inputs);
    } else {
      const contextPromise = Promise.allSettled([
        binanceProxy.getKlinesNative(formattedSymbol, "1h", 40),
        binanceProxy.getOpenInterestNative(formattedSymbol),
        binanceProxy.getOpenInterestHistNative(formattedSymbol, "1h", 2),
        binanceProxy.getAggTrades(formattedSymbol, 100),
        binanceProxy.getTopTraderPositionRatio(formattedSymbol, "1h", 1),
      ]);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Market context timeout")), CONTEXT_TIMEOUT_MS);
      });

      const results = await Promise.race([contextPromise, timeoutPromise]);
      const [klinesResult, oiCurrentResult, oiHistoryResult, tradesResult, topTraderResult] = results;

      if (
        klinesResult.status !== "fulfilled" ||
        oiCurrentResult.status !== "fulfilled" ||
        oiHistoryResult.status !== "fulfilled" ||
        tradesResult.status !== "fulfilled" ||
        topTraderResult.status !== "fulfilled"
      ) {
        return FALLBACK_CONTEXT;
      }
      rawKlines1h = klinesResult.value;
      rawOiCurrent = oiCurrentResult.value;
      rawOiHist2 = oiHistoryResult.value;
      rawAggTrades = tradesResult.value;
      rawTopTrader = topTraderResult.value;
    }

    const { candles } = summarizeKlines(rawKlines1h);
    if (candles.length < 21 || rawTopTrader.length === 0) {
      return FALLBACK_CONTEXT;
    }

    const adxResult = calculateADX(candles, 14);
    const recentCandles = candles.slice(-10);
    const priorCandles = candles.slice(-20, -10);
    const { changePct: priceChangePct } = summarizeKlines(rawKlines1h.slice(-10));

    const recentVol = realizedVolPct(recentCandles);
    const priorVol = realizedVolPct(priorCandles);
    const volatilitySpikeRatio =
      priorVol > 0 ? recentVol / priorVol : recentVol > 0 ? 2 : 1;

    const lastCandle = candles[candles.length - 1];
    const priorVolumeAvg =
      priorCandles.reduce((sum, candle) => sum + candle.volume, 0) /
      Math.max(priorCandles.length, 1);
    const volumeSpikeRatio =
      priorVolumeAvg > 0 ? lastCandle.volume / priorVolumeAvg : 1;

    const oiCurrent = Number(rawOiCurrent.openInterest);
    const oiPrevious = Number(
      rawOiHist2[0]?.sumOpenInterest ?? String(oiCurrent),
    );
    const oiChangePct =
      Number.isFinite(oiCurrent) && Number.isFinite(oiPrevious) && oiPrevious !== 0
        ? ((oiCurrent - oiPrevious) / oiPrevious) * 100
        : 0;

    const cvd = computeCvdFromTrades(rawAggTrades);
    const regime = classifyRegime({
      adx: adxResult.adx,
      plusDI: adxResult.plusDI,
      minusDI: adxResult.minusDI,
      oiChangePct,
      priceChangePct,
      cvdBuyPct: cvd.buyPct,
      volatilitySpikeRatio,
      volumeSpikeRatio,
    });

    const latestTopTrader = rawTopTrader[rawTopTrader.length - 1];
    const topTraderLongPct = Number(latestTopTrader.longAccount) * 100;
    const topTraderShortPct = Number(latestTopTrader.shortAccount) * 100;
    const topTraderRatio = Number(latestTopTrader.longShortRatio);

    const isOiSurge = oiChangePct > 3;
    const isWhaleShort = topTraderShortPct > topTraderLongPct;
    const longSqueezeRisk = isOiSurge && isWhaleShort;

    return {
      contextAvailable: true,
      marketRegime: regime.regime,
      regimeConfidence: regime.confidence,
      volatilitySpikeRatio: Number.isFinite(volatilitySpikeRatio)
        ? volatilitySpikeRatio
        : null,
      adx: Number.isFinite(adxResult.adx) ? adxResult.adx : null,
      priceChangePct: Number.isFinite(priceChangePct) ? priceChangePct : null,
      topTraderLongPct: Number.isFinite(topTraderLongPct) ? topTraderLongPct : null,
      topTraderShortPct: Number.isFinite(topTraderShortPct) ? topTraderShortPct : null,
      topTraderRatio: Number.isFinite(topTraderRatio) ? topTraderRatio : null,
      oiChangePct: Number.isFinite(oiChangePct) ? oiChangePct : null,
      oiDivergence: longSqueezeRisk,
      longSqueezeRisk,
      stressMultiplier: longSqueezeRisk ? 1.25 : 1.15,
    };
  } catch {
    return FALLBACK_CONTEXT;
  }
}

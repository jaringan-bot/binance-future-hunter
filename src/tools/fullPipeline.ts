// whalescope_full_pipeline -- tool composite tertinggi di WhaleScope MCP:
// gantikan ~8 tool call manual (regime, funding, smart money, MM detection,
// order book, grid risk, dst.) + kalkulasi manual bound grid, jadi SATU tool
// call yang menjalankan seluruh decision chain per symbol (bisa banyak
// symbol sekaligus): hard screen -> Tier-1 intelligence -> grid bound
// (Compass-equivalent) -> risk sizing ke budget rugi tetap -> keputusan
// TRADE/WATCH/NO_TRADE, plus parameter Grid Bot siap-copy-paste.
//
// ARSITEKTUR: thin MCP wrapper di atas 3 pure engine (gridBoundEngine.ts,
// pipelineEngine.ts) + import LANGSUNG fungsi murni dari tool lain
// (detectMmActivity.ts, marketRegime.ts, smartMoneyAnalysis.ts,
// gridRiskEngine.ts) -- BUKAN manggil tool-tool itu sebagai black box lewat
// MCP roundtrip, supaya fetch bisa di-orkestrasi ulang jadi 2 wave hemat call
// (lihat komentar runPipelineForSymbol di bawah). Tidak ada logic 23 tool
// lain yang diduplikasi -- semua reuse impor langsung.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";
import { symbolSchema, errorResult } from "../shared.js";
import { computeCvdFromTrades, summarizeKlines, calculateADX, type KlineCandle } from "../toolHelpers.js";
import { classifyRegime, type MarketRegime, type RegimeResult } from "./marketRegime.js";
import { analyzeSmartMoneyDivergence, type MarketStructureCondition } from "../smartMoneyAnalysis.js";
import {
  calculateAbsorptionScore,
  calculateSpoofingScore,
  calculateStopHuntScore,
  calculateBasisArbScore,
  calculateOiDivergenceScore,
  calculateFundingExtremeScore,
  classifyTier,
  type MmSignals,
  type MmTier,
} from "./detectMmActivity.js";
import { getPairThreshold } from "./config.js";
import { computeGridBounds, type GridBoundResult, type GridBoundOptions } from "../gridBoundEngine.js";
import {
  evaluateHardScreen,
  scoreTier1Signals,
  scaleCapitalForTargetLoss,
  decidePipelineOutcome,
  type HardScreenInput,
  type Tier1ScoreInput,
} from "../pipelineEngine.js";
import { calculateGridRisk, type GridInputParams, type GridRiskAnalysisResult } from "../gridRiskEngine.js";
import type { BinanceMarketData } from "../binanceFetcher.js";
import { fetchMarketContext, type GridContextualRisk } from "../marketContext.js";
import { mapWithConcurrency } from "../concurrency.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtPrice } from "../format.js";

const REFERENCE_CAPITAL = 1000;

// Mirror PERSIS nilai default private DEFAULT_FUNDING_THRESHOLD/
// DEFAULT_BASIS_THRESHOLD di detectMmActivity.ts (tidak diekspor dari sana,
// jadi didefinisikan ulang di sini -- cuma 2 angka literal, bukan duplikasi
// logic) supaya calculateBasisArbScore/calculateFundingExtremeScore dapat
// fallback yang sama persis dengan binance_detect_mm_activity kalau
// getPairThreshold() tidak punya override.
const DEFAULT_FUNDING_THRESHOLD = 0.0003;
const DEFAULT_BASIS_THRESHOLD = 0.0005;

// Mirror nilai private REGIME_MIN_CANDLES di marketRegime.ts (tidak
// diekspor) -- jumlah candle minimum supaya classifyRegime() dapat window
// recent(10)/prior(10) yang valid.
const REGIME_MIN_CANDLES = 21;

const MARGIN_MODE_CAVEAT =
  "GridInputParams (gridRiskEngine.ts) tidak punya field margin-mode -- semua perhitungan likuidasi/risiko di " +
  "sini APPROXIMATE ala isolated margin, terlepas dari margin_mode yang diminta (ISOLATED atau CROSSED). Untuk " +
  "CROSSED margin riil, likuidasi bergantung pada TOTAL saldo akun (bukan cuma capital yang dialokasikan ke " +
  "grid ini) -- lihat docs/full_pipeline_framework.md bagian Known Limitations.";

// ─────────────────────────────────────────────────────────────
// TYPES -- bentuk output structuredContent per symbol.
// ─────────────────────────────────────────────────────────────
export type PipelineDecision = "TRADE" | "WATCH" | "NO_TRADE";

export interface HardScreenSection {
  passed: boolean;
  reasons: string[];
  quoteVolumeUsd: number;
  fundingRate: number;
  regime1h: MarketRegime;
  regime4h: MarketRegime;
}

export interface Tier1Section {
  smartMoney: {
    condition: MarketStructureCondition;
    smartMoneyBias: string;
    retailSentiment: string;
    confidenceScore: number;
    divergenceScore: number;
  };
  mm: { totalScore: number; tier: MmTier; activeSignals: string[] };
  obi: { depth5: number; depth10: number; depth20: number };
  cvd: { buyPct: number; cvd: number };
  oi: { changePct: number };
  regime1h: RegimeResult;
  regime4h: RegimeResult;
}

export interface LeverageEvaluation {
  leverage: number;
  referenceStatus: GridRiskAnalysisResult["status"];
  referenceSlippageStressedLoss: number;
  referenceRejectionReason?: string;
  finalRun: GridRiskAnalysisResult | null;
  initialCapitalSolved: number | null;
  chosen: boolean;
}

export interface RiskSection {
  chosenLeverage: number | null;
  initialCapitalSolved: number | null;
  evaluatedLeverages: LeverageEvaluation[];
  gridRisk: GridRiskAnalysisResult | null;
}

export interface GridBotConfigSection {
  lower: number;
  upper: number;
  gridCount: number;
  gridType: "ARITHMETIC" | "GEOMETRIC";
  leverage: number | null;
  marginMode: "ISOLATED" | "CROSSED";
  stopLoss: number;
  takeProfit: number;
  marginModeCaveat: string;
}

export interface SymbolPipelineResult {
  symbol: string;
  decision: PipelineDecision;
  rankingScore: number;
  hardScreen: HardScreenSection;
  tier1?: Tier1Section;
  gridSetup?: GridBoundResult;
  risk?: RiskSection;
  gridBotConfig?: GridBotConfigSection;
  reasoning: string[];
  error?: string;
}

export interface PipelineOpts {
  riskUsd: number;
  marginMode: "ISOLATED" | "CROSSED";
  maxLeverageOptions: number[];
  lookbackBars: number;
  atrPeriod: number;
  atrMult: number;
  slExtraAtr: number;
  slPctBuffer: number;
  tpAtrMult?: number;
  minQuoteVolumeUsd: number;
  maxAbsFundingRate: number;
}

// ─────────────────────────────────────────────────────────────
// HELPER: hitung RegimeResult dari 1 set klines mentah + oiChangePct/cvdBuyPct
// yang SUDAH dihitung (reuse, bukan fetch baru) -- mereplikasi PERSIS resep
// binance_market_regime (marketRegime.ts:156-186): ADX(14) dari klines,
// window recent-10/prior-10 buat volatility & volume spike ratio.
//
// CATATAN PENTING (Known Limitation, lihat docs/full_pipeline_framework.md):
// regime4h di pipeline ini REUSE oiChangePct/cvdBuyPct dari fetch Wave-1
// yang SAMA dipakai regime1h (bukan fetch OI/CVD kedua yang timeframe-
// spesifik) -- cuma bagian yang benar-benar 4h-spesifik (ADX, volatility-
// spike, volume-spike dari candle 4h) yang independen. Ini beda dari
// manggil binance_market_regime dua kali manual (yang masing-masing
// re-fetch OI/CVD sendiri) -- efisiensi sengaja karena pipeline ini SATU
// composite tool call, bukan bug.
// ─────────────────────────────────────────────────────────────
function realizedVolPct(candles: KlineCandle[]): number {
  // Duplikat kecil dari helper privat marketRegime.ts (tidak diekspor) --
  // cuma memanggil computeRealizedVolatility (shared.ts) dengan anualisasi
  // 24*365 yang sama, bukan reimplementasi logic baru.
  const closes = candles.map((c) => c.close);
  const periodsPerYear = 24 * 365;
  if (closes.length < 2) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  const sumSq = logReturns.reduce((acc, r) => acc + r * r, 0);
  const periodVol = Math.sqrt(sumSq / logReturns.length);
  return periodVol * Math.sqrt(periodsPerYear) * 100;
}

function computeRegimeFromKlines(klines: KlineTuple[], oiChangePct: number, cvdBuyPct: number): RegimeResult {
  const { candles } = summarizeKlines(klines);
  const adxResult = calculateADX(candles, 14);
  const recentCandles = candles.slice(-10);
  const priorCandles = candles.slice(-20, -10);
  const { changePct: priceChangePct } = summarizeKlines(klines.slice(-10));

  const recentVol = realizedVolPct(recentCandles);
  const priorVol = realizedVolPct(priorCandles);
  const volatilitySpikeRatio = priorVol > 0 ? recentVol / priorVol : recentVol > 0 ? 2 : 1;

  const lastCandle = candles[candles.length - 1];
  const priorVolumeAvg = priorCandles.reduce((sum, c) => sum + c.volume, 0) / (priorCandles.length || 1);
  const volumeSpikeRatio = priorVolumeAvg > 0 && lastCandle ? lastCandle.volume / priorVolumeAvg : 1;

  return classifyRegime({
    adx: adxResult.adx,
    plusDI: adxResult.plusDI,
    minusDI: adxResult.minusDI,
    oiChangePct,
    priceChangePct,
    cvdBuyPct,
    volatilitySpikeRatio,
    volumeSpikeRatio,
  });
}

function safeComputeRegime(klines: KlineTuple[], oiChangePct: number, cvdBuyPct: number): RegimeResult {
  const { candles } = summarizeKlines(klines);
  if (candles.length < REGIME_MIN_CANDLES) {
    return {
      regime: "RANGING",
      confidence: 0,
      reason: `Data klines tidak cukup untuk analisis regime (dapat ${candles.length}, butuh minimal ${REGIME_MIN_CANDLES}) -- fallback RANGING confidence 0, JANGAN dibaca sebagai sinyal ranging sungguhan.`,
    };
  }
  return computeRegimeFromKlines(klines, oiChangePct, cvdBuyPct);
}

function obiAtDepth(orderBook: binanceProxy.OrderBookDepth, depth: number): number {
  const bidVol = orderBook.bids.slice(0, depth).reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const askVol = orderBook.asks.slice(0, depth).reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const total = bidVol + askVol;
  return total > 0 ? (bidVol / total) * 100 : 50;
}

/**
 * runPipelineForSymbol() -- seluruh decision chain untuk SATU symbol, 2-wave
 * fetch orchestration:
 *
 * WAVE 1 (paralel): ticker24hr, funding rate, klines 1h (limit=max(lookback,40)),
 * klines 4h (limit=40), open interest + histori 1h (limit=2), agg trades
 * (limit=100), fetchMarketContext() (proxy-safe, timeout sendiri). Dari sini
 * dihitung regime1h/regime4h -> evaluateHardScreen(). GAGAL DI SINI = LANGSUNG
 * short-circuit ke NO_TRADE, WAVE 2 TIDAK PERNAH DIPANGGIL -- inilah "reject
 * early" yang benar-benar menghemat call proxy untuk symbol yang jelas tidak
 * layak (volume kurang, funding ekstrem, kondisi breakout).
 *
 * WAVE 2 (paralel, cuma untuk survivor Wave 1): top-trader position ratio,
 * global account ratio, OI histori 24 titik (buat delta 4 jam smart money),
 * order book depth 50 (dipakai ULANG buat OBI-5/10/20 DAN orderBookBidDepthSL
 * grid-risk DAN orderbook-imbalance smart-money -- satu fetch, tiga
 * pemakaian), threshold custom KV, spot price (try/catch, banyak pair
 * futures-only tidak listed spot). Dari sini: analyzeSmartMoneyDivergence(),
 * 6 skor MM murni (detectMmActivity.ts), scoreTier1Signals(),
 * computeGridBounds() (gridBoundEngine.ts, dari klines 1h Wave 1), lalu loop
 * leverage (descending) dengan capital-solve exact (pipelineEngine.ts) ke
 * calculateGridRisk() (gridRiskEngine.ts, self-assembled BinanceMarketData --
 * BUKAN fetchBinanceMarketData() yang bypass proxy dan diblokir WAF Binance).
 *
 * Seluruh badan fungsi dibungkus try/catch -- satu symbol gagal TIDAK PERNAH
 * throw ke pemanggil, cuma balik { decision: "NO_TRADE", error }.
 */
export async function runPipelineForSymbol(symbol: string, opts: PipelineOpts): Promise<SymbolPipelineResult> {
  const preHardScreenNotes: string[] = [];

  try {
    const klineLimit = Math.max(opts.lookbackBars, 40);

    const [tickerResult, funding, klines1h, klines4h, oiCurrent, oiHist2, aggTrades, contextualRisk] = await Promise.all([
      binanceProxy.getTicker24hrNative(symbol).catch(() => null),
      binanceProxy.getCurrentFundingRateNative(symbol),
      binanceProxy.getKlinesNative(symbol, "1h", klineLimit),
      binanceProxy.getKlinesNative(symbol, "4h", 40),
      binanceProxy.getOpenInterestNative(symbol),
      binanceProxy.getOpenInterestHistNative(symbol, "1h", 2),
      binanceProxy.getAggTrades(symbol, 100),
      fetchMarketContext(symbol),
    ]);

    // "not tradable" DIDERIVASI dari ticker24hr, BUKAN fetch exchangeInfo
    // status terpisah -- lihat JSDoc HardScreenInput.tradable di pipelineEngine.ts.
    const lastPrice = tickerResult ? parseFloat(tickerResult.lastPrice) : NaN;
    const quoteVolumeUsdRaw = tickerResult ? parseFloat(tickerResult.quoteVolume) : NaN;
    const tradable = tickerResult !== null && Number.isFinite(lastPrice) && lastPrice > 0 && Number.isFinite(quoteVolumeUsdRaw);
    const quoteVolumeUsd = Number.isFinite(quoteVolumeUsdRaw) ? quoteVolumeUsdRaw : 0;

    const markPrice = parseFloat(funding.markPrice);
    const fundingRate = Number.isFinite(parseFloat(funding.lastFundingRate)) ? parseFloat(funding.lastFundingRate) : 0;

    const { candles: candles1h, lastClose: lastClose1h } = summarizeKlines(klines1h);
    const currentPrice =
      Number.isFinite(markPrice) && markPrice > 0
        ? markPrice
        : Number.isFinite(lastPrice) && lastPrice > 0
          ? lastPrice
          : lastClose1h;

    const oiCurrentVal = parseFloat(oiCurrent.openInterest);
    const oiPrevVal = parseFloat(oiHist2[0]?.sumOpenInterest ?? String(oiCurrentVal));
    const oiChangePct = oiPrevVal !== 0 ? ((oiCurrentVal - oiPrevVal) / oiPrevVal) * 100 : 0;

    const cvd = computeCvdFromTrades(aggTrades);

    const regime1h = safeComputeRegime(klines1h, oiChangePct, cvd.buyPct);
    const regime4h = safeComputeRegime(klines4h, oiChangePct, cvd.buyPct);

    const hardScreenInput: HardScreenInput = {
      tradable,
      quoteVolumeUsd,
      minQuoteVolumeUsd: opts.minQuoteVolumeUsd,
      fundingRate,
      maxAbsFundingRate: opts.maxAbsFundingRate,
      regime1h: regime1h.regime,
      regime4h: regime4h.regime,
    };
    const hardScreen = evaluateHardScreen(hardScreenInput);

    const hardScreenSection: HardScreenSection = {
      passed: hardScreen.passed,
      reasons: hardScreen.reasons,
      quoteVolumeUsd,
      fundingRate,
      regime1h: regime1h.regime,
      regime4h: regime4h.regime,
    };

    if (!hardScreen.passed) {
      const outcome = decidePipelineOutcome({
        hardScreenPassed: false,
        hardScreenReasons: hardScreen.reasons,
        rankingScore: 0,
        gridRiskStatus: "REJECT",
      });
      return {
        symbol,
        decision: outcome.decision,
        rankingScore: 0,
        hardScreen: hardScreenSection,
        reasoning: outcome.reasoning,
      };
    }

    // ─── WAVE 2 (survivor only) ───
    const [topTrader, globalRatio, oiHist24, orderBook, threshold, spotPriceResult] = await Promise.all([
      binanceProxy.getTopTraderPositionRatio(symbol, "1h", 1),
      binanceProxy.getGlobalAccountRatio(symbol, "1h", 1),
      binanceProxy.getOpenInterestHistNative(symbol, "1h", 24),
      binanceProxy.getOrderBookDepth(symbol, 50),
      getPairThreshold(symbol),
      binanceProxy.getSpotPrice(symbol).catch(() => null),
    ]);

    const topTraderLatest = topTrader[topTrader.length - 1];
    const globalLatest = globalRatio[globalRatio.length - 1];
    if (!topTraderLatest || !globalLatest) {
      preHardScreenNotes.push(
        `Data top trader / global account ratio tidak tersedia untuk ${symbol} -- smart money divergence dihitung dengan fallback netral (ratio=1), tier lain tetap dipakai apa adanya.`,
      );
    }
    const topTraderPositionRatio = topTraderLatest ? parseFloat(topTraderLatest.longShortRatio) : 1;
    const globalAccountRatio = globalLatest ? parseFloat(globalLatest.longShortRatio) : 1;

    const oiValuesWave2 = oiHist24.map((p) => parseFloat(p.sumOpenInterest));
    const oiDelta4hPct =
      oiValuesWave2.length >= 5 && oiValuesWave2[oiValuesWave2.length - 5] !== 0
        ? ((oiValuesWave2[oiValuesWave2.length - 1] - oiValuesWave2[oiValuesWave2.length - 5]) / oiValuesWave2[oiValuesWave2.length - 5]) * 100
        : 0;

    const obi = { depth5: obiAtDepth(orderBook, 5), depth10: obiAtDepth(orderBook, 10), depth20: obiAtDepth(orderBook, 20) };

    const { bias: priceBias24h } = summarizeKlines(klines1h.slice(-24));

    const smartMoney = analyzeSmartMoneyDivergence({
      topTraderPositionRatio,
      globalAccountRatio,
      oiDeltaPct: oiDelta4hPct,
      fundingRate,
      orderBookImbalancePct: obi.depth20,
      priceBias: priceBias24h,
    });

    // 6 skor MM murni (detectMmActivity.ts) -- REUSE cvd/oiChangePct dari
    // Wave 1 dan klines 1h Wave 1 (slice 20 candle terakhir, sama seperti
    // computeMmSignals() fetch 20x1h sendiri), BUKAN fetch baru.
    const spotPrice = spotPriceResult ? parseFloat(spotPriceResult.price) : null;
    const basis = spotPrice !== null && spotPrice !== 0 ? (markPrice - spotPrice) / spotPrice : 0;

    const window20 = summarizeKlines(klines1h.slice(-20));
    const lastCandleMm = window20.candles[window20.candles.length - 1];
    const prevCandleMm = window20.candles[window20.candles.length - 2];

    const bestBidQty = orderBook.bids[0] ? parseFloat(orderBook.bids[0][1]) : 0;
    const bestAskQty = orderBook.asks[0] ? parseFloat(orderBook.asks[0][1]) : 0;
    const bestBidPrice = orderBook.bids[0] ? parseFloat(orderBook.bids[0][0]) : 0;
    const bestAskPrice = orderBook.asks[0] ? parseFloat(orderBook.asks[0][0]) : 0;
    const spreadPct = bestBidPrice > 0 ? ((bestAskPrice - bestBidPrice) / bestBidPrice) * 100 : 0;
    const volume24h = tickerResult ? parseFloat(tickerResult.volume) : 0;

    const mmSignals: MmSignals = {
      absorption: calculateAbsorptionScore({ cvdBuyPct: cvd.buyPct, priceChangePct: window20.changePct, oiChangePct }),
      spoofing: calculateSpoofingScore({ bestBidQty, bestAskQty, spreadPct, volume24h }),
      stopHunt:
        lastCandleMm && prevCandleMm
          ? calculateStopHuntScore({
              high: lastCandleMm.high,
              low: lastCandleMm.low,
              open: lastCandleMm.open,
              close: lastCandleMm.close,
              prevOpen: prevCandleMm.open,
              prevClose: prevCandleMm.close,
            })
          : { score: 0.1, evidence: "Candle tidak cukup untuk analisis stop-hunt." },
      basisArb: calculateBasisArbScore({
        basis,
        fundingRate,
        threshold: threshold?.basisThreshold ?? DEFAULT_BASIS_THRESHOLD,
        // basisZScore SENGAJA selalu undefined -- skip cabang D1 watchlist
        // z-score, selalu fallback simple-threshold (spec MVP simplification,
        // didokumentasikan di docs/full_pipeline_framework.md).
        basisZScore: undefined,
      }),
      oiDivergence: calculateOiDivergenceScore({ oiChangePct, priceChangePct: window20.changePct }),
      fundingExtreme: calculateFundingExtremeScore({ fundingRate, threshold: threshold?.fundingThreshold ?? DEFAULT_FUNDING_THRESHOLD }),
    };

    const mmTotalScore = Object.values(mmSignals).reduce((sum, s) => sum + s.score, 0);
    const mmTier = classifyTier(mmTotalScore);
    const activeMmSignals = Object.entries(mmSignals)
      .filter(([, s]) => s.score >= 0.6)
      .map(([k]) => k);

    const tier1ScoreInput: Tier1ScoreInput = {
      mmTotalScore,
      smartMoneyCondition: smartMoney.condition,
      smartMoneyConfidenceScore: smartMoney.confidenceScore,
      regime1h,
      regime4h,
      obiBidPct20: obi.depth20,
      cvdBuyPct: cvd.buyPct,
    };
    const tier1Score = scoreTier1Signals(tier1ScoreInput);

    // ─── Grid bounds (Compass-equivalent) ───
    const gridBoundOpts: GridBoundOptions = {
      atrPeriod: opts.atrPeriod,
      atrMult: opts.atrMult,
      slExtraAtr: opts.slExtraAtr,
      slPctBuffer: opts.slPctBuffer,
      tpAtrMult: opts.tpAtrMult,
      lookbackBars: opts.lookbackBars,
    };
    const gridSetup = computeGridBounds(candles1h, currentPrice, gridBoundOpts);

    // ─── Leverage loop: capital-solve exact per leverage, descending ───
    const sortedLeverages = [...opts.maxLeverageOptions].sort((a, b) => b - a);
    const evaluatedLeverages: LeverageEvaluation[] = [];
    let chosenLeverage: number | null = null;
    let chosenFinalRun: GridRiskAnalysisResult | null = null;
    let chosenInitialCapital: number | null = null;

    const marketData: BinanceMarketData = {
      predictedFundingRate: fundingRate,
      openInterest: Number.isFinite(oiCurrentVal) ? oiCurrentVal : 0,
      orderBookBidDepthSL: orderBook.bids.reduce((sum, [priceStr, qtyStr]) => {
        const price = parseFloat(priceStr);
        const qty = parseFloat(qtyStr);
        return price >= gridSetup.stopLossPrice && price > 0 && qty > 0 ? sum + price * qty : sum;
      }, 0),
    };

    for (const leverage of sortedLeverages) {
      const referenceParams: GridInputParams = {
        symbol,
        initialCapital: REFERENCE_CAPITAL,
        lowerPrice: gridSetup.lowerPrice,
        upperPrice: gridSetup.upperPrice,
        currentPrice,
        gridCount: gridSetup.gridCount,
        stopLossPrice: gridSetup.stopLossPrice,
        leverage,
        gridType: gridSetup.gridType,
      };

      const referenceRun = await calculateGridRisk(referenceParams, marketData, contextualRisk as GridContextualRisk);

      if (referenceRun.status === "REJECT" || referenceRun.slippageStressedLoss <= 0) {
        evaluatedLeverages.push({
          leverage,
          referenceStatus: referenceRun.status,
          referenceSlippageStressedLoss: referenceRun.slippageStressedLoss,
          referenceRejectionReason: referenceRun.rejectionReason,
          finalRun: null,
          initialCapitalSolved: null,
          chosen: false,
        });
        continue;
      }

      let solvedInitialCapital: number;
      try {
        solvedInitialCapital = scaleCapitalForTargetLoss(REFERENCE_CAPITAL, referenceRun.slippageStressedLoss, opts.riskUsd);
      } catch {
        evaluatedLeverages.push({
          leverage,
          referenceStatus: referenceRun.status,
          referenceSlippageStressedLoss: referenceRun.slippageStressedLoss,
          referenceRejectionReason: referenceRun.rejectionReason,
          finalRun: null,
          initialCapitalSolved: null,
          chosen: false,
        });
        continue;
      }

      const finalRun = await calculateGridRisk(
        { ...referenceParams, initialCapital: solvedInitialCapital },
        marketData,
        contextualRisk as GridContextualRisk,
      );

      // calculateGridRisk() SUDAH reject internal kalau liquidationPrice >=
      // stopLossPrice (gridRiskEngine.ts) -- verifikasi eksplisit lagi di
      // sini karena spec pipeline ini minta pengecekan itu sebagai bagian
      // dari LOGIKA PEMILIHAN LEVERAGE-nya sendiri, bukan cuma percaya buta
      // ke internal calculateGridRisk.
      const liquidationSafe = finalRun.liquidationPrice < gridSetup.stopLossPrice;
      const eligible = (finalRun.status === "SAFE" || finalRun.status === "MODERATE") && liquidationSafe;
      const chosen = eligible && chosenLeverage === null;

      evaluatedLeverages.push({
        leverage,
        referenceStatus: referenceRun.status,
        referenceSlippageStressedLoss: referenceRun.slippageStressedLoss,
        referenceRejectionReason: referenceRun.rejectionReason,
        finalRun,
        initialCapitalSolved: solvedInitialCapital,
        chosen,
      });

      if (chosen) {
        chosenLeverage = leverage;
        chosenFinalRun = finalRun;
        chosenInitialCapital = solvedInitialCapital;
      }
    }

    const gridRiskStatusForDecision: GridRiskAnalysisResult["status"] = chosenFinalRun ? chosenFinalRun.status : "REJECT";

    const outcome = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: tier1Score.rankingScore,
      gridRiskStatus: gridRiskStatusForDecision,
    });

    const gridBotConfig: GridBotConfigSection = {
      lower: gridSetup.lowerPrice,
      upper: gridSetup.upperPrice,
      gridCount: gridSetup.gridCount,
      gridType: gridSetup.gridType,
      leverage: chosenLeverage,
      marginMode: opts.marginMode,
      stopLoss: gridSetup.stopLossPrice,
      takeProfit: gridSetup.takeProfitPrice,
      marginModeCaveat: MARGIN_MODE_CAVEAT,
    };

    const tier1Section: Tier1Section = {
      smartMoney: {
        condition: smartMoney.condition,
        smartMoneyBias: smartMoney.smartMoneyBias,
        retailSentiment: smartMoney.retailSentiment,
        confidenceScore: smartMoney.confidenceScore,
        divergenceScore: smartMoney.divergenceScore,
      },
      mm: { totalScore: mmTotalScore, tier: mmTier, activeSignals: activeMmSignals },
      obi,
      cvd: { buyPct: cvd.buyPct, cvd: cvd.cvd },
      oi: { changePct: oiChangePct },
      regime1h,
      regime4h,
    };

    const riskSection: RiskSection = {
      chosenLeverage,
      initialCapitalSolved: chosenInitialCapital,
      evaluatedLeverages,
      gridRisk: chosenFinalRun,
    };

    if (chosenLeverage === null) {
      preHardScreenNotes.push(
        `Tidak ada opsi leverage (${opts.maxLeverageOptions.join(", ")}) yang menghasilkan status SAFE/MODERATE dengan likuidasi aman di bawah stop-loss -- gridBotConfig.leverage null, lihat risk.evaluatedLeverages untuk detail tiap opsi yang dicoba.`,
      );
    }

    return {
      symbol,
      decision: outcome.decision,
      rankingScore: tier1Score.rankingScore,
      hardScreen: hardScreenSection,
      tier1: tier1Section,
      gridSetup,
      risk: riskSection,
      gridBotConfig,
      reasoning: [...preHardScreenNotes, ...tier1Score.notes, ...outcome.reasoning],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      symbol,
      decision: "NO_TRADE",
      rankingScore: 0,
      hardScreen: {
        passed: false,
        reasons: [`Error internal saat memproses ${symbol}: ${message}`],
        quoteVolumeUsd: 0,
        fundingRate: 0,
        regime1h: "RANGING",
        regime4h: "RANGING",
      },
      reasoning: [`Pipeline gagal untuk ${symbol}: ${message}. Symbol lain dalam batch yang sama TETAP diproses normal.`],
      error: message,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ZOD INPUT SCHEMA
// ─────────────────────────────────────────────────────────────
const symbolsInputSchema = z
  .union([symbolSchema, z.array(symbolSchema).min(1).max(20)])
  .transform((value) => {
    const list = Array.isArray(value) ? value : [value];
    return Array.from(new Set(list));
  })
  .describe(
    "Satu symbol (string) atau array symbol Binance Futures (maks 20, otomatis di-dedupe kalau ada duplikat). " +
      "Tiap symbol dijalankan lewat pipeline penuh (hard screen -> Tier-1 intelligence -> grid bounds -> risk " +
      "sizing -> keputusan TRADE/WATCH/NO_TRADE) secara paralel dibatasi parameter `concurrency`.",
  );

const fullPipelineInputSchema = {
  symbols: symbolsInputSchema,
  risk_usd: z
    .number()
    .positive()
    .default(20)
    .describe("Budget rugi maksimum (USD) sampai harga menyentuh stop-loss, dipakai capital-solve exact per opsi leverage. Default $20."),
  margin_mode: z
    .enum(["ISOLATED", "CROSSED"])
    .default("ISOLATED")
    .describe(
      "Mode margin yang DIMINTA (passthrough ke output gridBotConfig.marginMode saja) -- perhitungan risiko internal SELALU approximate ala isolated margin terlepas dari nilai ini (lihat marginModeCaveat di tiap hasil). Default ISOLATED.",
    ),
  max_leverage_options: z
    .array(z.number().positive().max(125))
    .min(1)
    .max(10)
    .default([3, 5, 10])
    .describe("Daftar opsi leverage yang dievaluasi (diurutkan descending secara internal, dipilih leverage tertinggi yang SAFE/MODERATE). Default [3, 5, 10]."),
  lookback_bars: z
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .describe("Jumlah candle 1h buat window HH/LL swing high/low grid bounds. Klines yang di-fetch selalu >= 40 (max(lookback_bars, 40)) supaya cukup untuk ADX/regime. Default 50."),
  atr_period: z.number().int().min(2).max(100).default(14).describe("Period ATR (Wilder) buat buffer upper/lower/SL/TP. Default 14."),
  atr_mult: z.number().positive().default(1.0).describe("Pengali ATR buat buffer upper/lower dari swing high/low. Default 1.0."),
  sl_extra_atr: z.number().nonnegative().default(1.5).describe("Pengali ATR tambahan di bawah lowerPrice buat stop-loss. Default 1.5."),
  sl_pct_buffer: z.number().nonnegative().default(1.0).describe("Buffer persen tambahan di bawah stop-loss ATR (misal 1.0 = 1%). Default 1.0."),
  tp_atr_mult: z.number().positive().optional().describe("Pengali ATR buat take-profit di atas upperPrice. Kalau tidak diisi, default simetris ke atr_mult."),
  min_quote_volume_usd: z
    .number()
    .nonnegative()
    .default(5_000_000)
    .describe("Ambang volume quote 24h (USD) absolut untuk hard screen -- pendekatan kasar dari cutoff 'bottom 20%', BUKAN percentile fetcher bulk-ticker. Default $5,000,000."),
  max_abs_funding_rate: z.number().positive().default(0.0005).describe("Ambang |funding rate| absolut untuk hard screen. Default 0.0005 (0.05%)."),
  concurrency: z.number().int().min(1).max(8).default(6).describe("Batas jumlah symbol yang diproses paralel dalam satu tool call. Default 6."),
};

export function registerFullPipelineTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_full_pipeline",
    {
      title: "Full Pipeline: Hard Screen → Tier-1 Intel → Grid Bounds → Risk Sizing → Keputusan",
      description:
        "Jalankan SELURUH decision chain Grid Bot Futures dalam SATU tool call, untuk satu atau banyak symbol " +
        "sekaligus (maks 20): (1) hard screen (tradability, volume minimum, funding rate, regime breakout) -- " +
        "symbol yang gagal LANGSUNG short-circuit ke NO_TRADE tanpa fetch lanjutan (hemat call proxy); (2) " +
        "Tier-1 intelligence (smart money divergence, 6 skor MM composite, order book imbalance, CVD, regime " +
        "1h+4h) digabung jadi rankingScore 0-100; (3) hitung bound grid Compass-equivalent (upper/lower/SL/TP/ " +
        "gridCount/gridType) dari ATR + swing high/low, TANPA reverse-engineer algoritma Compass Binance yang " +
        "tidak publik -- murni heuristik terdokumentasi; (4) capital-solve EXACT (bukan iteratif) buat tiap opsi " +
        "leverage supaya rugi maksimum ke stop-loss persis sama dengan risk_usd, pilih leverage tertinggi yang " +
        "SAFE/MODERATE dengan likuidasi aman; (5) keputusan akhir TRADE/WATCH/NO_TRADE plus parameter Grid Bot " +
        "siap copy-paste. Menggantikan ~8 tool call manual (binance_market_regime x2, binance_analyze_smart_money, " +
        "binance_detect_mm_activity, binance_get_order_book_imbalance, analyze_futures_grid_risk, dst.) + kalkulasi " +
        "manual bound grid yang sebelumnya TIDAK ADA tool-nya sama sekali. Token cost TINGGI (banyak fetch per " +
        "symbol) -- pakai untuk keputusan akhir, bukan eksplorasi awal (lihat binance_get_tool_catalog untuk tool " +
        "lebih murah kalau cuma butuh 1-2 sinyal spesifik). Known limitations lengkap: docs/full_pipeline_framework.md.",
      inputSchema: fullPipelineInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({
      symbols,
      risk_usd,
      margin_mode,
      max_leverage_options,
      lookback_bars,
      atr_period,
      atr_mult,
      sl_extra_atr,
      sl_pct_buffer,
      tp_atr_mult,
      min_quote_volume_usd,
      max_abs_funding_rate,
      concurrency,
    }) => {
      try {
        const opts: PipelineOpts = {
          riskUsd: risk_usd,
          marginMode: margin_mode,
          maxLeverageOptions: max_leverage_options,
          lookbackBars: lookback_bars,
          atrPeriod: atr_period,
          atrMult: atr_mult,
          slExtraAtr: sl_extra_atr,
          slPctBuffer: sl_pct_buffer,
          tpAtrMult: tp_atr_mult,
          minQuoteVolumeUsd: min_quote_volume_usd,
          maxAbsFundingRate: max_abs_funding_rate,
        };

        const results = await mapWithConcurrency(symbols, concurrency, (symbol) => runPipelineForSymbol(symbol, opts));

        const decisionRank = (r: SymbolPipelineResult): number => (r.decision === "TRADE" ? 2 : r.decision === "WATCH" ? 1 : 0);
        const sorted = [...results].sort((a, b) => {
          const rankDiff = decisionRank(b) - decisionRank(a);
          return rankDiff !== 0 ? rankDiff : b.rankingScore - a.rankingScore;
        });

        const summary = {
          total: sorted.length,
          traded: sorted.filter((r) => r.decision === "TRADE").length,
          watch: sorted.filter((r) => r.decision === "WATCH").length,
          noTrade: sorted.filter((r) => r.decision === "NO_TRADE").length,
          hardScreenRejected: sorted.filter((r) => !r.hardScreen.passed).length,
        };

        const builder = new ToolResponseBuilder()
          .header(`Full Pipeline — ${sorted.length} symbol`)
          .row("Total", String(summary.total))
          .row("TRADE", String(summary.traded))
          .row("WATCH", String(summary.watch))
          .row("NO_TRADE", String(summary.noTrade))
          .row("Ditolak Hard Screen", String(summary.hardScreenRejected))
          .subheader("Ringkasan")
          .table(
            ["Symbol", "Keputusan", "Skor", "Leverage", "Lower", "Upper", "Grid Type"],
            sorted.map((r) => [
              r.symbol,
              r.decision,
              r.rankingScore.toFixed(1),
              r.gridBotConfig?.leverage != null ? `${r.gridBotConfig.leverage}x` : "-",
              r.gridBotConfig ? fmtPrice(r.gridBotConfig.lower) : "-",
              r.gridBotConfig ? fmtPrice(r.gridBotConfig.upper) : "-",
              r.gridBotConfig?.gridType ?? "-",
            ]),
          );

        for (const r of sorted) {
          builder.subheader(`${r.symbol} — ${r.decision} (skor ${r.rankingScore.toFixed(1)}/100)`);

          if (r.gridBotConfig) {
            builder.table(
              ["Parameter", "Nilai"],
              [
                ["Lower", fmtPrice(r.gridBotConfig.lower)],
                ["Upper", fmtPrice(r.gridBotConfig.upper)],
                ["Grid Count (N)", String(r.gridBotConfig.gridCount)],
                ["Grid Type", r.gridBotConfig.gridType],
                ["Leverage", r.gridBotConfig.leverage != null ? `${r.gridBotConfig.leverage}x` : "Tidak ada leverage yang layak"],
                ["Margin Mode", r.gridBotConfig.marginMode],
                ["Stop Loss", fmtPrice(r.gridBotConfig.stopLoss)],
                ["Take Profit", fmtPrice(r.gridBotConfig.takeProfit)],
              ],
            );
            builder.note(r.gridBotConfig.marginModeCaveat);
          }

          for (const reason of r.reasoning) builder.row("Alasan", reason);
          if (r.error) builder.warning(`Error: ${r.error}`);
        }

        const built = builder.build();

        return {
          content: built.content,
          structuredContent: {
            generatedAt: new Date().toISOString(),
            params: {
              risk_usd,
              margin_mode,
              max_leverage_options,
              lookback_bars,
              atr_period,
              atr_mult,
              sl_extra_atr,
              sl_pct_buffer,
              tp_atr_mult,
              min_quote_volume_usd,
              max_abs_funding_rate,
              concurrency,
            },
            summary,
            results: sorted,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { symbolSchema, errorResult, computeRealizedVolatility } from "../shared.js";
import { computeCvdFromTrades, summarizeKlines, calculateADX, type KlineCandle } from "../toolHelpers.js";
import { classifyRegime, type MarketRegime } from "./marketRegime.js";
import { analyzeSmartMoneyDivergence } from "../smartMoneyAnalysis.js";
import {
  calculateAbsorptionScore,
  calculateSpoofingScore,
  calculateStopHuntScore,
  calculateBasisArbScore,
  calculateOiDivergenceScore,
  calculateFundingExtremeScore,
  classifyTier,
} from "./detectMmActivity.js";
import { getPairThreshold } from "./config.js";
import { fmtPrice } from "../format.js";
import { computeGridBounds, type GridBoundResult } from "../gridBoundEngine.js";
import { calculateGridRisk, type GridRiskAnalysisResult } from "../gridRiskEngine.js";
import { fetchMarketContext } from "../marketContext.js";
import { scaleCapitalForTargetLoss, evaluateHardScreen, scoreTier1Signals, decidePipelineOutcome } from "../pipelineEngine.js";
import { mapWithConcurrency } from "../concurrency.js";
import { computeGridVelocity } from "../gridVelocity.js";
import {
  getTicker24hrNative,
  getCurrentFundingRateNative,
  getKlinesNative,
  getOpenInterestNative,
  getOpenInterestHistNative,
  getAggTrades,
  getTopTraderPositionRatio,
  getGlobalAccountRatio,
  getOrderBookDepth,
  getSpotPrice,
  type OrderBookDepth,
} from "../binanceProxyClient.js";

const REFERENCE_CAPITAL = 1000;
const DEFAULT_FUNDING_THRESHOLD = 0.0003;
const DEFAULT_BASIS_THRESHOLD = 0.0005;
const REGIME_MIN_CANDLES = 21;
const MARGIN_MODE_CAVEAT =
  "GridInputParams (gridRiskEngine.ts) tidak punya field margin-mode -- semua perhitungan likuidasi/risiko di sini APPROXIMATE ala isolated margin, terlepas dari margin_mode yang diminta (ISOLATED atau CROSSED). Untuk CROSSED margin riil, likuidasi bergantung pada TOTAL saldo akun (bukan cuma capital yang dialokasikan ke grid ini) -- lihat docs/full_pipeline_framework.md bagian Known Limitations.";

interface RegimeWithReason {
  regime: MarketRegime;
  confidence: number;
  reason: string;
}

function computeRegimeFromKlines(
  klines: Awaited<ReturnType<typeof getKlinesNative>>,
  oiChangePct: number,
  cvdBuyPct: number,
): RegimeWithReason {
  const { candles } = summarizeKlines(klines);
  const adxResult = calculateADX(candles, 14);
  const recentCandles = candles.slice(-10);
  const priorCandles = candles.slice(-20, -10);
  const { changePct: priceChangePct } = summarizeKlines(klines.slice(-10));
  const recentVol = computeRealizedVolatility(recentCandles.map((c) => c.close), 24 * 365).annualizedPct;
  const priorVol = computeRealizedVolatility(priorCandles.map((c) => c.close), 24 * 365).annualizedPct;
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

function safeComputeRegime(
  klines: Awaited<ReturnType<typeof getKlinesNative>>,
  oiChangePct: number,
  cvdBuyPct: number,
): RegimeWithReason {
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

function obiAtDepth(orderBook: OrderBookDepth, depth: number): number {
  const bidVol = orderBook.bids.slice(0, depth).reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const askVol = orderBook.asks.slice(0, depth).reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const total = bidVol + askVol;
  return total > 0 ? (bidVol / total) * 100 : 50;
}

interface PipelineOpts {
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

interface EvaluatedLeverage {
  leverage: number;
  referenceStatus: GridRiskAnalysisResult["status"];
  referenceSlippageStressedLoss: number;
  referenceRejectionReason?: string;
  finalRun: GridRiskAnalysisResult | null;
  initialCapitalSolved: number | null;
  chosen: boolean;
}

interface PipelineResult {
  symbol: string;
  decision: "TRADE" | "WATCH" | "NO_TRADE";
  rankingScore: number;
  hardScreen: {
    passed: boolean;
    reasons: string[];
    quoteVolumeUsd: number;
    fundingRate: number;
    regime1h: MarketRegime;
    regime4h: MarketRegime;
  };
  tier1?: {
    smartMoney: {
      condition: string;
      smartMoneyBias: string;
      retailSentiment: string;
      confidenceScore: number;
      divergenceScore: number;
    };
    mm: { totalScore: number; tier: string; activeSignals: string[] };
    obi: { depth5: number; depth10: number; depth20: number };
    cvd: { buyPct: number; cvd: number };
    oi: { changePct: number };
    regime1h: RegimeWithReason;
    regime4h: RegimeWithReason;
  };
  gridSetup?: GridBoundResult;
  risk?: {
    chosenLeverage: number | null;
    initialCapitalSolved: number | null;
    evaluatedLeverages: EvaluatedLeverage[];
    gridRisk: GridRiskAnalysisResult | null;
  };
  gridBotConfig?: {
    lower: number;
    upper: number;
    gridCount: number;
    gridType: "ARITHMETIC" | "GEOMETRIC";
    leverage: number | null;
    marginMode: "ISOLATED" | "CROSSED";
    stopLoss: number;
    takeProfit: number;
    marginModeCaveat: string;
  };
  breakevenInfo?: ReturnType<typeof computeGridVelocity>;
  reasoning: string[];
  error?: string;
}

async function runPipelineForSymbol(symbol: string, opts: PipelineOpts): Promise<PipelineResult> {
  const preHardScreenNotes: string[] = [];
  try {
    const klineLimit = Math.max(opts.lookbackBars, 40);
    const [tickerResult, funding, klines1h, klines4h, oiCurrent, oiHist2, aggTrades, contextualRisk] = await Promise.all([
      getTicker24hrNative(symbol).catch(() => null),
      getCurrentFundingRateNative(symbol),
      getKlinesNative(symbol, "1h", klineLimit),
      getKlinesNative(symbol, "4h", 40),
      getOpenInterestNative(symbol),
      getOpenInterestHistNative(symbol, "1h", 2),
      getAggTrades(symbol, 100),
      fetchMarketContext(symbol),
    ]);

    const lastPrice = tickerResult ? parseFloat(tickerResult.lastPrice) : NaN;
    const quoteVolumeUsdRaw = tickerResult ? parseFloat(tickerResult.quoteVolume) : NaN;
    const tradable = tickerResult !== null && Number.isFinite(lastPrice) && lastPrice > 0 && Number.isFinite(quoteVolumeUsdRaw);
    const quoteVolumeUsd = Number.isFinite(quoteVolumeUsdRaw) ? quoteVolumeUsdRaw : 0;
    const markPrice = parseFloat(funding.markPrice);
    const fundingRate = Number.isFinite(parseFloat(funding.lastFundingRate)) ? parseFloat(funding.lastFundingRate) : 0;
    const { candles: candles1h, lastClose: lastClose1h } = summarizeKlines(klines1h);
    const currentPrice = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : lastClose1h;
    const oiCurrentVal = parseFloat(oiCurrent.openInterest);
    const oiPrevVal = parseFloat(oiHist2[0]?.sumOpenInterest ?? String(oiCurrentVal));
    const oiChangePct = oiPrevVal !== 0 ? ((oiCurrentVal - oiPrevVal) / oiPrevVal) * 100 : 0;
    const cvd = computeCvdFromTrades(aggTrades);
    const regime1h = safeComputeRegime(klines1h, oiChangePct, cvd.buyPct);
    const regime4h = safeComputeRegime(klines4h, oiChangePct, cvd.buyPct);

    const hardScreenInput = {
      tradable,
      quoteVolumeUsd,
      minQuoteVolumeUsd: opts.minQuoteVolumeUsd,
      fundingRate,
      maxAbsFundingRate: opts.maxAbsFundingRate,
      regime1h: regime1h.regime,
      regime4h: regime4h.regime,
    };
    const hardScreen = evaluateHardScreen(hardScreenInput);
    const hardScreenSection = {
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

    const [topTrader, globalRatio, oiHist24, orderBook, threshold, spotPriceResult] = await Promise.all([
      getTopTraderPositionRatio(symbol, "1h", 1),
      getGlobalAccountRatio(symbol, "1h", 1),
      getOpenInterestHistNative(symbol, "1h", 24),
      getOrderBookDepth(symbol, 50),
      getPairThreshold(symbol),
      getSpotPrice(symbol).catch(() => null),
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

    const mmSignals = {
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

    const tier1ScoreInput = {
      mmTotalScore,
      smartMoneyCondition: smartMoney.condition,
      smartMoneyConfidenceScore: smartMoney.confidenceScore,
      regime1h,
      regime4h,
      obiBidPct20: obi.depth20,
      cvdBuyPct: cvd.buyPct,
    };
    const tier1Score = scoreTier1Signals(tier1ScoreInput);

    const gridBoundOpts = {
      atrPeriod: opts.atrPeriod,
      atrMult: opts.atrMult,
      slExtraAtr: opts.slExtraAtr,
      slPctBuffer: opts.slPctBuffer,
      tpAtrMult: opts.tpAtrMult,
      lookbackBars: opts.lookbackBars,
    };
    const gridSetup = computeGridBounds(candles1h, currentPrice, gridBoundOpts);

    const sortedLeverages = [...opts.maxLeverageOptions].sort((a, b) => b - a);
    const evaluatedLeverages: EvaluatedLeverage[] = [];
    let chosenLeverage: number | null = null;
    let chosenFinalRun: GridRiskAnalysisResult | null = null;
    let chosenInitialCapital: number | null = null;

    const marketData = {
      predictedFundingRate: fundingRate,
      openInterest: Number.isFinite(oiCurrentVal) ? oiCurrentVal : 0,
      orderBookBidDepthSL: orderBook.bids.reduce((sum, [priceStr, qtyStr]) => {
        const price = parseFloat(priceStr);
        const qty = parseFloat(qtyStr);
        return price >= gridSetup.stopLossPrice && price > 0 && qty > 0 ? sum + price * qty : sum;
      }, 0),
    };

    for (const leverage of sortedLeverages) {
      const referenceParams = {
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
      const referenceRun = await calculateGridRisk(referenceParams, marketData, contextualRisk);
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
      const finalRun = await calculateGridRisk({ ...referenceParams, initialCapital: solvedInitialCapital }, marketData, contextualRisk);
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

    const gridRiskStatusForDecision = chosenFinalRun ? chosenFinalRun.status : "REJECT";
    const outcome = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: tier1Score.rankingScore,
      gridRiskStatus: gridRiskStatusForDecision,
    });

    const gridBotConfig = {
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

    const tier1Section = {
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

    const riskSection = {
      chosenLeverage,
      initialCapitalSolved: chosenInitialCapital,
      evaluatedLeverages,
      gridRisk: chosenFinalRun,
    };

    const matchesNeeded = chosenFinalRun?.minBreakevenCycles ?? 0;
    const breakevenInfo = computeGridVelocity({
      candles: candles1h,
      lowerPrice: gridSetup.lowerPrice,
      upperPrice: gridSetup.upperPrice,
      gridCount: gridSetup.gridCount,
      gridType: gridSetup.gridType,
      matchesNeeded,
      candleDurationHours: 1, // bounds berbasis TF 1h
    });

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
      breakevenInfo,
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

const symbolsInputSchema = z
  .union([symbolSchema, z.array(symbolSchema).min(1).max(20)])
  .transform((value) => {
    const list = Array.isArray(value) ? value : [value];
    return Array.from(new Set(list));
  })
  .describe(
    "Satu symbol (string) atau array symbol Binance Futures (maks 20, otomatis di-dedupe kalau ada duplikat). Tiap symbol dijalankan lewat pipeline penuh (hard screen -> Tier-1 intelligence -> grid bounds -> risk sizing -> keputusan TRADE/WATCH/NO_TRADE) secara paralel dibatasi parameter `concurrency`.",
  );

const fullPipelineInputSchema = {
  symbols: symbolsInputSchema,
  risk_usd: z.number().positive().default(20).describe("Budget rugi maksimum (USD) sampai harga menyentuh stop-loss, dipakai capital-solve exact per opsi leverage. Default $20."),
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
  lookback_bars: z.number().int().min(10).max(200).default(50).describe("Jumlah candle 1h buat window HH/LL swing high/low grid bounds. Klines yang di-fetch selalu >= 40 (max(lookback_bars, 40)) supaya cukup untuk ADX/regime. Default 50."),
  atr_period: z.number().int().min(2).max(100).default(14).describe("Period ATR (Wilder) buat buffer upper/lower/SL/TP. Default 14."),
  atr_mult: z.number().positive().default(1).describe("Pengali ATR buat buffer upper/lower dari swing high/low. Default 1.0."),
  sl_extra_atr: z.number().nonnegative().default(1.5).describe("Pengali ATR tambahan di bawah lowerPrice buat stop-loss. Default 1.5."),
  sl_pct_buffer: z.number().nonnegative().default(1).describe("Buffer persen tambahan di bawah stop-loss ATR (misal 1.0 = 1%). Default 1.0."),
  tp_atr_mult: z.number().positive().optional().describe("Pengali ATR buat take-profit di atas upperPrice. Kalau tidak diisi, default simetris ke atr_mult."),
  min_quote_volume_usd: z.number().nonnegative().default(5_000_000).describe("Ambang volume quote 24h (USD) absolut untuk hard screen -- pendekatan kasar dari cutoff 'bottom 20%', BUKAN percentile fetcher bulk-ticker. Default $5,000,000."),
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
        "Decision chain Grid Bot Futures penuh dalam 1 call, 1-20 symbol: hard screen -> Tier-1 intel (rankingScore 0-100) -> grid bounds (ATR + swing high/low) -> capital-solve exact per leverage -> TRADE/WATCH/NO_TRADE + parameter Grid Bot siap-pakai. Juga mengembalikan Matches Needed + Estimasi Durasi ke Impas sebagai informasi non-gate. Gantikan ~8 tool call manual. Token cost TINGGI -- pakai untuk keputusan akhir, bukan eksplorasi. Known limitations: docs/full_pipeline_framework.md.",
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

        const decisionRank = (r: PipelineResult) => (r.decision === "TRADE" ? 2 : r.decision === "WATCH" ? 1 : 0);
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
          .row("Total/TRADE/WATCH/NO_TRADE/Rejected", `${summary.total} / ${summary.traded} / ${summary.watch} / ${summary.noTrade} / ${summary.hardScreenRejected}`)
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

        const tradeCandidates = sorted.filter((r) => r.decision === "TRADE").slice(0, 5);
        for (const r of tradeCandidates) {
          const be = r.breakevenInfo;
          const matchesStr = be && be.matchesNeeded > 0 ? `🔁 Matches ke Impas: ${be.matchesNeeded}` : "";
          const timeStr = be && be.estHoursToBreakeven != null ? `⏱️ Estimasi Durasi ke Impas: ~${be.estHoursToBreakeven.toFixed(1)} jam (~${(be.estDaysToBreakeven ?? 0).toFixed(1)} hari)` : "";
          const beLine = [matchesStr, timeStr].filter(Boolean).join(" | ");
          builder.row(r.symbol, (r.reasoning.slice(0, 2).join(" | ") || "-") + (beLine ? ` | ${beLine}` : ""));
        }

        builder.note(
          "Detail lengkap per symbol (gridBotConfig, reasoning, hardScreen, tier1, risk, breakevenInfo) ada di structuredContent.results[i]. Matches Needed & Estimasi Durasi ke Impas adalah informasi non-gate (tidak mempengaruhi keputusan TRADE/WATCH/NO_TRADE).",
        );

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

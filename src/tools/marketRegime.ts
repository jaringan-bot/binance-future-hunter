// binance_market_regime — klasifikasi kondisi pasar (trending/ranging/
// breakout/accumulation/distribution) biar Claude punya konteks makro
// sebelum baca sinyal lain. Desain awal di whalescope_mcp_roadmap.md Bagian
// 4.1.B; volatility-spike & volume-spike di sini dihitung dari WINDOW
// KLINES YANG SAMA (10 candle terakhir vs 10 sebelumnya), bukan baseline
// historis persisten (belum ada time-series storage general per pair,
// cuma basisHistory.ts yang watchlist-only) -- didokumentasikan di
// description tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { symbolSchema, errorResult, computeRealizedVolatility, KLINE_INTERVAL_ENUM } from "../shared.js";
import { computeCvdFromTrades, summarizeKlines, calculateADX, type KlineCandle } from "../toolHelpers.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum } from "../format.js";
import { z } from "zod";

export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "BREAKOUT" | "ACCUMULATION" | "DISTRIBUTION";

export interface RegimeInput {
  adx: number;
  plusDI: number;
  minusDI: number;
  oiChangePct: number;
  priceChangePct: number;
  cvdBuyPct: number;
  volatilitySpikeRatio: number; // realized vol 10 candle terakhir / 10 candle sebelumnya
  volumeSpikeRatio: number; // volume candle terakhir / rata-rata 10 candle sebelumnya
}

export interface RegimeResult {
  regime: MarketRegime;
  confidence: number; // 0-1
  reason: string;
}

// Urutan pengecekan SENGAJA: BREAKOUT dan ACCUMULATION/DISTRIBUTION dicek
// duluan (pola spesifik, sinyal kuat kalau match) sebelum jatuh ke
// TRENDING/RANGING yang lebih generik berbasis ADX doang.
export function classifyRegime(input: RegimeInput): RegimeResult {
  const { adx, plusDI, minusDI, oiChangePct, priceChangePct, cvdBuyPct, volatilitySpikeRatio, volumeSpikeRatio } =
    input;

  if (volatilitySpikeRatio > 2 && oiChangePct > 3 && volumeSpikeRatio > 2) {
    return {
      regime: "BREAKOUT",
      confidence: Math.min(1, 0.6 + Math.min(0.4, (volatilitySpikeRatio - 2) / 5)),
      reason: `Volatilitas melonjak ${volatilitySpikeRatio.toFixed(1)}x, OI +${oiChangePct.toFixed(2)}%, volume ${volumeSpikeRatio.toFixed(1)}x rata-rata -- pola breakout.`,
    };
  }

  if (cvdBuyPct > 55 && oiChangePct > 2 && Math.abs(priceChangePct) < 1) {
    return {
      regime: "ACCUMULATION",
      confidence: Math.min(1, 0.5 + (cvdBuyPct - 55) / 30),
      reason: `CVD buy dominan (${cvdBuyPct.toFixed(1)}%), OI naik ${oiChangePct.toFixed(2)}%, harga flat (${priceChangePct.toFixed(2)}%) -- whale absorption sisi beli.`,
    };
  }

  if (cvdBuyPct < 45 && oiChangePct < -2 && Math.abs(priceChangePct) < 1) {
    return {
      regime: "DISTRIBUTION",
      confidence: Math.min(1, 0.5 + (45 - cvdBuyPct) / 30),
      reason: `CVD sell dominan (${(100 - cvdBuyPct).toFixed(1)}%), OI turun ${oiChangePct.toFixed(2)}%, harga flat (${priceChangePct.toFixed(2)}%) -- whale unloading.`,
    };
  }

  if (adx > 25 && plusDI > minusDI) {
    return {
      regime: "TRENDING_UP",
      confidence: Math.min(1, 0.5 + (adx - 25) / 50),
      reason: `ADX ${adx.toFixed(1)} (>25) dengan +DI (${plusDI.toFixed(1)}) di atas -DI (${minusDI.toFixed(1)}) -- tren naik kuat.`,
    };
  }

  if (adx > 25 && minusDI > plusDI) {
    return {
      regime: "TRENDING_DOWN",
      confidence: Math.min(1, 0.5 + (adx - 25) / 50),
      reason: `ADX ${adx.toFixed(1)} (>25) dengan -DI (${minusDI.toFixed(1)}) di atas +DI (${plusDI.toFixed(1)}) -- tren turun kuat.`,
    };
  }

  const rangingConfidence = adx < 20 ? Math.min(1, 0.5 + (20 - adx) / 40) : 0.3;
  return {
    regime: "RANGING",
    confidence: rangingConfidence,
    reason:
      adx < 20
        ? `ADX ${adx.toFixed(1)} (<20) -- tidak ada tren jelas, harga cenderung sideways.`
        : `ADX ${adx.toFixed(1)} di zona abu-abu (20-25) dan tidak ada pola breakout/accumulation/distribution jelas -- default ke ranging dengan confidence rendah.`,
  };
}

function realizedVolPct(candles: KlineCandle[]): number {
  const closes = candles.map((c) => c.close);
  return computeRealizedVolatility(closes, 24 * 365).periodPct;
}

// Minimum candle historis (>=21) di-scale relatif ke minimum ADX(14) yang
// tidak berubah lintas timeframe -- 21 candle 1H (~21 jam) dan 21 candle 4H
// (~3.5 hari) sama-sama valid secara struktural untuk ADX(14). Limit fetch
// tetap 40 (bukan diskalakan naik/turun) karena requirement-nya adalah
// JUMLAH candle, bukan rentang waktu -- baik 1H maupun 4H sama-sama perlu
// ~40 candle untuk window recent(10)/prior(10) + margin ADX warm-up.
const REGIME_MIN_CANDLES = 21;
const REGIME_KLINE_LIMIT = 40;

export function registerMarketRegimeTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_market_regime",
    {
      title: "Deteksi Regime Pasar (Trending/Ranging/Breakout/Accumulation/Distribution)",
      description:
        "Klasifikasi kondisi pasar saat ini jadi salah satu dari 6 regime: TRENDING_UP, TRENDING_DOWN, RANGING, " +
        "BREAKOUT, ACCUMULATION, DISTRIBUTION -- pakai ADX(14) dari klines timeframe pilihan (default 1 jam, bisa " +
        "diganti lewat parameter interval, mis. '4h'), tren OI, CVD dari agg trades, dan rasio spike " +
        "volatilitas/volume (10 candle terakhir vs 10 sebelumnya PADA TIMEFRAME YANG SAMA, BUKAN baseline " +
        "historis persisten -- belum ada penyimpanan time-series general per pair). PENTING: memanggil tool ini " +
        "dua kali dengan interval berbeda (mis. '1h' lalu '4h') menghasilkan DUA regime independen -- masing-masing " +
        "punya window candle, ADX, OI-change, dan CVD sendiri, bukan derivasi satu dari yang lain. Cocok untuk " +
        "kebutuhan multi-timeframe (mis. cross-check regime 1H vs 4H) tanpa perlu tool terpisah.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(KLINE_INTERVAL_ENUM)
          .default("1h")
          .describe(
            "Timeframe candle untuk analisis regime (ADX, OI-change, CVD, volatility/volume spike): 1m, 5m, 15m, " +
              "30m, 1h, 2h, 4h, 6h, 12h, 1d. Default '1h' (perilaku lama, tidak ada breaking change). Gunakan '4h' " +
              "untuk regime 4-jam yang sepenuhnya independen dari hasil 1h -- masing-masing dihitung dari window " +
              "candle miliknya sendiri, bukan agregasi dari interval lain.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval }) => {
      try {
        const [klines, oiCurrent, oiHist, aggTrades] = await Promise.all([
          binanceProxy.getKlinesNative(symbol, interval, REGIME_KLINE_LIMIT),
          binanceProxy.getOpenInterestNative(symbol),
          binanceProxy.getOpenInterestHistNative(symbol, interval, 2),
          binanceProxy.getAggTrades(symbol, 100),
        ]);

        const { candles } = summarizeKlines(klines);
        if (candles.length < REGIME_MIN_CANDLES) {
          return errorResult(
            new Error(
              `Data klines tidak cukup untuk analisis regime (dapat ${candles.length}, butuh minimal ${REGIME_MIN_CANDLES} candle ${interval}).`,
            ),
          );
        }

        const adxResult = calculateADX(candles, 14);

        const recentCandles = candles.slice(-10);
        const priorCandles = candles.slice(-20, -10);
        const { changePct: priceChangePct } = summarizeKlines(klines.slice(-10)); // window sama yang dipakai buat vol/volume spike

        const recentVol = realizedVolPct(recentCandles);
        const priorVol = realizedVolPct(priorCandles);
        const volatilitySpikeRatio = priorVol > 0 ? recentVol / priorVol : recentVol > 0 ? 2 : 1;

        const lastCandle = candles[candles.length - 1];
        const priorVolumeAvg =
          priorCandles.reduce((sum, c) => sum + c.volume, 0) / (priorCandles.length || 1);
        const volumeSpikeRatio = priorVolumeAvg > 0 ? lastCandle.volume / priorVolumeAvg : 1;

        const oiCurrentVal = parseFloat(oiCurrent.openInterest);
        const oiPrevVal = parseFloat(oiHist[0]?.sumOpenInterest ?? String(oiCurrentVal));
        const oiChangePct = oiPrevVal !== 0 ? ((oiCurrentVal - oiPrevVal) / oiPrevVal) * 100 : 0;

        const cvd = computeCvdFromTrades(aggTrades);

        const result = classifyRegime({
          adx: adxResult.adx,
          plusDI: adxResult.plusDI,
          minusDI: adxResult.minusDI,
          oiChangePct,
          priceChangePct,
          cvdBuyPct: cvd.buyPct,
          volatilitySpikeRatio,
          volumeSpikeRatio,
        });

        const builder = new ToolResponseBuilder()
          .header(`Regime Pasar — ${symbol} (${interval})`)
          .row("Regime", result.regime)
          .row("Confidence", `${(result.confidence * 100).toFixed(0)}%`)
          .interpretation("Alasan", result.reason)
          .subheader("Metrik Pendukung")
          .row("Timeframe", interval)
          .row("ADX(14)", fmtNum(adxResult.adx, 2))
          .row("+DI / -DI", `${fmtNum(adxResult.plusDI, 2)} / ${fmtNum(adxResult.minusDI, 2)}`)
          .row(`OI Change (${interval})`, `${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}%`)
          .row("Price Change (10 candle)", `${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}%`)
          .row("CVD Buy %", `${cvd.buyPct.toFixed(1)}%`)
          .row("Volatility Spike Ratio", `${volatilitySpikeRatio.toFixed(2)}x`)
          .row("Volume Spike Ratio", `${volumeSpikeRatio.toFixed(2)}x`)
          .note(
            `Volatility/volume spike dihitung relatif ke 10 candle ${interval} sebelumnya dalam window fetch ini, bukan baseline historis jangka panjang. Regime ini dihitung MURNI dari timeframe ${interval} -- kalau butuh regime timeframe lain (mis. cross-check 1h vs 4h), panggil tool ini lagi dengan parameter interval berbeda; jangan diturunkan/diinterpolasi dari hasil ini.`,
          )
          .struct("symbol", symbol)
          .struct("interval", interval)
          .struct("regime", result.regime)
          .struct("confidence", result.confidence)
          .struct("adx", adxResult.adx)
          .struct("plusDI", adxResult.plusDI)
          .struct("minusDI", adxResult.minusDI)
          .struct("oiChangePct", oiChangePct)
          .struct("priceChangePct", priceChangePct)
          .struct("cvdBuyPct", cvd.buyPct)
          .struct("volatilitySpikeRatio", volatilitySpikeRatio)
          .struct("volumeSpikeRatio", volumeSpikeRatio);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

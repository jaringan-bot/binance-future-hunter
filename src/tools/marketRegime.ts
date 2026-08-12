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
import { symbolSchema, errorResult, computeRealizedVolatility } from "../shared.js";
import { computeCvdFromTrades, summarizeKlines, calculateADX, type KlineCandle } from "../toolHelpers.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum } from "../format.js";

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

export function registerMarketRegimeTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_market_regime",
    {
      title: "Deteksi Regime Pasar (Trending/Ranging/Breakout/Accumulation/Distribution)",
      description:
        "Klasifikasi kondisi pasar saat ini jadi salah satu dari 6 regime: TRENDING_UP, TRENDING_DOWN, RANGING, " +
        "BREAKOUT, ACCUMULATION, DISTRIBUTION -- pakai ADX(14) dari klines 1 jam, tren OI, CVD dari agg trades, " +
        "dan rasio spike volatilitas/volume (10 candle terakhir vs 10 sebelumnya, BUKAN baseline historis " +
        "persisten -- belum ada penyimpanan time-series general per pair). Berguna buat kasih Claude konteks " +
        "makro sebelum baca sinyal lain (funding, OI, order book) satu-satu.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const [klines, oiCurrent, oiHist, aggTrades] = await Promise.all([
          binanceProxy.getKlinesNative(symbol, "1h", 40),
          binanceProxy.getOpenInterestNative(symbol),
          binanceProxy.getOpenInterestHistNative(symbol, "1h", 2),
          binanceProxy.getAggTrades(symbol, 100),
        ]);

        const { candles } = summarizeKlines(klines);
        if (candles.length < 21) {
          return errorResult(
            new Error(
              `Data klines tidak cukup untuk analisis regime (dapat ${candles.length}, butuh minimal 21 candle 1 jam).`,
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
          .header(`Regime Pasar — ${symbol}`)
          .row("Regime", result.regime)
          .row("Confidence", `${(result.confidence * 100).toFixed(0)}%`)
          .interpretation("Alasan", result.reason)
          .subheader("Metrik Pendukung")
          .row("ADX(14)", fmtNum(adxResult.adx, 2))
          .row("+DI / -DI", `${fmtNum(adxResult.plusDI, 2)} / ${fmtNum(adxResult.minusDI, 2)}`)
          .row("OI Change (1h)", `${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}%`)
          .row("Price Change (10 candle)", `${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}%`)
          .row("CVD Buy %", `${cvd.buyPct.toFixed(1)}%`)
          .row("Volatility Spike Ratio", `${volatilitySpikeRatio.toFixed(2)}x`)
          .row("Volume Spike Ratio", `${volumeSpikeRatio.toFixed(2)}x`)
          .note(
            "Volatility/volume spike dihitung relatif ke 10 candle sebelumnya dalam window fetch ini, bukan baseline historis jangka panjang.",
          )
          .struct("symbol", symbol)
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

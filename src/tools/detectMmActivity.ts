// binance_detect_mm_activity — composite scoring tool, gabungan 6 sinyal jadi
// 1 tool call + skor/tier, ngurangin kerjaan Claude manggil+gabung banyak tool
// manual (lihat whalescope_mcp_roadmap.md Bagian 4.1.A untuk desain awal).
//
// ADAPTASI dari desain awal (dicatat di sini biar jujur soal batasannya,
// konsisten sama gaya "keterbatasan yang jujur" di README):
// - Spoofing & stop-hunt di desain awal butuh 2 snapshot order book <3 detik
//   dan data liquidation. Proxy ini cuma 1 snapshot per call (latency proxy
//   ~485ms bikin 2-snapshot gak reliable), dan liquidation history
//   (dulu via Coinalyze) sudah dihapus total 2026-08-22 -- gak ada data
//   liquidation sama sekali sekarang (lihat docs/mm_detection_framework.md
//   Section 4.1). Jadi dua skor ini heuristik dari 1 snapshot order book /
//   klines aja, BUKAN true detection -- ini didokumentasikan eksplisit di
//   description tool & evidence text.
// - Basis arbitrage pakai z-score kalau symbol ada di watchlist (SNAPSHOT_WATCHLIST,
//   shared.ts) yang punya histori di D1 (market_snapshots), fallback ke
//   threshold sederhana untuk pair lain.
//
// computeMmSignals() diekstrak jadi fungsi terpisah (bukan cuma logic inline
// di handler tool) supaya bisa dipakai ULANG oleh Cron signal-snapshot
// (src/index.ts scheduled()) buat isi signal_history di D1 -- dipakai
// binance_backtest_signal. Satu sumber logic, dua pemanggil.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { symbolSchema, errorResult, SNAPSHOT_WATCHLIST } from "../shared.js";
import { computeCvdFromTrades, summarizeKlines } from "../toolHelpers.js";
import { getPairThreshold } from "./config.js";
import { queryMarketSnapshots } from "../d1Client.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtPct, fmtNum } from "../format.js";

export interface SignalScore {
  score: number; // 0-1
  evidence: string;
}

const DEFAULT_FUNDING_THRESHOLD = 0.0003;
const DEFAULT_BASIS_THRESHOLD = 0.0005;

export function calculateAbsorptionScore(params: {
  cvdBuyPct: number; // 0-100, dari computeCvdFromTrades
  priceChangePct: number; // % perubahan harga window yang sama
  oiChangePct: number; // % perubahan OI window yang sama
}): SignalScore {
  const { cvdBuyPct, priceChangePct, oiChangePct } = params;
  const cvdBias = cvdBuyPct - 50; // positif = tekanan beli dominan

  if (cvdBias > 10 && Math.abs(priceChangePct) < 0.5 && oiChangePct > 3) {
    const score = Math.min(1, 0.7 + Math.min(0.3, (oiChangePct - 3) / 10));
    return {
      score,
      evidence: `CVD buy ${cvdBuyPct.toFixed(1)}%, harga flat (${priceChangePct.toFixed(2)}%), OI +${oiChangePct.toFixed(2)}% -- pola absorption (posisi diserap tanpa harga bergerak).`,
    };
  }
  if (cvdBias > 5 && priceChangePct < 0) {
    return {
      score: 0.5,
      evidence: `CVD buy ${cvdBuyPct.toFixed(1)}% tapi harga turun ${priceChangePct.toFixed(2)}% -- indikasi lemah, cek ulang di timeframe lebih pendek.`,
    };
  }
  return { score: 0.1, evidence: `Tidak ada pola absorption jelas (CVD buy ${cvdBuyPct.toFixed(1)}%, OI ${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}%).` };
}

export function calculateSpoofingScore(params: {
  bestBidQty: number;
  bestAskQty: number;
  spreadPct: number; // dalam persen, misal 0.05 = 0.05%
  volume24h: number; // base asset, dari 24hr ticker
}): SignalScore {
  const { bestBidQty, bestAskQty, spreadPct, volume24h } = params;
  const largestWall = Math.max(bestBidQty, bestAskQty);
  const wallToVolumeRatio = volume24h > 0 ? largestWall / volume24h : 0;

  if (spreadPct > 0.2 && wallToVolumeRatio > 0.01) {
    return {
      score: 0.6,
      evidence: `Spread ${spreadPct.toFixed(4)}% + wall terbesar ${fmtNum(largestWall, 2)} (${(wallToVolumeRatio * 100).toFixed(2)}% dari volume 24h) -- anomali, TAPI ini cuma proxy heuristic dari 1 snapshot (bukan true spoofing detection, butuh 2 snapshot <3 detik yang belum bisa diandalkan di sini karena latency proxy).`,
    };
  }
  return { score: 0.1, evidence: `Tidak ada anomali wall/spread signifikan (spread ${spreadPct.toFixed(4)}%).` };
}

export function calculateStopHuntScore(params: {
  high: number;
  low: number;
  open: number;
  close: number;
  prevOpen: number;
  prevClose: number;
}): SignalScore {
  const { high, low, open, close, prevOpen, prevClose } = params;
  const range = high - low || 1;
  const wickRatio = (high - Math.max(open, close)) / range;
  const bodyRatio = Math.abs(close - open) / range;
  const reversal = (close > open && prevClose < prevOpen) || (close < open && prevClose > prevOpen);

  if (wickRatio > 0.7 && bodyRatio < 0.2 && reversal) {
    return {
      score: 0.8,
      evidence: `Wick panjang (${(wickRatio * 100).toFixed(0)}% dari range) + body kecil + reversal candle -- pola stop-hunt klasik. Cuma dari klines (TANPA konfirmasi data liquidation, tool liquidation history sudah dihapus).`,
    };
  }
  if (wickRatio > 0.6) {
    return { score: 0.5, evidence: `Wick cukup panjang (${(wickRatio * 100).toFixed(0)}% dari range) tapi belum full pola stop-hunt (butuh body kecil + reversal).` };
  }
  return { score: 0.1, evidence: `Tidak ada wick signifikan (${(wickRatio * 100).toFixed(0)}% dari range).` };
}

export function calculateBasisArbScore(params: {
  basis: number;
  fundingRate: number;
  threshold: number;
  basisZScore?: number;
}): SignalScore {
  const { basis, fundingRate, threshold, basisZScore } = params;
  const fundingAbs = Math.abs(fundingRate);

  if (basisZScore !== undefined) {
    if (Math.abs(basisZScore) > 2 && fundingAbs > 0.0005) {
      return {
        score: 0.9,
        evidence: `Basis z-score ${basisZScore.toFixed(2)} (>2 std dev dari rata-rata 24 jam) + funding ${fmtPct(fundingRate, 4)} -- basis melebar ekstrem dgn konteks histori.`,
      };
    }
  } else if (Math.abs(basis) > threshold * 2) {
    return {
      score: 0.7,
      evidence: `Basis ${fmtPct(basis, 4)} melebihi 2x threshold (${fmtPct(threshold, 4)}), TAPI symbol ini di luar watchlist histori (BTC/ETH/SOL) jadi tanpa konteks z-score -- kurang akurat dibanding pair watchlist.`,
    };
  }
  if (Math.abs(basis) > threshold) {
    return { score: 0.5, evidence: `Basis ${fmtPct(basis, 4)} melebihi threshold default (${fmtPct(threshold, 4)}).` };
  }
  return { score: 0.1, evidence: `Basis ${fmtPct(basis, 4)} masih dalam rentang normal.` };
}

export function calculateOiDivergenceScore(params: { oiChangePct: number; priceChangePct: number }): SignalScore {
  const { oiChangePct, priceChangePct } = params;

  if (oiChangePct > 5 && Math.abs(priceChangePct) < 1) {
    return {
      score: 0.8,
      evidence: `OI naik ${oiChangePct.toFixed(2)}% tapi harga flat (${priceChangePct.toFixed(2)}%) -- posisi baru dibuka tanpa dorongan harga signifikan.`,
    };
  }
  if (oiChangePct > 3 && priceChangePct * oiChangePct < 0) {
    return {
      score: 0.7,
      evidence: `OI naik ${oiChangePct.toFixed(2)}% berlawanan arah sama harga (${priceChangePct.toFixed(2)}%) -- indikasi short/long accumulation.`,
    };
  }
  return { score: 0.1, evidence: `OI dan harga bergerak searah/tidak signifikan (OI ${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}%, harga ${priceChangePct.toFixed(2)}%).` };
}

export function calculateFundingExtremeScore(params: { fundingRate: number; threshold: number }): SignalScore {
  const { fundingRate, threshold } = params;
  const funding = Math.abs(fundingRate);

  if (funding > threshold * 3) return { score: 1.0, evidence: `Funding ${fmtPct(fundingRate, 4)} lebih dari 3x threshold (${fmtPct(threshold, 4)}) -- ekstrem.` };
  if (funding > threshold * 2) return { score: 0.8, evidence: `Funding ${fmtPct(fundingRate, 4)} lebih dari 2x threshold.` };
  if (funding > threshold) return { score: 0.6, evidence: `Funding ${fmtPct(fundingRate, 4)} melebihi threshold.` };
  return { score: (funding / threshold) * 0.5, evidence: `Funding ${fmtPct(fundingRate, 4)} masih di bawah threshold (${fmtPct(threshold, 4)}).` };
}

export type MmTier = "Weak" | "Moderate" | "Strong" | "Extreme";

export function classifyTier(totalScore: number): MmTier {
  if (totalScore < 2) return "Weak";
  if (totalScore < 3.5) return "Moderate";
  if (totalScore < 5) return "Strong";
  return "Extreme";
}

export interface MmSignals {
  absorption: SignalScore;
  spoofing: SignalScore;
  stopHunt: SignalScore;
  basisArb: SignalScore;
  oiDivergence: SignalScore;
  fundingExtreme: SignalScore;
}

export async function computeMmSignals(symbol: string): Promise<MmSignals> {
  const [orderBook, aggTrades, ticker24hr, oiCurrent, oiHist, funding, klines, threshold] = await Promise.all([
    binanceProxy.getOrderBookDepth(symbol, 20),
    binanceProxy.getAggTrades(symbol, 100),
    binanceProxy.getTicker24hrNative(symbol),
    binanceProxy.getOpenInterestNative(symbol),
    binanceProxy.getOpenInterestHistNative(symbol, "1h", 2),
    binanceProxy.getCurrentFundingRateNative(symbol),
    binanceProxy.getKlinesNative(symbol, "1h", 20),
    getPairThreshold(symbol),
  ]);

  // Basis: butuh harga spot, TANPA harga spot skor basis fallback ke
  // "tidak tersedia" (0.1) dan dicatat di evidence -- banyak pair
  // futures-only gak listed di Spot sama sekali.
  let spotPrice: number | null = null;
  try {
    const spot = await binanceProxy.getSpotPrice(symbol);
    spotPrice = parseFloat(spot.price);
  } catch {
    spotPrice = null;
  }

  const cvd = computeCvdFromTrades(aggTrades);
  const { changePct: priceChangePct, candles } = summarizeKlines(klines);
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  const oiCurrentVal = parseFloat(oiCurrent.openInterest);
  const oiPrevVal = parseFloat(oiHist[0]?.sumOpenInterest ?? String(oiCurrentVal));
  const oiChangePct = oiPrevVal !== 0 ? ((oiCurrentVal - oiPrevVal) / oiPrevVal) * 100 : 0;

  const markPrice = parseFloat(funding.markPrice);
  const fundingRate = parseFloat(funding.lastFundingRate);
  const basis = spotPrice !== null && spotPrice !== 0 ? (markPrice - spotPrice) / spotPrice : 0;

  let basisZScore: number | undefined;
  if (spotPrice !== null && (SNAPSHOT_WATCHLIST as readonly string[]).includes(symbol)) {
    const history = await queryMarketSnapshots(symbol, 24);
    const values = history.map((p) => p.basis).filter((v): v is number => v !== null);
    if (values.length >= 10) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);
      basisZScore = std > 0 ? (basis - mean) / std : 0;
    }
  }

  const bestBidQty = orderBook.bids[0] ? parseFloat(orderBook.bids[0][1]) : 0;
  const bestAskQty = orderBook.asks[0] ? parseFloat(orderBook.asks[0][1]) : 0;
  const bestBidPrice = orderBook.bids[0] ? parseFloat(orderBook.bids[0][0]) : 0;
  const bestAskPrice = orderBook.asks[0] ? parseFloat(orderBook.asks[0][0]) : 0;
  const spreadPct = bestBidPrice > 0 ? ((bestAskPrice - bestBidPrice) / bestBidPrice) * 100 : 0;
  const volume24h = parseFloat(ticker24hr.volume);

  return {
    absorption: calculateAbsorptionScore({ cvdBuyPct: cvd.buyPct, priceChangePct, oiChangePct }),
    spoofing: calculateSpoofingScore({ bestBidQty, bestAskQty, spreadPct, volume24h }),
    stopHunt: lastCandle && prevCandle
      ? calculateStopHuntScore({
          high: lastCandle.high,
          low: lastCandle.low,
          open: lastCandle.open,
          close: lastCandle.close,
          prevOpen: prevCandle.open,
          prevClose: prevCandle.close,
        })
      : { score: 0.1, evidence: "Candle tidak cukup untuk analisis stop-hunt." },
    basisArb: calculateBasisArbScore({
      basis,
      fundingRate,
      threshold: threshold?.basisThreshold ?? DEFAULT_BASIS_THRESHOLD,
      basisZScore,
    }),
    oiDivergence: calculateOiDivergenceScore({ oiChangePct, priceChangePct }),
    fundingExtreme: calculateFundingExtremeScore({
      fundingRate,
      threshold: threshold?.fundingThreshold ?? DEFAULT_FUNDING_THRESHOLD,
    }),
  };
}

export function registerMmDetectionTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_detect_mm_activity",
    {
      title: "Deteksi Aktivitas Market Maker / Whale (Composite Score)",
      description:
        "Gabungkan 6 sinyal (absorption, spoofing, stop-hunt, basis arbitrage, OI divergence, funding extreme) jadi " +
        "1 skor + tier (Weak/Moderate/Strong/Extreme) -- ganti 5-6 tool call manual. BUKAN rekomendasi trading. " +
        "PENTING: spoofing & stop-hunt heuristik 1-snapshot (confidence lebih rendah dari 4 sinyal lain) -- lihat " +
        "docs/mm_detection_framework.md untuk batasan lengkap. Snapshot juga disimpan tiap 5 menit ke D1 " +
        "(binance_backtest_signal untuk validasi empiris).",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const signals = await computeMmSignals(symbol);
        const totalScore = Object.values(signals).reduce((sum, s) => sum + s.score, 0);
        const tier = classifyTier(totalScore);
        const activeSignals = Object.entries(signals)
          .filter(([, s]) => s.score >= 0.6)
          .map(([k]) => k);

        // Bullet reasoning dibatasi ke sinyal AKTIF (skor >=0.6) saja, maks 6
        // (jumlah sinyal maksimum yang ada) -- evidence LENGKAP semua 6 sinyal
        // tetap reachable via structuredContent.signals, cuma teks yang dipangkas.
        const builder = new ToolResponseBuilder()
          .header(`${symbol} — MM/Whale Activity`)
          .row("Tier", `${tier} (skor ${totalScore.toFixed(2)}/6)`);

        if (activeSignals.length > 0) {
          for (const name of activeSignals.slice(0, 6)) {
            builder.row(name, signals[name as keyof MmSignals].evidence);
          }
        } else {
          builder.row("Sinyal Aktif", "tidak ada (semua skor <0.6)");
        }

        builder
          .note("Bukan rekomendasi trading. Evidence lengkap 6 sinyal ada di structuredContent.signals.")
          .struct("symbol", symbol)
          .struct("tier", tier)
          .struct("totalScore", totalScore)
          .struct("activeSignals", activeSignals)
          .struct("signals", signals);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

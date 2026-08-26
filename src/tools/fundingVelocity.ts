// compute_funding_velocity -- pure calculation, TIDAK fetch dari Binance
// sendiri. fundingHistory diinjeksi caller (mis. hasil
// binance_get_funding_rate_history sebelumnya).
//
// Velocity dihitung via OLS (ordinary least squares) linear regression
// penuh atas SEMUA titik di window, BUKAN perbandingan 2-titik endpoint --
// itu bug versi lama yang sengaja diperbaiki di sini (2 titik endpoint bisa
// sama nilainya walau ada lonjakan besar di tengah window, keliatan "flat"
// padahal ada spike). maxStepDelta melengkapi ini: perubahan absolut
// terbesar antar titik BERURUTAN, nangkep spike-lalu-reversal yang bikin
// slope net mendekati nol tapi jelas BUKAN kondisi datar/stabil.
//
// SENGAJA gak ada label kategorikal (mis. "STABLE"/"RISING") -- ambang buat
// label kayak gitu belum divalidasi ke data real, cuma angka mentah yang
// dikembalikan.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, fundingRateHistoryPointSchema, errorResultWithCode } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { isChronological } from "../toolHelpers.js";
import type { FundingRateHistoryPoint } from "../binanceProxyClient.js";

const HOUR_MS = 3_600_000;

export interface FundingVelocityResult {
  olsVelocityPerHour: number;
  maxStepDelta: number;
  pointsUsed: number;
  windowStartMs: number;
  windowEndMs: number;
  errorCode?: "INSUFFICIENT_POINTS" | "MALFORMED_PAYLOAD" | "NON_CHRONOLOGICAL" | "NON_POSITIVE_ELAPSED_TIME";
}

const EMPTY_RESULT: Omit<FundingVelocityResult, "errorCode"> = {
  olsVelocityPerHour: 0,
  maxStepDelta: 0,
  pointsUsed: 0,
  windowStartMs: 0,
  windowEndMs: 0,
};

export function computeFundingVelocity(
  history: FundingRateHistoryPoint[],
  velocityWindowIntervals: number,
): FundingVelocityResult {
  const window = history.slice(-velocityWindowIntervals);

  if (window.length < 2) {
    return { ...EMPTY_RESULT, errorCode: "INSUFFICIENT_POINTS" };
  }

  const rates: number[] = [];
  for (const p of window) {
    const r = parseFloat(p.fundingRate);
    if (!Number.isFinite(r)) {
      return { ...EMPTY_RESULT, errorCode: "MALFORMED_PAYLOAD" };
    }
    rates.push(r);
  }

  // Ditambah 2026-08-27: cek non-decreasing EKSPLISIT di tiap pasangan
  // berurutan, bukan cuma windowEnd-windowStart > 0 -- itu bisa lolos
  // meski titik TENGAH kebalik urutan (mis. fundingTime [0, 20000, 10000]
  // punya end-start positif walau titik ke-2 dan ke-3 kebalik). Gap yang
  // sama ditemukan & diperbaiki dulu di whalescope_get_oi_velocity, lalu
  // di-porting balik ke sini -- lihat isChronological (toolHelpers.ts),
  // shared sama taker_imbalance_aggregator dan oi_velocity.
  if (!isChronological(window, (p) => p.fundingTime)) {
    return { ...EMPTY_RESULT, errorCode: "NON_CHRONOLOGICAL" };
  }

  const windowStartMs = window[0].fundingTime;
  const windowEndMs = window[window.length - 1].fundingTime;
  if (windowEndMs - windowStartMs <= 0) {
    return { ...EMPTY_RESULT, windowStartMs, windowEndMs, errorCode: "NON_POSITIVE_ELAPSED_TIME" };
  }

  // t dalam JAM sejak titik pertama window -- pakai timestamp ASLI tiap
  // titik (bukan asumsi interval genap), meski interval funding Binance
  // nominal tetap (biasanya 8 jam).
  const t = window.map((p) => (p.fundingTime - windowStartMs) / HOUR_MS);
  const n = t.length;
  const sumT = t.reduce((a, b) => a + b, 0);
  const sumFr = rates.reduce((a, b) => a + b, 0);
  const sumTFr = t.reduce((acc, ti, i) => acc + ti * rates[i], 0);
  const sumT2 = t.reduce((acc, ti) => acc + ti * ti, 0);

  const denominator = n * sumT2 - sumT * sumT;
  const olsVelocityPerHour = denominator !== 0 ? (n * sumTFr - sumT * sumFr) / denominator : 0;

  let maxStepDelta = 0;
  for (let i = 1; i < rates.length; i++) {
    const delta = Math.abs(rates[i] - rates[i - 1]);
    if (delta > maxStepDelta) maxStepDelta = delta;
  }

  return { olsVelocityPerHour, maxStepDelta, pointsUsed: n, windowStartMs, windowEndMs };
}

export function registerFundingVelocityTools(server: McpServer): void {
  registerSafeTool(
    server,
    "compute_funding_velocity",
    {
      title: "Kecepatan Perubahan Funding Rate (OLS)",
      description:
        "Hitung kecepatan perubahan funding rate (per jam) via regresi linear (OLS) penuh atas window terakhir, " +
        "PLUS lonjakan terbesar antar titik berurutan (maxStepDelta) -- nangkep spike-lalu-reversal yang bikin slope " +
        "net mendekati nol tapi bukan berarti stabil. History diinjeksi caller (BUKAN fetch sendiri -- pass hasil " +
        "binance_get_funding_rate_history). TIDAK ada label kategorikal, angka mentah saja.",
      inputSchema: {
        symbol: symbolSchema.optional(),
        fundingHistory: z.array(fundingRateHistoryPointSchema).min(2).max(1000),
        velocityWindowIntervals: z
          .number()
          .int()
          .min(2)
          .max(1000)
          .default(4)
          .describe("Jumlah titik funding TERAKHIR yang dipakai buat regresi, default 4."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, fundingHistory, velocityWindowIntervals }) => {
      const result = computeFundingVelocity(fundingHistory, velocityWindowIntervals);

      if (result.errorCode) {
        const messages: Record<string, string> = {
          INSUFFICIENT_POINTS: `Kurang dari 2 titik funding rate dalam window${symbol ? ` untuk ${symbol}` : ""} -- gak bisa hitung velocity.`,
          MALFORMED_PAYLOAD: `Ada fundingRate yang gak bisa di-parse jadi angka${symbol ? ` untuk ${symbol}` : ""}.`,
          NON_CHRONOLOGICAL: `Array fundingHistory TIDAK urut waktu naik (fundingTime non-decreasing)${symbol ? ` untuk ${symbol}` : ""}.`,
          NON_POSITIVE_ELAPSED_TIME: `Semua titik dalam window punya timestamp yang sama${symbol ? ` untuk ${symbol}` : ""}.`,
        };
        return errorResultWithCode(result.errorCode, messages[result.errorCode], { symbol });
      }

      const builder = new ToolResponseBuilder()
        .header(`Funding Velocity${symbol ? ` — ${symbol}` : ""}`)
        .row("OLS Velocity (per jam)", result.olsVelocityPerHour.toFixed(8))
        .row("Max Step Delta", result.maxStepDelta.toFixed(8))
        .row("Titik Dipakai", String(result.pointsUsed))
        .note("Angka mentah saja -- gak ada label kategorikal (STABLE/RISING/dst), ambang buat label belum divalidasi ke data real.")
        .struct("symbol", symbol)
        .struct("olsVelocityPerHour", result.olsVelocityPerHour)
        .struct("maxStepDelta", result.maxStepDelta)
        .struct("pointsUsed", result.pointsUsed)
        .struct("windowStartMs", result.windowStartMs)
        .struct("windowEndMs", result.windowEndMs);

      return builder.build();
    },
  );
}

// whalescope_get_oi_velocity -- pure calculation, TIDAK fetch dari Binance
// sendiri. oiHistory diinjeksi caller (mis. hasil
// binance_get_open_interest_history sebelumnya, native Binance shape dari
// /futures/data/openInterestHist).
//
// Method PERSIS sama dengan compute_funding_velocity (fundingVelocity.ts):
// velocity dihitung via OLS (ordinary least squares) linear regression penuh
// atas SEMUA titik di window, BUKAN perbandingan 2-titik endpoint. maxStepDelta
// melengkapi ini: perubahan absolut terbesar antar titik BERURUTAN, nangkep
// spike-lalu-reversal yang bikin slope net mendekati nol tapi jelas BUKAN
// kondisi datar/stabil.
//
// SENGAJA gak ada label kategorikal (mis. "EXPANDING"/"STABLE") -- ambang
// buat label kayak gitu belum divalidasi ke data real, sama alasan yang
// bikin compute_funding_velocity gak punya label juga.
//
// Field nilai yang dipakai: sumOpenInterest (kuantitas base-asset), BUKAN
// sumOpenInterestValue (notional quote-asset) -- konsisten sama tool yang
// udah ada (binance_get_open_interest_history / openInterest.ts) yang juga
// pakai sumOpenInterest sebagai field kuantitas utamanya.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, openInterestHistPointSchema, errorResultWithCode } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { isChronological } from "../toolHelpers.js";
import type { OpenInterestHistPoint } from "../binanceProxyClient.js";

const HOUR_MS = 3_600_000;

export interface OiVelocityResult {
  oiVelocityPerHour: number;
  maxStepDelta: number;
  pointsUsed: number;
  windowStartMs: number;
  windowEndMs: number;
  errorCode?: "INSUFFICIENT_POINTS" | "MALFORMED_PAYLOAD" | "NON_CHRONOLOGICAL" | "NON_POSITIVE_ELAPSED_TIME";
}

const EMPTY_RESULT: Omit<OiVelocityResult, "errorCode"> = {
  oiVelocityPerHour: 0,
  maxStepDelta: 0,
  pointsUsed: 0,
  windowStartMs: 0,
  windowEndMs: 0,
};

export function computeOiVelocity(history: OpenInterestHistPoint[], velocityWindowIntervals: number): OiVelocityResult {
  const window = history.slice(-velocityWindowIntervals);

  // Minimum matematis buat OLS: sebuah garis butuh MINIMAL 2 titik beda --
  // ini bukan angka pilihan bebas, sama batas yang dipakai compute_funding_velocity.
  if (window.length < 2) {
    return { ...EMPTY_RESULT, errorCode: "INSUFFICIENT_POINTS" };
  }

  const values: number[] = [];
  for (const p of window) {
    const v = parseFloat(p.sumOpenInterest);
    if (!Number.isFinite(v)) {
      return { ...EMPTY_RESULT, errorCode: "MALFORMED_PAYLOAD" };
    }
    values.push(v);
  }

  if (!isChronological(window, (p) => p.timestamp)) {
    return { ...EMPTY_RESULT, errorCode: "NON_CHRONOLOGICAL" };
  }

  const windowStartMs = window[0].timestamp;
  const windowEndMs = window[window.length - 1].timestamp;
  if (windowEndMs - windowStartMs <= 0) {
    return { ...EMPTY_RESULT, windowStartMs, windowEndMs, errorCode: "NON_POSITIVE_ELAPSED_TIME" };
  }

  // t dalam JAM sejak titik pertama window -- pakai timestamp ASLI tiap
  // titik (bukan asumsi interval genap), sama pola fundingVelocity, karena
  // period openInterestHist (5m/15m/1h/4h/1d) bisa macam-macam.
  const t = window.map((p) => (p.timestamp - windowStartMs) / HOUR_MS);
  const n = t.length;
  const sumT = t.reduce((a, b) => a + b, 0);
  const sumV = values.reduce((a, b) => a + b, 0);
  const sumTV = t.reduce((acc, ti, i) => acc + ti * values[i], 0);
  const sumT2 = t.reduce((acc, ti) => acc + ti * ti, 0);

  const denominator = n * sumT2 - sumT * sumT;
  const oiVelocityPerHour = denominator !== 0 ? (n * sumTV - sumT * sumV) / denominator : 0;

  let maxStepDelta = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = Math.abs(values[i] - values[i - 1]);
    if (delta > maxStepDelta) maxStepDelta = delta;
  }

  return { oiVelocityPerHour, maxStepDelta, pointsUsed: n, windowStartMs, windowEndMs };
}

export function registerOiVelocityTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_get_oi_velocity",
    {
      title: "Kecepatan Perubahan Open Interest (OLS)",
      description:
        "Hitung kecepatan perubahan open interest (per jam) via regresi linear (OLS) penuh atas window terakhir, " +
        "PLUS lonjakan terbesar antar titik berurutan (maxStepDelta) -- nangkep spike-lalu-reversal yang bikin slope " +
        "net mendekati nol tapi bukan berarti stabil. Sama metode persis dengan compute_funding_velocity. History " +
        "diinjeksi caller (BUKAN fetch sendiri -- pass hasil binance_get_open_interest_history). Pakai field " +
        "sumOpenInterest (kuantitas base-asset). TIDAK ada label kategorikal, angka mentah saja.",
      inputSchema: {
        symbol: symbolSchema.optional(),
        oiHistory: z.array(openInterestHistPointSchema).min(2).max(1000),
        velocityWindowIntervals: z
          .number()
          .int()
          .min(2)
          .max(1000)
          .default(4)
          .describe("Jumlah titik OI TERAKHIR yang dipakai buat regresi, default 4 (sama default compute_funding_velocity)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, oiHistory, velocityWindowIntervals }) => {
      const result = computeOiVelocity(oiHistory, velocityWindowIntervals);

      if (result.errorCode) {
        const messages: Record<string, string> = {
          INSUFFICIENT_POINTS: `Kurang dari 2 titik open interest dalam window${symbol ? ` untuk ${symbol}` : ""} -- gak bisa hitung velocity.`,
          MALFORMED_PAYLOAD: `Ada sumOpenInterest yang gak bisa di-parse jadi angka${symbol ? ` untuk ${symbol}` : ""}.`,
          NON_CHRONOLOGICAL: `Array oiHistory TIDAK urut waktu naik (timestamp non-decreasing)${symbol ? ` untuk ${symbol}` : ""}.`,
          NON_POSITIVE_ELAPSED_TIME: `Semua titik dalam window punya timestamp yang sama${symbol ? ` untuk ${symbol}` : ""}.`,
        };
        return errorResultWithCode(result.errorCode, messages[result.errorCode], { symbol });
      }

      const builder = new ToolResponseBuilder()
        .header(`OI Velocity${symbol ? ` — ${symbol}` : ""}`)
        .row("OLS Velocity (per jam)", result.oiVelocityPerHour.toFixed(4))
        .row("Max Step Delta", result.maxStepDelta.toFixed(4))
        .row("Titik Dipakai", String(result.pointsUsed))
        .note("Angka mentah saja -- gak ada label kategorikal (EXPANDING/STABLE/dst), ambang buat label belum divalidasi ke data real.")
        .struct("symbol", symbol)
        .struct("oiVelocityPerHour", result.oiVelocityPerHour)
        .struct("maxStepDelta", result.maxStepDelta)
        .struct("pointsUsed", result.pointsUsed)
        .struct("windowStartMs", result.windowStartMs)
        .struct("windowEndMs", result.windowEndMs);

      return builder.build();
    },
  );
}

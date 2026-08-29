// whalescope_detect_liquidity_sweep -- MCP tool tipis di atas
// detectLiquiditySweep (liquiditySweepEngine.ts, pure). Tool ini yang
// FETCH (klines + aggTrades berjendela + OI history + force orders lewat
// proxy relay yang sudah ada), lalu mengalirkan datanya ke engine.
//
// TIDAK menyentuh entryAlertCron / fullPipeline sama sekali -- modul baru
// yang berdiri sendiri, cuma didaftarkan tambahan di server.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fetchAggTradesForWindow } from "../aggTradesPaginator.js";
import { computeOiVelocity, type OiVelocityResult } from "./oiVelocity.js";
import {
  detectLiquiditySweep,
  DEFAULT_ATR_SWEEP_MULT,
  type LiquidationLite,
} from "./liquiditySweepEngine.js";
import {
  summarizeKlines,
  computeCvdFromTrades,
  computeATR,
  type KlineCandle,
} from "../toolHelpers.js";
import { symbolSchema, KLINE_INTERVAL_ENUM, FUTURES_DATA_PERIOD_ENUM, errorResult } from "../shared.js";
import { fmtPrice } from "../format.js";

const INTERVAL_MINUTES: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "6h": 360,
  "12h": 720,
  "1d": 1440,
};

// Endpoint /futures/data/openInterestHist tidak punya "1m" -- pakai "5m"
// sebagai granularitas terdekat kalau interval candle-nya 1m.
function oiPeriodFor(interval: string): (typeof FUTURES_DATA_PERIOD_ENUM)[number] {
  return (FUTURES_DATA_PERIOD_ENUM as readonly string[]).includes(interval)
    ? (interval as (typeof FUTURES_DATA_PERIOD_ENUM)[number])
    : "5m";
}

function splitCvd(trades: { T: number; q: string; m: boolean }[], activeOpen: number, priorOpen: number) {
  const active = trades.filter((t) => t.T >= activeOpen);
  const prior = trades.filter((t) => t.T >= priorOpen && t.T < activeOpen);
  return {
    activeCvd: computeCvdFromTrades(active as Parameters<typeof computeCvdFromTrades>[0]),
    priorCvd: computeCvdFromTrades(prior as Parameters<typeof computeCvdFromTrades>[0]),
  };
}

export function registerLiquiditySweepTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_detect_liquidity_sweep",
    {
      title: "Deteksi Liquidity Sweep (Mean Reversion Pasca-Stop Run)",
      description:
        "Deteksi pola liquidity sweep: candle aktif menembus swing high/low yang dibentuk candle SEBELUMNYA " +
        "(terisolasi, tanpa candle aktif), lalu ditutup KEMBALI di dalam range, dikonfirmasi CVD absorption + " +
        "OI flush + (opsional) liquidation cluster. Fetch klines + aggTrades berjendela + OI history + force orders " +
        "lewat proxy relay, lalu jalankan engine murni. Fault-tolerant: verdict tetap valid kalau data liquidation " +
        "kosong/gagal (bersandar OI velocity + CVD absorption).",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(KLINE_INTERVAL_ENUM)
          .default("15m")
          .describe("Timeframe candle, default 15m."),
        lookbackBars: z
          .number()
          .int()
          .min(3)
          .max(200)
          .default(20)
          .describe("Jumlah candle historis (mengecualikan candle aktif) untuk swing high/low terisolasi, default 20."),
        atrSweepMult: z
          .number()
          .positive()
          .max(10)
          .default(DEFAULT_ATR_SWEEP_MULT)
          .describe(`Budget penetrasi wick dalam kelipatan ATR14, default ${DEFAULT_ATR_SWEEP_MULT}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, lookbackBars, atrSweepMult }) => {
      try {
        const intervalMin = INTERVAL_MINUTES[interval] ?? 15;
        // Cukup candle untuk lookback + candle aktif + seed ATR(14) Wilder.
        const klineLimit = Math.min(1500, Math.max(lookbackBars + 30, 60));

        const raw = await binanceProxy.getKlinesNative(symbol, interval, klineLimit);
        if (raw.length === 0) {
          return errorResult(new Error(`Tidak ada data candle untuk ${symbol} @ ${interval}.`));
        }
        const { candles } = summarizeKlines(raw);
        if (candles.length < 3) {
          return errorResult(new Error(`Candle tidak cukup untuk analisis sweep (${candles.length}).`));
        }

        const active = candles[candles.length - 1] as KlineCandle;
        const prior = candles[candles.length - 2] as KlineCandle;

        // aggTrades berjendela: cover candle aktif + candle pembanding (2x interval),
        // plus sedikit margin. maxPages ditahan rendah -- ini tool on-demand,
        // bukan cron, tapi window 2 candle 15m di pair likuid tetap bisa besar.
        const windowMinutes = intervalMin * 2 + 1;
        let trades: { T: number; q: string; m: boolean }[] = [];
        let tradesInsufficient = false;
        try {
          const paged = await fetchAggTradesForWindow(symbol, "futures", windowMinutes, 40);
          trades = paged.trades;
          tradesInsufficient = paged.insufficientData;
        } catch (err) {
          tradesInsufficient = true;
          console.error(`[liquidity-sweep] aggTrades gagal ${symbol}:`, (err as Error)?.message ?? String(err));
        }
        const { activeCvd, priorCvd } = splitCvd(trades, active.openTime, prior.openTime);

        // OI history -> velocity. Gagal = null (engine fault-tolerant).
        let oiVelocity: OiVelocityResult | null = null;
        try {
          const oiHist = await binanceProxy.getOpenInterestHistNative(symbol, oiPeriodFor(interval), 6);
          if (Array.isArray(oiHist) && oiHist.length >= 2) {
            const v = computeOiVelocity(oiHist, Math.min(oiHist.length, 4));
            oiVelocity = v.errorCode ? null : v;
          }
        } catch (err) {
          console.error(`[liquidity-sweep] OI history gagal ${symbol}:`, (err as Error)?.message ?? String(err));
        }

        // Force orders sekitar window -> liquidations. Gagal/kosong = null.
        let liquidations: LiquidationLite[] | null = null;
        try {
          const startTime = prior.openTime;
          const endTime = active.openTime + intervalMin * 60_000;
          const forced = await binanceProxy.getAllForceOrders({ symbol, limit: 100, startTime, endTime });
          if (Array.isArray(forced) && forced.length > 0) {
            liquidations = forced
              .map((o) => {
                const price = parseFloat(String(o.price));
                const qty = parseFloat(String(o.origQty ?? o.executedQty ?? "0"));
                return {
                  side: String(o.side ?? ""),
                  price: Number.isFinite(price) ? price : 0,
                  notionalUsd: Number.isFinite(price) && Number.isFinite(qty) ? price * qty : 0,
                };
              })
              .filter((l) => l.side === "BUY" || l.side === "SELL");
            if (liquidations.length === 0) liquidations = null;
          }
        } catch (err) {
          console.error(`[liquidity-sweep] allForceOrders gagal ${symbol}:`, (err as Error)?.message ?? String(err));
        }

        const atr14 = computeATR(candles, 14);

        const result = detectLiquiditySweep({
          candles,
          lookbackBars,
          excludeLast: 1,
          atr14,
          atrSweepMult,
          activeCvd,
          priorCvd,
          oiVelocity,
          liquidations,
        });

        if (tradesInsufficient && !result.dataGaps.some((g) => /aggTrades/i.test(g))) {
          result.dataGaps.push("Window aggTrades tidak ter-cover penuh (rate-limit / histori pendek) -- CVD parsial.");
        }

        const builder = new ToolResponseBuilder()
          .header(`Liquidity Sweep — ${symbol} @ ${interval}`)
          .row("Verdict", result.isLiquiditySweep ? `SWEEP TERDETEKSI (${result.side})` : `BUKAN sweep (${result.side})`)
          .row("Direction", result.direction ?? "-")
          .row("Confidence", `${(result.confidence * 100).toFixed(0)}/100`)
          .row(
            "Swing terisolasi",
            `H ${fmtPrice(result.geometry.hRange)} / L ${fmtPrice(result.geometry.lRange)}`,
          )
          .row(
            "Candle aktif",
            `H ${fmtPrice(result.geometry.activeHigh)} / L ${fmtPrice(result.geometry.activeLow)} / C ${fmtPrice(result.geometry.activeClose)}`,
          )
          .row(
            "Penetrasi",
            `${fmtPrice(result.geometry.penetration)} (${result.geometry.penetrationAtr.toFixed(2)} ATR) · budget ${atrSweepMult} ATR · within=${result.geometry.withinAtrBudget} · reclaim=${result.geometry.reclaimed}`,
          )
          .row(
            "Order flow",
            `CVD aktif ${result.orderFlow.activeCvd.toFixed(2)} vs pembanding ${result.orderFlow.priorCvd.toFixed(2)} · absorption=${result.orderFlow.cvdAbsorption}`,
          )
          .row(
            "Open Interest",
            result.openInterest.available
              ? `velocity/jam ${result.openInterest.velocityPerHour?.toFixed(4)} · maxStepDelta ${result.openInterest.maxStepDelta?.toFixed(4)} · flush=${result.openInterest.flushDetected}`
              : "tidak tersedia",
          )
          .row(
            "Liquidations",
            result.liquidations.available
              ? `${result.liquidations.count} event · dominan ${result.liquidations.dominantSide} · confirm=${result.liquidations.clusterConfirms}`
              : "tidak tersedia / kosong",
          );

        if (result.confirmations.length > 0) {
          builder.subheader("Konfirmasi").table(["Sinyal"], result.confirmations.map((c) => [c]));
        }
        for (const reason of result.reasons) builder.row("•", reason);
        for (const gap of result.dataGaps) builder.warning(gap);

        builder
          .struct("symbol", symbol)
          .struct("interval", interval)
          .struct("lookbackBars", lookbackBars)
          .struct("isLiquiditySweep", result.isLiquiditySweep)
          .struct("side", result.side)
          .struct("direction", result.direction)
          .struct("confidence", result.confidence)
          .struct("atr14", atr14)
          .struct("geometry", result.geometry)
          .struct("orderFlow", result.orderFlow)
          .struct("openInterest", result.openInterest)
          .struct("liquidations", result.liquidations)
          .struct("confirmations", result.confirmations)
          .struct("dataGaps", result.dataGaps)
          .struct("reasons", result.reasons);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

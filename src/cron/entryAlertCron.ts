// Entry alert (Telegram) buat top-N pair Binance Futures USDT-M by 24h
// quote volume (ENTRY_WATCHLIST_SIZE, entryWatchlist.ts) -- dijalankan Cron
// Trigger terpisah
// (ENTRY_ALERT_CRON, lihat src/index.ts scheduled handler + wrangler.toml),
// offset dari grid `*/5`/`*/15` yang sudah ada supaya gak numpuk rate-limit
// proxy internal (rateLimiter.ts) di tick yang sama.
//
// Reuse LANGSUNG runPipelineForSymbol (src/tools/fullPipeline.ts) -- decision
// chain yang sama persis dengan whalescope_full_pipeline (LONG grid only,
// TRADE/WATCH/NO_TRADE), bukan logic baru. Dedup alert (TRADE dan WATCH,
// NO_TRADE gak pernah alert): kirim pas TRANSISI ke decision itu (termasuk
// WATCH->TRADE atau sebaliknya, beda decision = alert baru), ATAU kalau
// decision-nya SAMA kayak cycle lalu tapi cooldown 4 jam sejak alert
// terakhir sudah lewat (reminder, bukan spam tiap tick).
import {
  runPipelineForSymbol,
  type PipelineOpts,
  type SymbolPipelineResult,
  type PrefetchedTickerFunding,
} from "../tools/fullPipeline.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import { sendTelegramAlert, type TelegramEnv } from "../telegram.js";
import { getTopUsdtPerpetualWatchlist } from "../entryWatchlist.js";
import { mapWithConcurrency } from "../concurrency.js";
import { TRADE_RANKING_SCORE_THRESHOLD } from "../pipelineEngine.js";
import * as pacing from "../pacing.js";
import { fmtPrice } from "../format.js";

const COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Concurrency rendah (bukan default 6 whalescope_full_pipeline) -- watchlist
// di sini jauh lebih besar (400 vs maks 20/tool-call), jaga jarak dari
// MAX_REQUESTS_PER_WINDOW (rateLimiter.ts).
const CONCURRENCY = 4;

// PACING -- ditemukan live 2026-08-25 via wrangler tail: tanpa delay ini,
// 355/400 pair di watchlist gagal dalam 1 tick (346 kena RateLimitError
// self-throttle, sisanya bug parsing terpisah) karena seluruh batch nyoba
// habisin ~12-17 call/symbol SEKALIGUS di awal tick, jauh ngelewatin jatah
// per-menit yang dipakai bareng cron lain (rateLimiter.ts). Delay ini
// nge-pace throughput SENDIRI biar sebar sepanjang siklus 15 menit
// (ENTRY_ALERT_CRON), bukan burst di 60 detik pertama.
//
// Perhitungan (worst-case, hard screen lolos = 17 call/symbol):
// - Target throughput entry-alert sendiri: ~1.100-1.200 call/menit (jauh di
//   bawah limit ASLI Binance per-IP ~2400/menit -- proxy Vercel 1 IP dipakai
//   bareng semua cron, BUKAN cuma limiter internal kita).
// - 4 worker (CONCURRENCY) x 17 call / (network time + delay) <= target
//   -> delay ~4 detik/symbol/worker cukup (network time diasumsikan ~0.5-1s,
//   BELUM diukur presisi -- verifikasi live via wrangler tail setelah deploy,
//   sama seperti langkah verifikasi tiap kenaikan watchlist sebelumnya).
// - Total durasi estimasi: 400 pair / 4 worker = 100 putaran x ~4.8 detik
//   = ~8 menit -- jauh di bawah siklus 15 menit ke tick berikutnya.
export const ENTRY_ALERT_PACING_DELAY_MS = 4000;

// Mirror default zod schema whalescope_full_pipeline (src/tools/fullPipeline.ts)
// -- alert pakai parameter risiko/leverage yang SAMA dengan yang biasa dipakai
// manual lewat tool itu, supaya konsisten.
const DEFAULT_PIPELINE_OPTS: PipelineOpts = {
  riskUsd: 20,
  marginMode: "ISOLATED",
  maxLeverageOptions: [3, 5, 10],
  lookbackBars: 50,
  atrPeriod: 14,
  atrMult: 1.0,
  slExtraAtr: 1.5,
  slPctBuffer: 1.0,
  minQuoteVolumeUsd: 5_000_000,
  maxAbsFundingRate: 0.0005,
};

const ALERTABLE_DECISIONS = new Set(["TRADE", "WATCH"]);

// WATCH bisa terjadi karena 2 alasan berbeda (lihat decidePipelineOutcome,
// pipelineEngine.ts): grid risk HIGH_RISK (skor berapapun -- ini murni soal
// risiko EKSEKUSI grid, gak ada hubungan sama rankingScore, jadi tetap
// selalu alert independen dari band skor di bawah), ATAU rankingScore di
// bawah TRADE_RANKING_SCORE_THRESHOLD (kualitas sinyal arah). Buat alasan
// kedua, band 40-54 (WATCH_MIN_ALERT_SCORE s/d di bawah ambang TRADE) --
// di bawah 40 kebanyakan noise, >=55 udah wilayah TRADE (dijamin gak
// pernah kejadian dari decidePipelineOutcome asli, guard ini cuma jaga-jaga).
// User request 2026-08-26: revert dari versi sebelumnya yang mensyaratkan
// skor >=55 buat WATCH (itu sendiri revert dari versi PALING awal yang
// alert SEMUA WATCH tanpa filter skor sama sekali -- itu yang bikin skor
// di bawah 40 kebanjiran notif ke HP).
export const WATCH_MIN_ALERT_SCORE = 40;

function isAlertWorthy(result: SymbolPipelineResult): boolean {
  if (!ALERTABLE_DECISIONS.has(result.decision)) return false;
  if (result.decision === "TRADE") return true;
  if (result.risk?.gridRisk?.status === "HIGH_RISK") return true;
  return result.rankingScore >= WATCH_MIN_ALERT_SCORE && result.rankingScore < TRADE_RANKING_SCORE_THRESHOLD;
}

const DECISION_LABEL: Record<string, string> = {
  TRADE: "masuk TRADE (grid entry, whale-aligned)",
  WATCH: "masuk WATCH (mendekati entry, belum layak)",
};

const DECISION_ICON: Record<string, string> = {
  TRADE: "🟢",
  WATCH: "🟡",
};

function formatEntryAlert(result: SymbolPipelineResult): string {
  const icon = DECISION_ICON[result.decision] ?? "ℹ️";
  const lines = [
    `${icon} *${result.symbol}* ${DECISION_LABEL[result.decision] ?? result.decision}`,
    `📊 Ranking score: ${result.rankingScore.toFixed(1)}`,
  ];
  const g = result.gridBotConfig;
  if (g) {
    lines.push(
      "",
      `📈 Range: ${fmtPrice(g.lower)} - ${fmtPrice(g.upper)} (${g.gridType}, ${g.gridCount} grid)`,
      `⚙️ Leverage: ${g.leverage ?? "-"} (${g.marginMode})`,
      `🛑 SL: ${fmtPrice(g.stopLoss)}  🎯 TP: ${fmtPrice(g.takeProfit)}`,
    );
  }
  const sm = result.tier1?.smartMoney;
  if (sm) {
    lines.push(`🐋 ${sm.condition} · SM Bias ${sm.smartMoneyBias} vs Retail ${sm.retailSentiment}`);
  }
  return lines.join("\n");
}

export interface AlertCheckOutcome {
  decision: SymbolPipelineResult["decision"];
  hadError: boolean;
}

export async function checkEntryAlertForSymbol(
  symbol: string,
  env: TelegramEnv,
  now: number = Date.now(),
  prefetched?: PrefetchedTickerFunding,
): Promise<AlertCheckOutcome> {
  const result = await runPipelineForSymbol(symbol, DEFAULT_PIPELINE_OPTS, prefetched);
  // runPipelineForSymbol NEVER throws (catch internal -- lihat JSDoc-nya),
  // jadi kegagalan (termasuk RateLimitError self-throttle rateLimiter.ts)
  // masuk lewat result.error, bukan exception -- log eksplisit di sini
  // supaya kelihatan di `wrangler tail`, karena upsertEntryAlertState di
  // bawah cuma nyimpen lastDecision (mis. "NO_TRADE"), bukan alasannya.
  if (result.error) {
    console.error(`[entry-alert] ${symbol}:`, result.error);
  }
  const previous = await d1Client.getEntryAlertState(symbol);

  const isAlertable = isAlertWorthy(result);
  const isTransition = isAlertable && previous?.lastDecision !== result.decision;
  const cooldownExpired =
    isAlertable && previous?.lastAlertAt != null && now - previous.lastAlertAt > COOLDOWN_MS;

  if (isAlertable && (isTransition || cooldownExpired)) {
    await sendTelegramAlert(env, formatEntryAlert(result));
    await d1Client.upsertEntryAlertState({ symbol, lastDecision: result.decision, lastAlertAt: now });
    return { decision: result.decision, hadError: result.error != null };
  }

  await d1Client.upsertEntryAlertState({
    symbol,
    lastDecision: result.decision,
    lastAlertAt: previous?.lastAlertAt ?? null,
  });
  return { decision: result.decision, hadError: result.error != null };
}

// Bulk-fetch ticker24hr + premiumIndex SEKALI di awal tick (tanpa symbol
// param, Binance balikin semua pair) -- gantiin 2 dari ~8-13 call per-symbol
// Wave 1 (getTicker24hrNative + getCurrentFundingRateNative di
// fullPipeline.ts) yang tadinya kepanggil 500x/tick jadi cuma 2 call total.
// SENGAJA try/catch terpisah dari fan-out di bawah -- kalau bulk fetch ini
// gagal, `prefetched` tetap undefined dan checkEntryAlertForSymbol ->
// runPipelineForSymbol jatuh balik ke call per-symbol lama (PrefetchedTickerFunding
// opsional), bukan bikin seluruh tick gagal cuma gara-gara 1 dari 2 call ini.
async function fetchBulkTickerFunding(): Promise<PrefetchedTickerFunding | undefined> {
  try {
    const [tickerList, fundingList] = await Promise.all([
      binanceProxy.getAllTicker24hrNative(),
      binanceProxy.getBulkFundingRatesNative(),
    ]);
    return {
      ticker: new Map(tickerList.map((t) => [t.symbol, t])),
      funding: new Map(fundingList.map((f) => [f.symbol, f])),
    };
  } catch (err) {
    console.error(
      "[entry-alert] gagal bulk fetch ticker24hr/premiumIndex, fallback ke call per-symbol:",
      (err as Error)?.message ?? String(err),
    );
    return undefined;
  }
}

export async function runEntryAlertCheck(env: TelegramEnv): Promise<void> {
  const watchlist = await getTopUsdtPerpetualWatchlist();
  const now = Date.now();
  const prefetched = await fetchBulkTickerFunding();
  const outcomes = await mapWithConcurrency(watchlist, CONCURRENCY, async (symbol): Promise<AlertCheckOutcome> => {
    try {
      return await checkEntryAlertForSymbol(symbol, env, now, prefetched);
    } catch (err) {
      console.error(`[cron] gagal entry-alert check ${symbol}:`, (err as Error)?.message ?? String(err));
      return { decision: "NO_TRADE", hadError: true };
    } finally {
      await pacing.sleep(ENTRY_ALERT_PACING_DELAY_MS);
    }
  });

  // Rekam tally tick ini -- heartbeatCron.ts (3x/hari) pakai ini buat
  // bedain "market emang sepi" (error rate rendah) vs "backend bermasalah"
  // (error rate tinggi) pas gak ada alert TRADE/WATCH sama sekali dalam
  // window lookback-nya.
  await d1Client.insertEntryAlertRunLog({
    runAt: now,
    total: outcomes.length,
    errors: outcomes.filter((o) => o.hadError).length,
    watchCount: outcomes.filter((o) => o.decision === "WATCH").length,
    tradeCount: outcomes.filter((o) => o.decision === "TRADE").length,
  });
}

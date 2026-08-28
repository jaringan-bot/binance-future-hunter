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
import { sendTelegramAlert, escapeMarkdown, type TelegramEnv } from "../telegram.js";
import { selectUsdtPerpetualWatchlist } from "../entryWatchlist.js";
import { rankEntryCandidates, DEFAULT_ENTRY_TOP_N, type EntryRankingInput } from "../entryRanking.js";
import * as kvConfig from "../kvConfig.js";
import { mapWithConcurrency } from "../concurrency.js";
import { TRADE_RANKING_SCORE_THRESHOLD } from "../pipelineEngine.js";
import * as pacing from "../pacing.js";
import { fmtPrice } from "../format.js";

// KV key buat tuning N pre-filter Wave 1 TANPA redeploy code (tulis via
// dashboard KV / `wrangler kv key put`). Unset -> DEFAULT_ENTRY_TOP_N.
const ENTRY_TOP_N_KV_KEY = "entry_alert:top_n";

async function resolveEntryTopN(): Promise<number> {
  try {
    const raw = await kvConfig.getJson<number>(ENTRY_TOP_N_KV_KEY);
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ENTRY_TOP_N;
  } catch {
    return DEFAULT_ENTRY_TOP_N;
  }
}

const COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Concurrency rendah (bukan default 6 whalescope_full_pipeline) -- watchlist
// di sini jauh lebih besar (400 vs maks 20/tool-call), jaga jarak dari
// MAX_REQUESTS_PER_WINDOW (rateLimiter.ts).
//
// 4 -> 3 (2026-08-28): tiap whalescope_full_pipeline internal burst ~8 fetch
// paralel (2-wave). 4 pipeline paralel = ~32 request simultan -> spike rate
// yang trip Binance `-1003` walau rata-rata jauh di bawah limit. 3 nurunin
// peak burst ~25%, wall-clock ~8.7 menit (250 pair / 3, masih < cap 15 menit).
// Bagian mitigasi IP rate-ban ([[project_whalescope_vps_ip_ratelimit]]).
const CONCURRENCY = 3;

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
//
// 4000 -> 5500ms (2026-08-28): dipasangkan dengan ENTRY_WATCHLIST_SIZE
// 350->250 (entryWatchlist.ts) + MAX_REQUESTS_PER_WINDOW 1800->1400
// (rateLimiter.ts) setelah IP VPS relay tunggal kena Binance 418 -1003
// weight-ban (lihat [[project_whalescope_vps_ip_ratelimit]]). 250 pair / 4
// worker x ~6.3 detik = ~6.6 menit wall-clock (masih < 15 menit), throughput
// entry-alert turun ke ~570 call/menit.
export const ENTRY_ALERT_PACING_DELAY_MS = 5500;

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
    `${icon} *${escapeMarkdown(result.symbol)}* ${escapeMarkdown(DECISION_LABEL[result.decision] ?? result.decision)}`,
    `📊 Ranking score: ${result.rankingScore.toFixed(1)}`,
  ];
  const g = result.gridBotConfig;
  if (g) {
    lines.push(
      "",
      `📈 Range: ${fmtPrice(g.lower)} - ${fmtPrice(g.upper)} (${escapeMarkdown(g.gridType)}, ${g.gridCount} grid)`,
      `⚙️ Leverage: ${g.leverage ?? "-"} (${escapeMarkdown(g.marginMode)})`,
      `🛑 SL: ${fmtPrice(g.stopLoss)}  🎯 TP: ${fmtPrice(g.takeProfit)}`,
    );
  }
  const sm = result.tier1?.smartMoney;
  if (sm) {
    lines.push(
      `🐋 ${escapeMarkdown(sm.condition)} · SM Bias ${escapeMarkdown(sm.smartMoneyBias)} vs Retail ${escapeMarkdown(sm.retailSentiment)}`,
    );
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

interface WatchlistBundle {
  watchlist: string[];
  prefetched: PrefetchedTickerFunding | undefined;
}

// Resolve watchlist + prefetch Map ticker24hr/premiumIndex dalam SATU set
// fetch per tick. Dulu 4 subrequest: getFuturesExchangeInfo +
// getAllTicker24hrNative (di getTopUsdtPerpetualWatchlist) + LAGI
// getAllTicker24hrNative + getBulkFundingRatesNative (di fetchBulkTickerFunding
// lama). Sekarang 3: exchangeInfo + ticker24hr + premiumIndex, masing-masing
// SEKALI -- response ticker24hr yang SAMA dipakai buat seleksi watchlist DAN
// Map prefetch.
//
// exchangeInfo + ticker24hr WAJIB sukses: tanpa keduanya tidak ada watchlist
// dan tick tidak bisa jalan (perilaku sama dengan getTopUsdtPerpetualWatchlist
// lama yang throw). premiumIndex TERPISAH try/catch: gagal di situ = prefetched
// undefined -> runPipelineForSymbol jatuh balik ke fetch ticker+funding
// per-symbol (PrefetchedTickerFunding opsional), BUKAN menggagalkan tick.
async function resolveWatchlistAndPrefetch(): Promise<WatchlistBundle> {
  const [exchangeInfo, tickerList] = await Promise.all([
    binanceProxy.getFuturesExchangeInfo(),
    binanceProxy.getAllTicker24hrNative(),
  ]);
  const watchlist = selectUsdtPerpetualWatchlist(exchangeInfo.symbols, tickerList);

  let prefetched: PrefetchedTickerFunding | undefined;
  try {
    const fundingList = await binanceProxy.getBulkFundingRatesNative();
    prefetched = {
      ticker: new Map(tickerList.map((t) => [t.symbol, t])),
      funding: new Map(fundingList.map((f) => [f.symbol, f])),
    };
  } catch (err) {
    console.error(
      "[entry-alert] gagal bulk fetch premiumIndex, fallback ke call per-symbol:",
      (err as Error)?.message ?? String(err),
    );
    prefetched = undefined;
  }
  return { watchlist, prefetched };
}

// Pre-filter Wave 1 (STEP 2a): dari watchlist penuh ambil TOP-N pair
// (entryRanking.ts), SISANYA di-skip total. Butuh `prefetched` (funding +
// ticker) buat sinyal ranking -- kalau premiumIndex gagal tadi (prefetched
// undefined), pre-filter DIMATIKAN tick ini: proses watchlist penuh, JANGAN
// diam-diam skip pair berdasarkan data yang tidak lengkap.
async function applyEntryPrefilter(
  watchlist: string[],
  prefetched: PrefetchedTickerFunding | undefined,
  now: number,
): Promise<string[]> {
  if (!prefetched) {
    console.error("[entry-alert] premiumIndex tidak tersedia -- pre-filter Wave 1 dimatikan tick ini, proses watchlist penuh");
    return watchlist;
  }

  const topN = await resolveEntryTopN();
  if (topN >= watchlist.length) return watchlist;

  const candidates: EntryRankingInput[] = watchlist.map((symbol) => {
    const funding = prefetched.funding.get(symbol);
    const ticker = prefetched.ticker.get(symbol);
    const fundingAbs = funding ? Math.abs(parseFloat(funding.lastFundingRate)) : 0;
    const priceChangePct24h = ticker ? parseFloat(ticker.priceChangePercent) : 0;
    const quoteVolumeUsd = ticker ? parseFloat(ticker.quoteVolume) : 0;
    return {
      symbol,
      quoteVolumeUsd: Number.isFinite(quoteVolumeUsd) ? quoteVolumeUsd : 0,
      fundingAbs: Number.isFinite(fundingAbs) ? fundingAbs : 0,
      priceChangePct24h: Number.isFinite(priceChangePct24h) ? priceChangePct24h : 0,
    };
  });

  const selected = rankEntryCandidates(candidates, topN);
  const selectedSet = new Set(selected);
  const skipped = watchlist.filter((s) => !selectedSet.has(s));

  // Audit trail (entry_alert_skip_log, D1) -- daftar SYMBOL yang di-skip,
  // dicek belakangan apakah ada setup bagus yang kelewat. Best-effort:
  // kegagalan D1 di sini TIDAK boleh menggagalkan tick (skip-list juga
  // ada di log baris di bawah buat `wrangler tail`).
  await d1Client
    .insertEntryAlertSkipLog({ runAt: now, skippedSymbols: skipped, topN })
    .catch((err) => console.error("[entry-prefilter] gagal insert entry_alert_skip_log:", (err as Error)?.message ?? String(err)));
  console.log(`[entry-prefilter] top_n=${topN} analysed=${selected.length} skipped=${skipped.length} skipped_symbols=${skipped.join(",")}`);

  return selected;
}

export async function runEntryAlertCheck(env: TelegramEnv): Promise<void> {
  const now = Date.now();
  const { watchlist, prefetched } = await resolveWatchlistAndPrefetch();
  const analysed = await applyEntryPrefilter(watchlist, prefetched, now);
  const outcomes = await mapWithConcurrency(analysed, CONCURRENCY, async (symbol): Promise<AlertCheckOutcome> => {
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

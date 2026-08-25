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
import { runPipelineForSymbol, type PipelineOpts, type SymbolPipelineResult } from "../tools/fullPipeline.js";
import * as d1Client from "../d1Client.js";
import { sendTelegramAlert, type TelegramEnv } from "../telegram.js";
import { getTopUsdtPerpetualWatchlist } from "../entryWatchlist.js";
import { mapWithConcurrency } from "../concurrency.js";

const COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Concurrency rendah (bukan default 6 whalescope_full_pipeline) -- watchlist
// di sini jauh lebih besar (200 vs maks 20/tool-call), jaga jarak dari
// MAX_REQUESTS_PER_WINDOW (rateLimiter.ts).
const CONCURRENCY = 4;

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

const DECISION_LABEL: Record<string, string> = {
  TRADE: "masuk TRADE (grid entry, whale-aligned)",
  WATCH: "masuk WATCH (mendekati entry, belum layak)",
};

function formatEntryAlert(result: SymbolPipelineResult): string {
  const lines = [`*${result.symbol}* ${DECISION_LABEL[result.decision] ?? result.decision}`, `Ranking score: ${result.rankingScore}`];
  const g = result.gridBotConfig;
  if (g) {
    lines.push(`Range: ${g.lower} - ${g.upper} (${g.gridType}, ${g.gridCount} grid)`);
    lines.push(`Leverage: ${g.leverage ?? "-"} (${g.marginMode})`);
    lines.push(`SL: ${g.stopLoss} / TP: ${g.takeProfit}`);
  }
  return lines.join("\n");
}

export async function checkEntryAlertForSymbol(symbol: string, env: TelegramEnv, now: number = Date.now()): Promise<void> {
  const result = await runPipelineForSymbol(symbol, DEFAULT_PIPELINE_OPTS);
  const previous = await d1Client.getEntryAlertState(symbol);

  const isAlertable = ALERTABLE_DECISIONS.has(result.decision);
  const isTransition = isAlertable && previous?.lastDecision !== result.decision;
  const cooldownExpired =
    isAlertable && previous?.lastAlertAt != null && now - previous.lastAlertAt > COOLDOWN_MS;

  if (isAlertable && (isTransition || cooldownExpired)) {
    await sendTelegramAlert(env, formatEntryAlert(result));
    await d1Client.upsertEntryAlertState({ symbol, lastDecision: result.decision, lastAlertAt: now });
    return;
  }

  await d1Client.upsertEntryAlertState({
    symbol,
    lastDecision: result.decision,
    lastAlertAt: previous?.lastAlertAt ?? null,
  });
}

export async function runEntryAlertCheck(env: TelegramEnv): Promise<void> {
  const watchlist = await getTopUsdtPerpetualWatchlist();
  const now = Date.now();
  await mapWithConcurrency(watchlist, CONCURRENCY, async (symbol) => {
    try {
      await checkEntryAlertForSymbol(symbol, env, now);
    } catch (err) {
      console.error(`[cron] gagal entry-alert check ${symbol}:`, (err as Error)?.message ?? String(err));
    }
  });
}

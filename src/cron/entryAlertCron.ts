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
  runTriplePipelineForSymbol,
  type PipelineOpts,
  type SymbolPipelineResult,
  type PrefetchedTickerFunding,
  type TriplePipelineResult,
  type DcaOpts,
} from "../tools/fullPipeline.js";
import { DCA_MODAL_DEFAULT_USD, type DcaHeadResult } from "../dcaPipelineEngine.js";
import type { DcaSmartMoneyResult } from "./dcaSmartMoneyAdapter.js";
import type { TraditionalFuturesResult } from "./traditionalPipelineEngine.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import { escapeMarkdown, formatTraditionalFuturesAlert } from "../telegram.js";
import { dispatchNotification, type NotifyEnv } from "../notify.js";
import { selectUsdtPerpetualWatchlist } from "../entryWatchlist.js";
import {
  selectEntryCandidates,
  DEFAULT_ENTRY_TOP_N,
  DEFAULT_EXTREMITY_FRACTION,
  type EntryRankingInput,
} from "../entryRanking.js";
import * as kvConfig from "../kvConfig.js";
import { mapWithConcurrency } from "../concurrency.js";
import { TRADE_RANKING_SCORE_THRESHOLD } from "../pipelineEngine.js";
import { toPipelineDecisionLogRow } from "../pipelineDecisionLog.js";
import * as pacing from "../pacing.js";
import { fmtPrice } from "../format.js";
import * as riskCircuit from "../engine/riskCircuitBreaker.js";

// KV key buat tuning N pre-filter Wave 1 TANPA redeploy code (tulis via
// dashboard KV / `wrangler kv key put`). Unset -> DEFAULT_ENTRY_TOP_N.
const ENTRY_TOP_N_KV_KEY = "entry_alert:top_n";
// KV key buat modal referensi head DCA (capital-solve base-order margin).
// Alert tidak punya konteks saldo akun -- ini cuma angka acuan yang
// user-scale. Unset -> DCA_MODAL_DEFAULT_USD ($200).
const ENTRY_DCA_MODAL_KV_KEY = "entry_alert:dca_modal_usd";
// KV key buat rasio kuota extremity Phase 1 (G6). Unset -> default.
const ENTRY_EXTREMITY_FRAC_KV_KEY = "entry_alert:extremity_frac";

// ─────────────────────────────────────────────────────────────
// HEAD YANG BOLEH MENGIRIM ALERT -- keputusan user 2026-09-05:
// "hentikan dulu alert DCA dan Traditional, saya mau fokus di grid dulu".
//
// DEFAULT-nya grid saja, jadi kode ini MENGATAKAN apa yang sedang berlaku.
// Menghidupkan lagi = satu tulis KV, TANPA redeploy:
//   wrangler kv key put --binding CONFIG_KV "entry_alert:heads" '{"grid":true,"dca":true,"trad":true}'
//
// YANG DIMATIKAN HANYA NOTIFIKASI. Ketiga head TETAP dihitung (biayanya
// ~0 subrequest tambahan -- mereka memakai data Wave 1/2 yang sama), dan
// keputusannya TETAP masuk entry_alert_run_log. Itu disengaja: kalau
// perhitungannya ikut dimatikan, T9 (logging outcome DCA/Traditional) akan
// kehilangan jam nol lagi saat head-nya dihidupkan kembali.
//
// CATATAN KOPLING yang SENGAJA tidak diubah: string dedup `composite` tetap
// memuat ketiga head. Mengubahnya jadi grid-saja akan membuat SETIAP symbol
// terlihat "berubah" pada tick pertama setelah deploy -- satu ledakan alert
// sekali jalan. Efek sampingnya: flip DCA/Traditional yang tidak terlihat
// masih bisa me-reset dedup sehingga alert GRID yang sama terkirim ulang
// lebih cepat. Itu noise, bukan alert head terlarang. Kalau terbukti
// mengganggu, perbaikannya butuh migrasi state dedup, bukan tambalan di sini.
// ─────────────────────────────────────────────────────────────
const ENTRY_HEADS_KV_KEY = "entry_alert:heads";

export interface EnabledHeads {
  grid: boolean;
  dca: boolean;
  trad: boolean;
}

export const DEFAULT_ENABLED_HEADS: EnabledHeads = { grid: true, dca: false, trad: false };

/**
 * Fail-safe ke DEFAULT saat KV kosong/rusak/error -- sama seperti
 * resolveEntryTopN(). Bentuk yang tidak dikenal TIDAK dianggap "semua nyala":
 * lebih baik diam daripada mengirim head yang sudah diminta berhenti.
 */
export function parseEnabledHeads(raw: unknown): EnabledHeads {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_ENABLED_HEADS;
  const o = raw as Record<string, unknown>;
  const pick = (k: keyof EnabledHeads) => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_ENABLED_HEADS[k]);
  return { grid: pick("grid"), dca: pick("dca"), trad: pick("trad") };
}

export async function resolveEnabledHeads(): Promise<EnabledHeads> {
  try {
    return parseEnabledHeads(await kvConfig.getJson<unknown>(ENTRY_HEADS_KV_KEY));
  } catch {
    return DEFAULT_ENABLED_HEADS;
  }
}

async function resolveEntryTopN(): Promise<number> {
  try {
    const raw = await kvConfig.getJson<number>(ENTRY_TOP_N_KV_KEY);
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ENTRY_TOP_N;
  } catch {
    return DEFAULT_ENTRY_TOP_N;
  }
}

async function resolveExtremityFraction(): Promise<number> {
  try {
    const raw = await kvConfig.getJson<number>(ENTRY_EXTREMITY_FRAC_KV_KEY);
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_EXTREMITY_FRACTION;
  } catch {
    return DEFAULT_EXTREMITY_FRACTION;
  }
}

async function resolveDcaModalUsd(): Promise<number> {
  try {
    const raw = await kvConfig.getJson<number>(ENTRY_DCA_MODAL_KV_KEY);
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DCA_MODAL_DEFAULT_USD;
  } catch {
    return DCA_MODAL_DEFAULT_USD;
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
// 5500 -> 2000ms (2026-08-30): Phase 2 cuma TOP 40 (bukan 250 deep-run).
// 40 / CONCURRENCY=3 ≈ 14 putaran x (I/O + 2s) tetap jauh di bawah 3 menit
// wall. CONCURRENCY tetap 3 supaya peak burst Wave 2 gak trip Binance -1003.
export const ENTRY_ALERT_PACING_DELAY_MS = 2000;

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

// G1 (2026-09-04, Stage 2). Ambang bawah WATCH; TIDAK ada batas atas.
//
// CACAT LAMA: `score >= 50 && score < 55`. decidePipelineOutcome() memberi
// WATCH untuk gridRiskStatus HIGH_RISK BERAPA PUN skornya, jadi setup skor
// 72 + HIGH_RISK jatuh di luar pita [50,55) dan HILANG DIAM-DIAM --
// sementara setup skor 51 + SAFE tetap dikirim. Justru kombinasi
// "skor tinggi tapi risiko tinggi" yang paling perlu dilihat manusia.
export const WATCH_MIN_ALERT_SCORE = 50;
// Dispatch floor terpisah dari engine DCA_WATCH_MIN_ALERT_SCORE (50) --
// engine tetap boleh WATCH dari 50, Telegram cuma kirim >= 65.
export const DCA_WATCH_TELEGRAM_MIN_SCORE = 65;

function isGridAlertWorthy(result: SymbolPipelineResult): boolean {
  if (!ALERTABLE_DECISIONS.has(result.decision)) return false;
  if (result.decision === "TRADE") return true;
  return result.rankingScore >= WATCH_MIN_ALERT_SCORE;
}

/** WATCH karena risiko (bukan karena skor kurang) -- ditandai beda di alert. */
function isHighRiskWatch(result: SymbolPipelineResult): boolean {
  return (
    result.decision === "WATCH" &&
    result.rankingScore >= TRADE_RANKING_SCORE_THRESHOLD &&
    result.risk?.gridRisk?.status === "HIGH_RISK"
  );
}

function dcaWatchScore(dca: DcaHeadResult, dcaSm?: DcaSmartMoneyResult | null): number {
  return dcaSm ? dcaSm.timingScore : dca.confidence;
}

// ─────────────────────────────────────────────────────────────
// K1 (2026-09-04, Stage 1 signal-integrity) -- LEGACY ENGINE ADALAH PRE-GATE
// WAJIB, V3 ADAPTER CUMA BOLEH MENURUNKAN.
//
// CACAT YANG DITUTUP: versi lama fungsi ini berbentuk
//     if (dcaSm) { ...lihat dcaSm.decision saja...; return false; }
// sehingga begitu DCA Smart Money V3 aktif (dan dia SELALU aktif, karena
// `dca.direction` tidak pernah null -- `base()` di dcaPipelineEngine.ts
// selalu mengisi direction bahkan di jalur reject), `dca.decision` TIDAK
// PERNAH dibaca. Delapan hard gate keselamatan di evaluateDcaEntry() jadi
// mati total:
//     liquidity ($8M) · dead_market (ADX4H<12) · strong_trend_4h ·
//     macro_overextended · macro_trend_opposing · funding_extreme (>0.03%) ·
//     Hard Neutral Cap (NEUTRAL tak pernah TRADE) · capital_solve_infeasible
// Artinya DCA bisa alert LONG melawan downtrend 1D, di pair tipis, dengan
// funding ekstrem, tanpa solusi sizing yang muat di budget rugi $20.
//
// Sekarang: keputusan efektif = SEVERITY MINIMUM dari kedua engine.
// V3 tidak pernah bisa menaikkan legacy; legacy tidak pernah bisa menaikkan
// V3. Konsekuensi yang DIHARAPKAN: volume alert DCA turun tajam -- itu
// tujuannya, bukan regresi. Jangan "perbaiki" dengan melonggarkan gate.
// ─────────────────────────────────────────────────────────────
export type EffectiveDcaDecision = "DCA_TRADE" | "DCA_WATCH" | "DCA_BLOCKED";

/** Rank severity: 2 = boleh entry, 1 = boleh watch, 0 = blokir. */
function dcaRank(decision: string): 0 | 1 | 2 {
  if (decision === "DCA_TRADE") return 2;
  if (decision === "DCA_WATCH") return 1;
  return 0;
}

/**
 * Keputusan DCA efektif + siapa yang membatasi. `blockedBy` dipakai untuk
 * pesan alert supaya alasan penolakan tidak hilang (mis. legacy menolak
 * `funding_extreme` sementara V3 bilang TRADE).
 */
export function effectiveDcaDecision(
  dca: DcaHeadResult,
  dcaSm?: DcaSmartMoneyResult | null,
): { decision: EffectiveDcaDecision; blockedBy: "legacy" | "smart_money" | null } {
  const legacyRank = dcaRank(dca.decision);
  const smRank = dcaSm ? dcaRank(dcaSm.decision) : 2; // tanpa V3, legacy yang menentukan
  const rank = Math.min(legacyRank, smRank) as 0 | 1 | 2;

  let blockedBy: "legacy" | "smart_money" | null = null;
  if (rank < legacyRank || rank < smRank) blockedBy = legacyRank <= smRank ? "legacy" : "smart_money";
  else if (rank === 0) blockedBy = legacyRank <= smRank ? "legacy" : "smart_money";

  if (rank === 2) return { decision: "DCA_TRADE", blockedBy: null };
  if (rank === 1) return { decision: "DCA_WATCH", blockedBy };
  return { decision: "DCA_BLOCKED", blockedBy };
}

// DCA_TRADE alert HANYA kalau parameter risiko lengkap (K2 fail-closed --
// lihat komentar di formatEntryAlert). DCA_WATCH alert kalau skor Telegram
// >= 65; WATCH sengaja TIDAK butuh dcaBotConfig karena memang bukan ajakan
// entry -- tapi teksnya wajib jelas menyatakan itu.
function isDcaAlertWorthy(dca: DcaHeadResult, dcaSm?: DcaSmartMoneyResult | null): boolean {
  const { decision } = effectiveDcaDecision(dca, dcaSm);
  if (decision === "DCA_TRADE") {
    // K2: tanpa dcaBotConfig, alert "LAYAK ENTRY" tidak punya SL / leverage /
    // sizing / proyeksi max-loss. Fail-closed.
    return dca.dcaBotConfig != null;
  }
  if (decision === "DCA_WATCH") return dcaWatchScore(dca, dcaSm) >= DCA_WATCH_TELEGRAM_MIN_SCORE;
  return false;
}

// Traditional Futures: HANYA TRAD_TRADE yang alert (bracket lolos quality
// filter RR>=1.5 + skenario valid). TRAD_WATCH sengaja TIDAK alert -- head ini
// baru live, jaga volume notif rendah dulu (bisa dilonggarkan nanti seperti
// yang dilakukan buat WATCH grid/DCA).
function isTradAlertWorthy(trad: TraditionalFuturesResult): boolean {
  return trad.decision === "TRAD_TRADE";
}

// Slot DCA untuk composite dedup -- SENGAJA mempertahankan keputusan MENTAH
// tiap engine (bukan yang efektif) supaya transisi internal (mis. V3
// PAUSE_SOFT -> WATCH selagi legacy tetap NO_TRADE) tetap terlihat sebagai
// perubahan state dan tidak tertelan cooldown 4 jam.
function dcaHeadDecision(r: TriplePipelineResult): string {
  return r.dcaSm ? `${r.dca.decision}+${r.dcaSm.decision}` : r.dca.decision;
}

/** Keputusan yang DITAMPILKAN ke user -- hasil pre-gate, bukan mentah. */
function dcaDisplayDecision(r: TriplePipelineResult): EffectiveDcaDecision {
  return effectiveDcaDecision(r.dca, r.dcaSm).decision;
}

/**
 * `enabled` ikut di sini, bukan cuma di classifyAlertHeads(): head yang
 * dibisukan tidak boleh menyumbang ke notifikasi circuit harian. Kalau tidak,
 * DCA_TRADE yang tidak pernah dikirim tetap memicu pesan "circuit terbuka",
 * dan user diberi tahu soal head yang sudah ia minta berhenti.
 */
function countTradeHeads(r: TriplePipelineResult, enabled: EnabledHeads): number {
  let n = 0;
  if (enabled.grid && r.grid.decision === "TRADE" && isGridAlertWorthy(r.grid)) n += 1;
  if (enabled.dca && dcaDisplayDecision(r) === "DCA_TRADE" && isDcaAlertWorthy(r.dca, r.dcaSm)) n += 1;
  if (enabled.trad && isTradAlertWorthy(r.trad)) n += 1;
  return n;
}

export function classifyAlertHeads(
  r: TriplePipelineResult,
  muteTrade: boolean,
  enabled: EnabledHeads,
): {
  gridOn: boolean;
  dcaOn: boolean;
  tradOn: boolean;
  alertable: boolean;
} {
  // `enabled` dicek DULUAN dan berupa AND: apa pun hasil head-nya, kalau ia
  // dimatikan ia tidak pernah on. Menaruhnya di belakang akan membuat satu
  // cabang baru di masa depan bisa melewatinya.
  const gridOn = enabled.grid && isGridAlertWorthy(r.grid) && !(muteTrade && r.grid.decision === "TRADE");
  const dcaOn =
    enabled.dca && isDcaAlertWorthy(r.dca, r.dcaSm) && !(muteTrade && dcaDisplayDecision(r) === "DCA_TRADE");
  const tradOn = enabled.trad && isTradAlertWorthy(r.trad) && !muteTrade;
  return { gridOn, dcaOn, tradOn, alertable: gridOn || dcaOn || tradOn };
}

// ─────────────────────────────────────────────────────────────
// K2 (2026-09-04, Stage 1) -- INVARIANT GUARD SEBELUM KIRIM.
//
// CACAT YANG DITUTUP: alert bisa terkirim bertuliskan "🔵 DCA LAYAK ENTRY"
// tanpa satu pun parameter risiko, karena `dcaBotConfig` hanya terisi saat
// LEGACY engine bilang DCA_TRADE, sementara gate lama cuma melihat V3.
// Ketiga cabang blok DCA di formatEntryAlert() meleset, jadi tidak ada blok
// yang tercetak sama sekali -- user menerima ajakan entry tanpa SL.
//
// isDcaAlertWorthy() sudah fail-closed, tapi guard ini adalah jaring kedua
// yang tidak bergantung pada satu fungsi: SETIAP head yang mengaku
// actionable WAJIB membawa stop-loss, apa pun jalur kodenya. Kalau tidak,
// alert dibatalkan dan dicatat -- lebih baik kehilangan satu notifikasi
// daripada mengirim ajakan entry tanpa batas rugi.
// ─────────────────────────────────────────────────────────────
export function findMissingRiskParams(r: TriplePipelineResult, heads: { gridOn: boolean; dcaOn: boolean; tradOn: boolean }): string | null {
  if (heads.gridOn && r.grid.decision === "TRADE") {
    const sl = r.grid.gridBotConfig?.stopLoss;
    if (sl == null || !Number.isFinite(sl) || sl <= 0) return "grid TRADE tanpa stopLoss valid";
  }
  if (heads.dcaOn && dcaDisplayDecision(r) === "DCA_TRADE") {
    const cfg = r.dca.dcaBotConfig;
    if (cfg == null) return "DCA TRADE tanpa dcaBotConfig";
    if (!Number.isFinite(cfg.stopLossPrice) || cfg.stopLossPrice <= 0) return "DCA TRADE tanpa stopLossPrice valid";
    if (!Number.isFinite(cfg.leverage) || cfg.leverage <= 0) return "DCA TRADE tanpa leverage valid";
  }
  if (heads.tradOn) {
    const sl = r.trad.stopLoss;
    if (sl == null || !Number.isFinite(sl) || sl <= 0) return "Traditional TRADE tanpa stopLoss valid";
  }
  return null;
}

// Penanda Telegram: 🟢/🟡 grid (tak berubah), 🔵/🟠 DCA.
const GRID_ICON: Record<string, string> = { TRADE: "🟢", WATCH: "🟡" };
const DCA_ICON: Record<string, string> = { DCA_TRADE: "🔵", DCA_WATCH: "🟠", DCA_PAUSE_SOFT: "⏸️", DCA_PAUSE_HARD: "🧊", DCA_STOP: "🚨" };
const GRID_LABEL: Record<string, string> = {
  TRADE: "GRID TRADE (grid entry, whale-aligned)",
  WATCH: "GRID WATCH (mendekati entry, belum layak)",
};
const DCA_LABEL: Record<string, string> = {
  DCA_TRADE: "DCA LAYAK ENTRY",
  DCA_WATCH: "DCA TUNGGU",
  DCA_BLOCKED: "DCA DITOLAK",
  DCA_PAUSE_SOFT: "DCA PAUSE SOFT",
  DCA_PAUSE_HARD: "DCA PAUSE HARD",
  DCA_STOP: "DCA PLAN INVALIDATED",
};

function formatEntryAlert(
  r: TriplePipelineResult,
  muteTrade = false,
  enabled: EnabledHeads = DEFAULT_ENABLED_HEADS,
): string {
  const { grid, dca, trad, dcaSm } = r;
  // Badan alert memakai flag YANG SAMA dengan gerbang kirim -- kalau tidak,
  // pesan bisa memuat blok DCA/Traditional untuk head yang sudah dibisukan.
  const { gridOn, dcaOn, tradOn } = classifyAlertHeads(r, muteTrade, enabled);
  const sm = grid.tier1?.smartMoney;
  const dcaDir = dca.direction ? ` (${dca.direction})` : "";
  // K1: yang ditampilkan adalah keputusan EFEKTIF (hasil pre-gate legacy x
  // V3), bukan `dcaSm.decision` mentah -- kalau tidak, alert bisa berbunyi
  // "DCA LAYAK ENTRY" padahal legacy engine menolaknya.
  const dcaHeadDecision = dcaDisplayDecision(r);
  const dcaHeadLabel = DCA_LABEL[dcaHeadDecision] ?? dcaHeadDecision;

  const headMarkers =
    `${gridOn ? GRID_ICON[grid.decision] ?? "" : ""}${dcaOn ? DCA_ICON[dcaHeadDecision] ?? "" : ""}${tradOn ? "⚡" : ""}` || "ℹ️";
  const headParts: string[] = [];
  if (gridOn) {
    headParts.push(
      isHighRiskWatch(grid)
        ? escapeMarkdown(`GRID WATCH ⚠️ HIGH RISK (skor ${grid.rankingScore.toFixed(0)} tinggi, tapi risk engine HIGH_RISK — jangan entry mentah)`)
        : escapeMarkdown(GRID_LABEL[grid.decision] ?? grid.decision),
    );
  }
  if (dcaOn) headParts.push(`${escapeMarkdown(dcaHeadLabel)}${dcaDir}`);
  if (tradOn) headParts.push(`TRADITIONAL FUTURES (${escapeMarkdown(`[SCENARIO: ${trad.scenario}]`)})`);

  const lines = [
    `${headMarkers} *${escapeMarkdown(grid.symbol)}* — ${headParts.join(" · ")}`,
    dcaSm
      ? `📊 Grid ${grid.rankingScore.toFixed(1)}/100 · DCA SM timing ${dcaSm.timingScore.toFixed(0)}/100 · safety ${dcaSm.safetyScore.toFixed(0)}/100 · VolTier ${dca.volTier}`
      : `📊 Grid ${grid.rankingScore.toFixed(1)}/100 · DCA ${dca.confidence}/100 · VolTier ${dca.volTier}`,
  ];
  if (sm) {
    lines.push(
      `🐋 ${escapeMarkdown(sm.condition)} · SM Bias ${escapeMarkdown(sm.smartMoneyBias)} vs Retail ${escapeMarkdown(sm.retailSentiment)}`,
    );
  }

  // ── GRID block ──
  const g = grid.gridBotConfig;
  if (gridOn && g) {
    lines.push(
      "",
      "📈 GRID",
      `   Range ${fmtPrice(g.lower)} – ${fmtPrice(g.upper)} (${escapeMarkdown(g.gridType)}, ${g.gridCount} grid)`,
      `   Lev ${g.leverage ?? "-"}x ${escapeMarkdown(g.marginMode)} · SL ${fmtPrice(g.stopLoss)} · TP ${fmtPrice(g.takeProfit)}`,
    );
  } else if (!gridOn) {
    lines.push("", `GRID: ${escapeMarkdown(grid.decision)}${grid.hardScreen.reasons[0] ? ` (${escapeMarkdown(grid.hardScreen.reasons[0].slice(0, 80))})` : ""}`);
  }

  // ── DCA block ──
  const d = dca.dcaBotConfig;
  if (dcaSm && dcaOn) {
    lines.push(
      "",
      `🔷 DCA Smart Money V3 (${dcaSm.entryCount + 1}/${dcaSm.maxEntries}${dcaDir})`,
      `   Timing ${dcaSm.timingScore.toFixed(0)}/100 · Safety ${dcaSm.safetyScore.toFixed(0)}/100 · Pause ${escapeMarkdown(dcaSm.pauseLevel)}`,
      `   Interval ${dcaSm.intervalPct.toFixed(2)}% · Next trigger ${fmtPrice(dcaSm.nextTriggerPrice)}`,
      dcaSm.pauseReason ? `   ⏸ ${escapeMarkdown(dcaSm.pauseReason)}` : "",
    );
    if (dcaSm.decision === "DCA_STOP") {
      lines.push("   🚨 \\[DCA PLAN INVALIDATED \\- MANUAL REVIEW REQUIRED\\]");
    }
  }
  // K2: cabang di bawah WAJIB total (setiap kemungkinan tercetak). Versi
  // lama punya lubang -- `dcaOn && dca.decision === "DCA_WATCH" && !dcaSm`
  // tidak pernah benar saat dcaSm ada, jadi kombinasi (dcaOn = true,
  // dcaBotConfig = null, dcaSm != null) jatuh ke antara semua cabang dan
  // TIDAK mencetak apa pun: header berbunyi "DCA LAYAK ENTRY" tanpa satu
  // baris parameter risiko. Sekarang: kalau ada config -> cetak penuh;
  // kalau tidak dan head aktif -> cetak WATCH eksplisit ("bukan ajakan
  // entry"); kalau head mati -> cetak alasan tolak.
  if (dcaOn && d) {
    lines.push(
      "",
      `🔷 DCA (${d.direction}, Moderate)`,
      `   Price drop step ${d.priceDropStepPct}% · dev ×${d.priceDeviationMultiplier} · maks ${d.maxDcaOrders} order`,
      `   TP/round ${d.takeProfitPerRoundPct}% · Lev ${d.leverage}x`,
      `   Base/DCA order ${d.baseOrderMarginUsd} USDT (modal ref $${d.modalRefUsd})`,
      `   SL ${d.stopLossPct}% (${fmtPrice(d.stopLossPrice)}) · est. liq ~${fmtPrice(d.estLiquidationPrice)} · proj. max loss $${d.projectedMaxLossUsd}`,
      `   Total accumulation Base→Max DCA: ${d.totalAccumulationDistPct}%`,
      "   ⚠️ taker-ratio & wall-persistence di-proxy; " + (dca.effCapAdx1d ? `1D cap ${dca.effCapAdx1d}` : "1D cap n/a"),
    );
  } else if (dcaOn) {
    // WATCH: sengaja TANPA parameter entry. Teksnya harus menyatakan itu
    // supaya tidak terbaca sebagai ajakan entry yang kebetulan tidak lengkap.
    lines.push(
      "",
      `🟠 DCA TUNGGU${dcaDir} — skor ${dcaWatchScore(dca, dcaSm).toFixed(0)}/100. BUKAN sinyal entry: belum ada SL/leverage/sizing.` +
        (dca.rejectReason ? ` (${escapeMarkdown(dca.rejectReason)})` : ""),
    );
  } else {
    lines.push(`DCA: Tolak${dca.rejectReason ? ` (${escapeMarkdown(dca.rejectReason)})` : ""}`);
  }

  // ── TRADITIONAL FUTURES block ──
  if (tradOn) {
    lines.push("", formatTraditionalFuturesAlert(grid.symbol, trad, grid, dca));
  }

  return lines.join("\n");
}

export interface AlertCheckOutcome {
  gridDecision: SymbolPipelineResult["decision"];
  dcaDecision: DcaHeadResult["decision"];
  tradDecision: TraditionalFuturesResult["decision"];
  hadError: boolean;
  /** Compact grid decision for pipeline_decision_log -- absent kalau pipeline throw sebelum ada result. */
  decisionLog?: ReturnType<typeof toPipelineDecisionLogRow>;
}

export async function checkEntryAlertForSymbol(
  symbol: string,
  env: NotifyEnv,
  now: number = Date.now(),
  prefetched?: PrefetchedTickerFunding,
  dcaOpts: DcaOpts = { modalAvailableUsd: DCA_MODAL_DEFAULT_USD },
): Promise<AlertCheckOutcome> {
  const r = await runTriplePipelineForSymbol(symbol, DEFAULT_PIPELINE_OPTS, dcaOpts, prefetched);
  // runTriplePipelineForSymbol NEVER throws (catch internal) -- kegagalan masuk
  // lewat grid.error, bukan exception. Log eksplisit supaya kelihatan di tail.
  if (r.grid.error) {
    console.error(`[entry-alert] ${symbol}:`, r.grid.error);
  }
  const previous = await d1Client.getEntryAlertState(symbol);

  // Dedup: composite "grid/dca/trad" string. Transisi = string berubah (head
  // mana pun flip -> alert gabungan yang nunjukin state ketiga head). Cooldown
  // 4 jam pakai satu timestamp. Slot tengah pakai dcaSm.decision kalau ada
  // supaya PAUSE_SOFT (yang tidak alert) -> TRADE/WATCH tetap ketahuan
  // sebagai transisi, bukan tertelan cooldown slot legacy.
  const dcaSlot = dcaHeadDecision(r);
  const composite = `${r.grid.decision}/${dcaSlot}/${r.trad.decision}`;
  const muteTrade = await riskCircuit.isDailyLossCircuitOpen();
  const enabled = await resolveEnabledHeads();
  const tradeHeads = countTradeHeads(r, enabled);
  if (muteTrade && tradeHeads > 0) {
    await maybeNotifyDailyCircuit(env, now);
  }
  const heads = classifyAlertHeads(r, muteTrade, enabled);
  // K2 jaring kedua: apa pun jalur kodenya, head yang mengaku actionable
  // WAJIB membawa stop-loss. Kalau tidak, alert DIBATALKAN (bukan dikirim
  // sebagian) -- state tetap di-upsert supaya dedup/cooldown konsisten.
  const missingRisk = findMissingRiskParams(r, heads);
  if (missingRisk !== null) {
    console.error(`[entry-alert] ${symbol}: alert DIBATALKAN -- ${missingRisk}. Ini bug, bukan kondisi pasar.`);
  }
  const alertable = heads.alertable && missingRisk === null;
  const isTransition = alertable && previous?.lastDecision !== composite;
  const cooldownExpired =
    alertable && previous?.lastAlertAt != null && now - previous.lastAlertAt > COOLDOWN_MS;

  const outcome: AlertCheckOutcome = {
    gridDecision: r.grid.decision,
    dcaDecision: r.dca.decision,
    tradDecision: r.trad.decision,
    hadError: r.grid.error != null,
    decisionLog: toPipelineDecisionLogRow(r.grid, now, "entry_alert"),
  };

  if (alertable && (isTransition || cooldownExpired)) {
    await dispatchNotification(env, formatEntryAlert(r, muteTrade, enabled));
    await d1Client.upsertEntryAlertState({ symbol, lastDecision: composite, lastAlertAt: now });
    if (!muteTrade && tradeHeads > 0) {
      await riskCircuit.recordTradeAlert(DEFAULT_PIPELINE_OPTS.riskUsd, tradeHeads, now);
    }
    await persistDcaActivePlan(symbol, r, now);
    return outcome;
  }

  await d1Client.upsertEntryAlertState({
    symbol,
    lastDecision: composite,
    lastAlertAt: previous?.lastAlertAt ?? null,
  });
  await persistDcaActivePlan(symbol, r, now);
  return outcome;
}

// ─────────────────────────────────────────────────────────────
// D1 (2026-09-04, Stage 2) -- "STATEFUL DCA PLAN" AKHIRNYA STATEFUL.
//
// CACAT LAMA: `entryCount: existing?.entryCount ?? dcaSm.entryCount` DITULIS
// ke D1, tapi tidak pernah DIBACA balik ke evaluasi (fullPipeline tidak
// pernah mengoper entryCount ke buildAndEvaluateDcaSmartMoney) dan tidak
// pernah DINAIKKAN di mana pun. Akibatnya:
//   - dcaSm.entryCount selalu 0
//   - header alert selamanya berbunyi "(1/6)" berapa pun ronde yang jalan
//   - guard `entryCount >= maxEntries` (freeze plan) dead code
//   - avgEntryPrice / totalInvested / lastEntryAt selalu NULL
// Header file adapter mengklaim "STATEFUL via dca_active_plans" -- tidak
// benar sampai perbaikan ini.
//
// CARA MENAIKKAN: satu-satunya bukti yang worker punya adalah HARGA. Kalau
// plan sebelumnya menyimpan nextTriggerPrice dan harga sekarang sudah
// melewatinya ke arah akumulasi (LONG: turun menembus; SHORT: naik
// menembus), ronde itu dianggap terisi.
//
// KETERBATASAN JUJUR -- WAJIB DIBACA SEBELUM PERCAYA ANGKA INI:
// worker TIDAK PUNYA akses ke akun/fill user (relay read-only, tidak ada
// endpoint order). entryCount adalah state plan yang DIINFERENSI dari
// pergerakan harga, BUKAN konfirmasi eksekusi. Kalau user tidak memasang
// order ronde itu, hitungan di sini tetap maju. Dipakai untuk pacing alert
// (jangan spam ronde yang sama) dan guard maxEntries -- BUKAN untuk
// akuntansi posisi.
//
// avgEntryPrice = rata-rata aritmetik harga trigger, valid karena engine
// memakai sizing FLAT (dcaOrderSizeMultiplier = 1.0). totalInvested cuma
// diisi kalau dcaBotConfig ada (WATCH tidak punya sizing).
// ─────────────────────────────────────────────────────────────
export function hasCrossedTrigger(side: "LONG" | "SHORT", currentPrice: number, prevTrigger: number | null): boolean {
  if (prevTrigger == null || !Number.isFinite(prevTrigger) || prevTrigger <= 0) return false;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  return side === "LONG" ? currentPrice <= prevTrigger : currentPrice >= prevTrigger;
}

async function persistDcaActivePlan(symbol: string, r: TriplePipelineResult, now: number): Promise<void> {
  const { dca, dcaSm } = r;
  if (!dcaSm || !dca.direction) return;
  try {
    if (dcaSm.decision === "DCA_STOP") {
      await d1Client.deleteDcaActivePlan(symbol, dca.direction);
      return;
    }
    const existing = await d1Client.getDcaActivePlan(symbol, dca.direction);

    let entryCount = existing?.entryCount ?? 0;
    let avgEntryPrice = existing?.avgEntryPrice ?? null;
    let totalInvested = existing?.totalInvested ?? null;
    let lastEntryAt = existing?.lastEntryAt ?? null;

    const crossed = hasCrossedTrigger(dca.direction, dcaSm.currentPrice, existing?.nextTriggerPrice ?? null);
    if (crossed && entryCount < dcaSm.maxEntries) {
      const fillPrice = dcaSm.currentPrice;
      // Sizing flat -> rata-rata aritmetik benar.
      avgEntryPrice = avgEntryPrice == null ? fillPrice : (avgEntryPrice * entryCount + fillPrice) / (entryCount + 1);
      const orderUsd = dca.dcaBotConfig?.dcaOrderMarginUsd;
      if (orderUsd != null && Number.isFinite(orderUsd)) {
        totalInvested = (totalInvested ?? 0) + orderUsd;
      }
      entryCount += 1;
      lastEntryAt = now;
      console.log(
        `[entry-alert] ${symbol} ${dca.direction}: trigger ${existing?.nextTriggerPrice} terlampaui @ ${fillPrice} -> ronde ${entryCount}/${dcaSm.maxEntries} (state inferensi harga, bukan konfirmasi fill)`,
      );
    }

    await d1Client.upsertDcaActivePlan({
      symbol,
      side: dca.direction,
      entryCount,
      maxEntries: dcaSm.maxEntries,
      nextTriggerPrice: dcaSm.nextTriggerPrice,
      intervalPct: dcaSm.intervalPct,
      pauseStatus: dcaSm.pauseLevel === "NONE" ? "NONE" : dcaSm.pauseLevel,
      pauseReason: dcaSm.pauseReason,
      avgEntryPrice,
      totalInvested,
      lastEntryAt,
    });
  } catch (err) {
    console.error(`[entry-alert] D1 dca_active_plans ${symbol}:`, (err as Error)?.message ?? String(err));
  }
}

interface WatchlistBundle {
  watchlist: string[];
  prefetched: PrefetchedTickerFunding | undefined;
  tickerBySymbol: Map<string, binanceProxy.Ticker24hr>;
}

async function maybeNotifyDailyCircuit(env: NotifyEnv, now: number): Promise<void> {
  const [state, limit] = await Promise.all([riskCircuit.getDailyLossCircuit(), riskCircuit.resolveDailyAlertLimit()]);
  if (!riskCircuit.shouldNotifyDailyLoss(state, now, limit)) return;
  // I6: pesan lama menyebut "daily loss limit", yang membuatnya terbaca
  // seolah ada kerugian nyata. Yang dihitung adalah JUMLAH ALERT terkirim.
  await dispatchNotification(
    env,
    `🚦 *Alert budget harian tercapai* — ${state?.count ?? 0}/${limit} head\\-alert TRADE terkirim dalam 24 jam terakhir. ` +
      `Ini penghitung ALERT, BUKAN kerugian nyata: worker tidak punya akses posisi/PnL kamu. ` +
      `TRADE alert di\\-mute sampai window roll\\-off, atau reset lewat \`whalescope_risk_circuit\` reset\\_daily. ` +
      `WATCH tetap jalan. Ubah ambang tanpa redeploy: KV \`${riskCircuit.DAILY_ALERT_COUNT_LIMIT_KV_KEY}\`.`,
  );
  await riskCircuit.markDailyLossNotified(now);
}

async function maybeNotifyMacroPause(env: NotifyEnv, now: number): Promise<void> {
  const state = await riskCircuit.getMacroRiskCircuit();
  if (!riskCircuit.shouldNotifyMacro(state, now)) return;
  const reason = state?.reason ? ` Alasan: ${state.reason}.` : "";
  await dispatchNotification(
    env,
    `⏸️ *Macro Risk Switch*: entry-alert Phase 2 di-pause.${reason} Nyalakan lagi lewat \`whalescope_risk_circuit\` action=set_macro active=false.`,
  );
  await riskCircuit.markMacroNotified(now);
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

  const tickerBySymbol = new Map(tickerList.map((t) => [t.symbol, t]));
  let prefetched: PrefetchedTickerFunding | undefined;
  try {
    const fundingList = await binanceProxy.getBulkFundingRatesNative();
    prefetched = {
      ticker: tickerBySymbol,
      funding: new Map(fundingList.map((f) => [f.symbol, f])),
    };
  } catch (err) {
    console.error(
      "[entry-alert] gagal bulk fetch premiumIndex, fallback ke call per-symbol:",
      (err as Error)?.message ?? String(err),
    );
    prefetched = undefined;
  }
  return { watchlist, prefetched, tickerBySymbol };
}

// Phase 1 — F3 cheap grid score over the 250-volume universe, then TOP-N
// (default 40). Fail-closed: kalau premiumIndex gagal, ranking tetap jalan
// ticker-only (fundingAbs=0 → funding factor netral). JANGAN deep-run 250.
async function runPhase1Prefilter(
  watchlist: string[],
  tickerBySymbol: Map<string, binanceProxy.Ticker24hr>,
  fundingBySymbol: Map<string, binanceProxy.PremiumIndexPoint> | undefined,
  now: number,
): Promise<string[]> {
  const topN = await resolveEntryTopN();
  if (topN >= watchlist.length) return watchlist;

  if (!fundingBySymbol) {
    console.error(
      "[entry-alert] premiumIndex tidak tersedia -- Phase 1 tetap cut top-N pakai ticker-only F3 (fundingAbs=0)",
    );
  }

  const candidates: EntryRankingInput[] = watchlist.map((symbol) => {
    const funding = fundingBySymbol?.get(symbol);
    const ticker = tickerBySymbol.get(symbol);
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

  // G6: kuota dibagi grid (F3) vs extremity (DCA/Trad). Total tetap topN.
  const extremityFrac = await resolveExtremityFraction();
  const { selected, gridPicks, extremityPicks } = selectEntryCandidates(candidates, topN, extremityFrac);
  const selectedSet = new Set(selected);
  const skipped = watchlist.filter((s) => !selectedSet.has(s));

  await d1Client
    .insertEntryAlertSkipLog({ runAt: now, skippedSymbols: skipped, topN })
    .catch((err) => console.error("[entry-prefilter] gagal insert entry_alert_skip_log:", (err as Error)?.message ?? String(err)));
  console.log(
    `[entry-prefilter] phase1 top_n=${topN} analysed=${selected.length} grid=${gridPicks.length} extremity=${extremityPicks.length} (frac=${extremityFrac}) skipped=${skipped.length} extremity_symbols=${extremityPicks.join(",")}`,
  );

  return selected;
}

export async function runEntryAlertCheck(env: NotifyEnv): Promise<void> {
  const now = Date.now();
  if (await riskCircuit.isMacroRiskActive()) {
    await maybeNotifyMacroPause(env, now);
    await d1Client.insertEntryAlertRunLog({
      runAt: now,
      total: 0,
      errors: 0,
      watchCount: 0,
      tradeCount: 0,
      dcaWatchCount: 0,
      dcaTradeCount: 0,
      tradWatchCount: 0,
      tradTradeCount: 0,
    });
    console.log("[entry-alert] macro risk circuit active -- skip Phase 2");
    return;
  }

  const { watchlist, prefetched, tickerBySymbol } = await resolveWatchlistAndPrefetch();
  const analysed = await runPhase1Prefilter(watchlist, tickerBySymbol, prefetched?.funding, now);
  const dcaOpts: DcaOpts = { modalAvailableUsd: await resolveDcaModalUsd() };
  // Phase 2 — triple pipeline (Grid + DCA + Trad) HANYA pada top-N Phase 1.
  const outcomes = await mapWithConcurrency(analysed, CONCURRENCY, async (symbol): Promise<AlertCheckOutcome> => {
    try {
      return await checkEntryAlertForSymbol(symbol, env, now, prefetched, dcaOpts);
    } catch (err) {
      console.error(`[cron] gagal entry-alert check ${symbol}:`, (err as Error)?.message ?? String(err));
      return { gridDecision: "NO_TRADE", dcaDecision: "DCA_NO_TRADE", tradDecision: "TRAD_NO_TRADE", hadError: true };
    } finally {
      await pacing.sleep(ENTRY_ALERT_PACING_DELAY_MS);
    }
  });

  // Rekam tally tick ini -- heartbeatCron.ts (3x/hari) pakai ini buat
  // bedain "market emang sepi" (error rate rendah) vs "backend bermasalah"
  // (error rate tinggi). watch_count/trade_count = GRID (nama kolom lama);
  // dca_* = head DCA; trad_* = head Traditional/Smart-Money futures
  // (kolom trad_* ditambah migration 0009). Semua observability.
  const tradTradeCount = outcomes.filter((o) => o.tradDecision === "TRAD_TRADE").length;
  const tradWatchCount = outcomes.filter((o) => o.tradDecision === "TRAD_WATCH").length;
  console.log(`[entry-alert] trad tally: TRAD_TRADE=${tradTradeCount} TRAD_WATCH=${tradWatchCount}`);
  await d1Client.insertEntryAlertRunLog({
    runAt: now,
    total: outcomes.length,
    errors: outcomes.filter((o) => o.hadError).length,
    watchCount: outcomes.filter((o) => o.gridDecision === "WATCH").length,
    tradeCount: outcomes.filter((o) => o.gridDecision === "TRADE").length,
    dcaWatchCount: outcomes.filter((o) => o.dcaDecision === "DCA_WATCH").length,
    dcaTradeCount: outcomes.filter((o) => o.dcaDecision === "DCA_TRADE").length,
    tradWatchCount,
    tradTradeCount,
  });

  const decisionLogs = outcomes.flatMap((o) => (o.decisionLog ? [o.decisionLog] : []));
  await d1Client
    .insertPipelineDecisionLogs(decisionLogs)
    .catch((err) => console.error("[entry-alert] gagal insert pipeline_decision_log:", (err as Error)?.message ?? String(err)));
}

// Wrapper tipis di atas D1 (binding DB, lihat wrangler.toml + migrations/0001_init.sql)
// buat time-series: basis/funding/OI snapshot (market_snapshots) dan skor
// sinyal MM (signal_history), keduanya diisi Cron tiap 5 menit (src/index.ts
// scheduled handler) untuk SNAPSHOT_WATCHLIST (shared.ts). Pola module-level
// setter sama seperti kvConfig.ts/binanceProxyClient.ts -- di-set sekali di
// awal fetch()/scheduled() sebelum tool logic jalan.
import type { PipelineDecisionLogRow } from "./pipelineDecisionLog.js";
export type { PipelineDecisionLogRow };

let db: D1Database | undefined;

export function setD1Database(database: D1Database | undefined): void {
  db = database;
}

export class D1NotConfiguredError extends Error {
  constructor() {
    super("D1 database (binding DB) belum ke-bind di worker. Cek [[d1_databases]] di wrangler.toml sudah benar dan worker sudah di-deploy ulang.");
    this.name = "D1NotConfiguredError";
  }
}

function requireDb(): D1Database {
  if (!db) throw new D1NotConfiguredError();
  return db;
}

export interface MarketSnapshotRow {
  symbol: string;
  timestamp: number;
  spotPrice: number | null;
  markPrice: number | null;
  basis: number | null;
  fundingRate: number | null;
  openInterest: number | null;
}

interface RawMarketSnapshotRow {
  symbol: string;
  timestamp: number;
  spot_price: number | null;
  mark_price: number | null;
  basis: number | null;
  funding_rate: number | null;
  open_interest: number | null;
}

export async function insertMarketSnapshot(row: MarketSnapshotRow): Promise<void> {
  await requireDb()
    .prepare(
      "INSERT INTO market_snapshots (symbol, timestamp, spot_price, mark_price, basis, funding_rate, open_interest) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(row.symbol, row.timestamp, row.spotPrice, row.markPrice, row.basis, row.fundingRate, row.openInterest)
    .run();
}

export async function queryMarketSnapshots(symbol: string, hours: number): Promise<MarketSnapshotRow[]> {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const result = await requireDb()
    .prepare("SELECT * FROM market_snapshots WHERE symbol = ? AND timestamp >= ? ORDER BY timestamp ASC")
    .bind(symbol.toUpperCase(), cutoff)
    .all<RawMarketSnapshotRow>();

  return result.results.map((r) => ({
    symbol: r.symbol,
    timestamp: r.timestamp,
    spotPrice: r.spot_price,
    markPrice: r.mark_price,
    basis: r.basis,
    fundingRate: r.funding_rate,
    openInterest: r.open_interest,
  }));
}

export interface SignalHistoryRow {
  symbol: string;
  timestamp: number;
  signalType: string;
  score: number;
  evidence: string;
}

interface RawSignalHistoryRow {
  symbol: string;
  timestamp: number;
  signal_type: string;
  score: number;
  evidence: string;
}

// Batch insert lewat D1Database.batch() -- 6 sinyal per symbol per tick cron,
// dieksekusi sebagai satu batch daripada 6 round-trip terpisah.
export async function insertSignalSnapshots(rows: SignalHistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const database = requireDb();
  const stmt = database.prepare(
    "INSERT INTO signal_history (symbol, timestamp, signal_type, score, evidence) VALUES (?, ?, ?, ?, ?)",
  );
  await database.batch(rows.map((r) => stmt.bind(r.symbol, r.timestamp, r.signalType, r.score, r.evidence)));
}

export async function querySignalHistory(
  symbol: string,
  signalType: string | "all",
  startTime: number,
  endTime: number,
): Promise<SignalHistoryRow[]> {
  const database = requireDb();
  const query =
    signalType === "all"
      ? database
          .prepare("SELECT * FROM signal_history WHERE symbol = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC")
          .bind(symbol.toUpperCase(), startTime, endTime)
      : database
          .prepare(
            "SELECT * FROM signal_history WHERE symbol = ? AND signal_type = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC",
          )
          .bind(symbol.toUpperCase(), signalType, startTime, endTime);

  const result = await query.all<RawSignalHistoryRow>();
  return result.results.map((r) => ({
    symbol: r.symbol,
    timestamp: r.timestamp,
    signalType: r.signal_type,
    score: r.score,
    evidence: r.evidence,
  }));
}

// Infra-health read paths -- dipakai src/cron/infraHealthCron.ts.
//
// getLatestMarketSnapshotTimestamp(): gap-detection buat cron snapshot 5-menit
// (checkMarketSnapshotFreshness). BEDA dari getLatestEntryAlertRunLogTimestamp()
// -- itu jalur entry-alert, ini jalur snapshot basis+sinyal MM. Kalau cron */5
// diam-diam berhenti (semua symbol gagal, atau tick di-Cancel platform), tabel
// ini berhenti nambah baris tapi checkHeartbeat() (yang cuma pantau entry-alert)
// gak akan tahu.
//
// count*Rows(): market_snapshots + signal_history di-prune 90 hari (lihat
// pruneOldMarketSnapshots / pruneOldSignalHistory). checkD1Capacity() tetap
// backstop kalau gabungan dua tabel lewat ambang (prune gagal / backlog).
export async function getLatestMarketSnapshotTimestamp(): Promise<number | null> {
  const row = await requireDb()
    .prepare("SELECT MAX(timestamp) as latest FROM market_snapshots")
    .first<{ latest: number | null }>();
  return row?.latest ?? null;
}

export async function countMarketSnapshotRows(): Promise<number> {
  const row = await requireDb().prepare("SELECT COUNT(*) as count FROM market_snapshots").first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countSignalHistoryRows(): Promise<number> {
  const row = await requireDb().prepare("SELECT COUNT(*) as count FROM signal_history").first<{ count: number }>();
  return row?.count ?? 0;
}

// request_log -- dasar buat endpoint owner-only GET /admin/usage
// (src/index.ts). BUKAN dibaca oleh MCP tool manapun (privasi: jangan
// bocorin IP visitor lain ke sembarang caller MCP).
export interface RequestLogRow {
  timestamp: number;
  ip: string | null;
  country: string | null;
  colo: string | null;
  userAgent: string | null;
}

interface RawRequestLogRow {
  timestamp: number;
  ip: string | null;
  country: string | null;
  colo: string | null;
  user_agent: string | null;
}

export async function insertRequestLog(row: RequestLogRow): Promise<void> {
  await requireDb()
    .prepare("INSERT INTO request_log (timestamp, ip, country, colo, user_agent) VALUES (?, ?, ?, ?, ?)")
    .bind(row.timestamp, row.ip, row.country, row.colo, row.userAgent)
    .run();
}

export interface RequestLogSummary {
  windowHours: number;
  totalRequests: number;
  distinctIps: number;
  topIps: { ip: string | null; country: string | null; count: number }[];
  recent: RequestLogRow[];
}

export async function queryRequestLogSummary(hours: number): Promise<RequestLogSummary> {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const database = requireDb();

  const [totals, topIps, recent] = await Promise.all([
    database
      .prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS distinctIps FROM request_log WHERE timestamp >= ?")
      .bind(cutoff)
      .first<{ total: number; distinctIps: number }>(),
    database
      .prepare(
        "SELECT ip, country, COUNT(*) AS count FROM request_log WHERE timestamp >= ? GROUP BY ip ORDER BY count DESC LIMIT 20",
      )
      .bind(cutoff)
      .all<{ ip: string | null; country: string | null; count: number }>(),
    database
      .prepare("SELECT * FROM request_log WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 20")
      .bind(cutoff)
      .all<RawRequestLogRow>(),
  ]);

  return {
    windowHours: hours,
    totalRequests: totals?.total ?? 0,
    distinctIps: totals?.distinctIps ?? 0,
    topIps: topIps.results,
    recent: recent.results.map((r) => ({
      timestamp: r.timestamp,
      ip: r.ip,
      country: r.country,
      colo: r.colo,
      userAgent: r.user_agent,
    })),
  };
}

// Dipanggil dari scheduled() (index.ts) tiap tick -- request_log bisa
// growth gak terduga kalau ada traffic asing (beda dari market_snapshots/
// signal_history yang row-nya kekontrol ketat, watchlist 10 pair tetap).
export async function pruneOldRequestLogs(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM request_log WHERE timestamp < ?").bind(cutoffMs).run();
}

// unix-ms INTEGER, sama seperti writer Date.now() -- JANGAN pakai datetime().
export async function pruneOldMarketSnapshots(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM market_snapshots WHERE timestamp < ?").bind(cutoffMs).run();
}

export async function pruneOldSignalHistory(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM signal_history WHERE timestamp < ?").bind(cutoffMs).run();
}

// wall_tracking -- wall kandidat (qty >= 2x median level lain di sisi yang
// sama) dari order book, diisi Cron terpisah tiap 1 menit (beda dari cron
// 5 menit di atas) untuk SNAPSHOT_WATCHLIST. Dibaca queryWallPersistence()
// oleh binance_get_orderbook_wall_persistence (src/tools/wallPersistence.ts).
export interface WallCandidateRow {
  symbol: string;
  capturedAt: number;
  side: "bid" | "ask";
  price: number;
  qty: number;
  medianRatio: number;
}

interface RawWallCandidateRow {
  captured_at: number;
  qty: number;
}

// Batch insert sama pola dengan insertSignalSnapshots -- semua wall kandidat
// satu tick cron (bisa banyak baris per symbol per sisi) jadi satu batch.
export async function insertWallCandidates(rows: WallCandidateRow[]): Promise<void> {
  if (rows.length === 0) return;
  const database = requireDb();
  const stmt = database.prepare(
    "INSERT INTO wall_tracking (symbol, captured_at, side, price, qty, median_ratio) VALUES (?, ?, ?, ?, ?, ?)",
  );
  await database.batch(
    rows.map((r) => stmt.bind(r.symbol, r.capturedAt, r.side, r.price, r.qty, r.medianRatio)),
  );
}

export interface WallPersistencePoint {
  capturedAt: number;
  qty: number;
}

// Band harga +/- 0.05% di sekitar priceLevel -- toleransi kecil karena harga
// order book bergerak tick-by-tick, wall di harga "sama" jarang persis sama
// float ke float antar snapshot.
const WALL_PRICE_TOLERANCE = 0.0005;

export async function queryWallPersistence(
  symbol: string,
  side: "bid" | "ask",
  priceLevel: number,
  lookbackMinutes: number,
): Promise<WallPersistencePoint[]> {
  const lowPrice = priceLevel * (1 - WALL_PRICE_TOLERANCE);
  const highPrice = priceLevel * (1 + WALL_PRICE_TOLERANCE);
  const cutoff = Date.now() - lookbackMinutes * 60 * 1000;

  // Toleransi harga bisa mencakup banyak level order book berbeda dalam SATU
  // captured_at (tick size kecil vs band 0.05% yang lebar) -- kalau semua
  // level itu diambil, hasilnya bukan histori SATU wall lagi, tapi level
  // acak tercampur antar waktu. ROW_NUMBER() per captured_at, urut jarak ke
  // priceLevel, ambil rn=1 -- jadi tepat SATU baris (level terdekat) per tick.
  const result = await requireDb()
    .prepare(
      `SELECT captured_at, qty FROM (
         SELECT captured_at, qty,
           ROW_NUMBER() OVER (PARTITION BY captured_at ORDER BY ABS(price - ?) ASC) AS rn
         FROM wall_tracking
         WHERE symbol = ? AND side = ? AND price BETWEEN ? AND ? AND captured_at >= ?
       )
       WHERE rn = 1
       ORDER BY captured_at ASC`,
    )
    .bind(priceLevel, symbol.toUpperCase(), side, lowPrice, highPrice, cutoff)
    .all<RawWallCandidateRow>();

  return result.results.map((r) => ({ capturedAt: r.captured_at, qty: r.qty }));
}

// Dipanggil dari scheduled() (index.ts) di tick 5-menit yang sudah ada --
// retensi 48 jam lebih dari cukup buat interval prune 5 menit, gak perlu
// Cron Trigger ke-3 cuma buat pembersihan (slot free-tier terbatas 5).
export async function pruneOldWallTracking(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM wall_tracking WHERE captured_at < ?").bind(cutoffMs).run();
}

// hyperliquid_whale_snapshots -- posisi on-chain per wallet address di
// HYPERLIQUID_WHALE_WATCHLIST (shared.ts), diisi Cron terpisah tiap 15
// menit (hyperliquidWhaleCron.ts). Dibaca hyperliquid_get_whale_wallet_positions
// (src/tools/hyperliquidWhale.ts) buat hitung delta akumulasi/distribusi.
export interface HyperliquidWhaleSnapshotRow {
  walletAddress: string;
  coin: string;
  capturedAt: number;
  side: "long" | "short";
  size: number;
  entryPrice: number | null;
  leverage: number | null;
}

interface RawHyperliquidWhaleSnapshotRow {
  wallet_address: string;
  coin: string;
  captured_at: number;
  side: "long" | "short";
  size: number;
  entry_price: number | null;
  leverage: number | null;
}

export async function insertHyperliquidWhaleSnapshots(rows: HyperliquidWhaleSnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  const database = requireDb();
  const stmt = database.prepare(
    "INSERT INTO hyperliquid_whale_snapshots (wallet_address, coin, captured_at, side, size, entry_price, leverage) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await database.batch(
    rows.map((r) => stmt.bind(r.walletAddress, r.coin, r.capturedAt, r.side, r.size, r.entryPrice, r.leverage)),
  );
}

// Dua snapshot TERBARU per wallet_address untuk satu coin -- cukup buat
// hitung delta (naik/turun/baru/tutup posisi) tanpa narik seluruh histori.
// Pola window function sama seperti queryWallPersistence() (ROW_NUMBER
// PARTITION BY per wallet, bukan per captured_at seperti wall_tracking).
// Delta/agregasi dihitung di tool layer (hyperliquidWhale.ts), bukan di
// sini -- d1Client tetap cuma akses data, sama seperti pola findWallCandidates
// yang dipisah dari insertWallCandidates.
export async function queryHyperliquidWhaleRecentByCoin(coin: string): Promise<HyperliquidWhaleSnapshotRow[]> {
  const result = await requireDb()
    .prepare(
      `SELECT wallet_address, coin, captured_at, side, size, entry_price, leverage FROM (
         SELECT wallet_address, coin, captured_at, side, size, entry_price, leverage,
           ROW_NUMBER() OVER (PARTITION BY wallet_address ORDER BY captured_at DESC) AS rn
         FROM hyperliquid_whale_snapshots
         WHERE coin = ?
       )
       WHERE rn <= 2
       ORDER BY wallet_address ASC, captured_at DESC`,
    )
    .bind(coin.toUpperCase())
    .all<RawHyperliquidWhaleSnapshotRow>();

  return result.results.map((r) => ({
    walletAddress: r.wallet_address,
    coin: r.coin,
    capturedAt: r.captured_at,
    side: r.side,
    size: r.size,
    entryPrice: r.entry_price,
    leverage: r.leverage,
  }));
}

// Retensi 14 hari -- posisi whale relevan lebih lama dari orderbook wall
// (48 jam), delta dihitung dari 2 snapshot terbaru jadi histori lama gak
// pernah dibaca lagi tapi disimpan buat analisa tren manual kalau perlu.
export async function pruneOldHyperliquidWhaleSnapshots(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM hyperliquid_whale_snapshots WHERE captured_at < ?").bind(cutoffMs).run();
}

// Satu row per (coin, report_date) -- histori lokal laporan CFTC COT
// (src/cftcClient.ts getCftcPositioning cuma ambil row TERBARU, table ini
// nyimpennya biar computeCftcTrend() bisa hitung rate-of-change multi-minggu
// tanpa query range CFTC berulang). Migration: migrations/0012_cftc_positioning_history.sql.
export interface CftcPositioningHistoryRow {
  coin: string;
  reportDate: string;
  openInterest: number;
  levLong: number;
  levShort: number;
  levNetPct: number;
  amLong: number;
  amShort: number;
  amNetPct: number;
  capturedAt: number;
}

interface RawCftcPositioningHistoryRow {
  coin: string;
  report_date: string;
  open_interest: number;
  lev_long: number;
  lev_short: number;
  lev_net_pct: number;
  am_long: number;
  am_short: number;
  am_net_pct: number;
  captured_at: number;
}

// INSERT OR IGNORE + unique index (coin, report_date) -- idempotent by
// design, cron boleh dipanggil berkali-kali sebelum report_date CFTC
// berikutnya rilis tanpa membuat row duplikat atau perlu SELECT dulu.
export async function insertCftcPositioningSnapshot(row: CftcPositioningHistoryRow): Promise<void> {
  await requireDb()
    .prepare(
      "INSERT OR IGNORE INTO cftc_positioning_history (coin, report_date, open_interest, lev_long, lev_short, lev_net_pct, am_long, am_short, am_net_pct, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.coin,
      row.reportDate,
      row.openInterest,
      row.levLong,
      row.levShort,
      row.levNetPct,
      row.amLong,
      row.amShort,
      row.amNetPct,
      row.capturedAt,
    )
    .run();
}

// N laporan terbaru untuk satu coin, ASCENDING (oldest -> newest) --
// computeCftcTrend() (cftcClient.ts) butuh urutan ini buat baca titik
// pertama/terakhir window langsung tanpa reverse di caller.
export async function queryCftcPositioningHistory(coin: string, limit: number): Promise<CftcPositioningHistoryRow[]> {
  const result = await requireDb()
    .prepare(
      `SELECT coin, report_date, open_interest, lev_long, lev_short, lev_net_pct, am_long, am_short, am_net_pct, captured_at
       FROM (
         SELECT * FROM cftc_positioning_history WHERE coin = ? ORDER BY report_date DESC LIMIT ?
       )
       ORDER BY report_date ASC`,
    )
    .bind(coin.toUpperCase(), limit)
    .all<RawCftcPositioningHistoryRow>();

  return result.results.map((r) => ({
    coin: r.coin,
    reportDate: r.report_date,
    openInterest: r.open_interest,
    levLong: r.lev_long,
    levShort: r.lev_short,
    levNetPct: r.lev_net_pct,
    amLong: r.am_long,
    amShort: r.am_short,
    amNetPct: r.am_net_pct,
    capturedAt: r.captured_at,
  }));
}

// Satu row per symbol (entryAlertCron.ts) -- lacak decision TRADE/WATCH/
// NO_TRADE terakhir + kapan terakhir kirim alert, buat deteksi transisi dan
// cooldown re-alert (lihat komentar entryAlertCron.ts).
export interface EntryAlertStateRow {
  symbol: string;
  lastDecision: string;
  lastAlertAt: number | null;
}

interface RawEntryAlertStateRow {
  symbol: string;
  last_decision: string;
  last_alert_at: number | null;
}

export async function getEntryAlertState(symbol: string): Promise<EntryAlertStateRow | null> {
  const row = await requireDb()
    .prepare("SELECT symbol, last_decision, last_alert_at FROM entry_alert_state WHERE symbol = ?")
    .bind(symbol.toUpperCase())
    .first<RawEntryAlertStateRow>();
  if (!row) return null;
  return { symbol: row.symbol, lastDecision: row.last_decision, lastAlertAt: row.last_alert_at };
}

export async function upsertEntryAlertState(row: EntryAlertStateRow): Promise<void> {
  await requireDb()
    .prepare(
      "INSERT INTO entry_alert_state (symbol, last_decision, last_alert_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(symbol) DO UPDATE SET last_decision = excluded.last_decision, last_alert_at = excluded.last_alert_at",
    )
    .bind(row.symbol.toUpperCase(), row.lastDecision, row.lastAlertAt)
    .run();
}

// Satu row per tick entryAlertCron.ts (runEntryAlertCheck) -- dipakai
// heartbeatCron.ts buat bedain "market emang sepi" vs "backend bermasalah"
// pas gak ada alert TRADE/WATCH sama sekali dalam window lookback-nya.
export interface EntryAlertRunLogRow {
  runAt: number;
  total: number;
  errors: number;
  /** watch_count / trade_count = GRID tallies (legacy column names kept). */
  watchCount: number;
  tradeCount: number;
  /** DCA head tallies (migration 0008, observability only). Default 0. */
  dcaWatchCount?: number;
  dcaTradeCount?: number;
  /** Traditional / Smart-Money futures head tallies (migration 0009). Default 0. */
  tradWatchCount?: number;
  tradTradeCount?: number;
}

export async function insertEntryAlertRunLog(row: EntryAlertRunLogRow): Promise<void> {
  await requireDb()
    .prepare(
      "INSERT INTO entry_alert_run_log (run_at, total, errors, watch_count, trade_count, dca_watch_count, dca_trade_count, trad_watch_count, trad_trade_count) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.runAt,
      row.total,
      row.errors,
      row.watchCount,
      row.tradeCount,
      row.dcaWatchCount ?? 0,
      row.dcaTradeCount ?? 0,
      row.tradWatchCount ?? 0,
      row.tradTradeCount ?? 0,
    )
    .run();
}

export interface EntryAlertRunLogSummary {
  total: number;
  errors: number;
}

export async function getEntryAlertRunLogSummarySince(cutoffMs: number): Promise<EntryAlertRunLogSummary> {
  const row = await requireDb()
    .prepare("SELECT COALESCE(SUM(total), 0) as total, COALESCE(SUM(errors), 0) as errors FROM entry_alert_run_log WHERE run_at >= ?")
    .bind(cutoffMs)
    .first<EntryAlertRunLogSummary>();
  return row ?? { total: 0, errors: 0 };
}

// Dipakai checkEntryAlertCronFreshness() (heartbeatCron.ts) -- BEDA dari
// getEntryAlertRunLogSummarySince() di atas, yang cuma menjumlah total/errors
// dari tick yang SUDAH SELESAI. Kalau sebuah tick di-CANCEL platform Cloudflare
// (misal kena CPU-time cap) SEBELUM sempat insertEntryAlertRunLog(), tick itu
// TIDAK PERNAH nongol di summary manapun -- gak nambah total, gak nambah
// errors, cuma "hilang" begitu saja. Satu-satunya cara mendeteksi itu adalah
// cek APAKAH ADA baris baru sama sekali dalam window terakhir (gap detection),
// bukan menghitung isi baris yang ada. Insiden nyata 2026-08-27 (lihat
// project_whalescope-mcp_status memory): beberapa tick entry-alert berturut-
// turut ke-Cancel platform-level, entry_alert_run_log diam tanpa baris baru
// selama >1 jam, TIDAK terdeteksi oleh checkHeartbeat() manapun (baik cek
// "alertCount>0" atau cek error-rate) karena keduanya cuma pernah lihat data
// dari tick yang berhasil selesai.
export async function getLatestEntryAlertRunLogTimestamp(): Promise<number | null> {
  const row = await requireDb().prepare("SELECT MAX(run_at) as latest FROM entry_alert_run_log").first<{ latest: number | null }>();
  return row?.latest ?? null;
}

export async function pruneOldEntryAlertRunLog(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM entry_alert_run_log WHERE run_at < ?").bind(cutoffMs).run();
}

// ── sm_watch_states (migration 0009) ─────────────────────────────────────
// State watch per-symbol Smart Money Core Engine V2 (smartMoneyPipelineEngine.ts):
// simpan skenario + skor + harga/ATR pemicu saat masuk WATCH, dengan countdown
// ticks_remaining (default 4 tick) sampai kadaluarsa, atau invalidated_at diisi
// kalau setup gugur lebih awal (mis. harga menembus trigger_atr). Satu row per
// symbol (PRIMARY KEY) -- upsert menimpa state lama.
export interface SmWatchStateRow {
  symbol: string;
  scenario: string;
  score: number;
  triggerPrice: number;
  triggerAtr: number;
  createdAt: number;
  ticksRemaining?: number; // default 4
  invalidatedAt?: number | null;
}

export async function upsertSmWatchState(row: SmWatchStateRow): Promise<void> {
  await requireDb()
    .prepare(
      "INSERT INTO sm_watch_states (symbol, scenario, score, trigger_price, trigger_atr, created_at, ticks_remaining, invalidated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(symbol) DO UPDATE SET scenario=excluded.scenario, score=excluded.score, trigger_price=excluded.trigger_price, " +
        "trigger_atr=excluded.trigger_atr, created_at=excluded.created_at, ticks_remaining=excluded.ticks_remaining, invalidated_at=excluded.invalidated_at",
    )
    .bind(
      row.symbol,
      row.scenario,
      row.score,
      row.triggerPrice,
      row.triggerAtr,
      row.createdAt,
      row.ticksRemaining ?? 4,
      row.invalidatedAt ?? null,
    )
    .run();
}

export async function getSmWatchState(symbol: string): Promise<SmWatchStateRow | null> {
  const row = await requireDb()
    .prepare(
      "SELECT symbol, scenario, score, trigger_price, trigger_atr, created_at, ticks_remaining, invalidated_at FROM sm_watch_states WHERE symbol = ?",
    )
    .bind(symbol)
    .first<{
      symbol: string;
      scenario: string;
      score: number;
      trigger_price: number;
      trigger_atr: number;
      created_at: number;
      ticks_remaining: number;
      invalidated_at: number | null;
    }>();
  if (!row) return null;
  return {
    symbol: row.symbol,
    scenario: row.scenario,
    score: row.score,
    triggerPrice: row.trigger_price,
    triggerAtr: row.trigger_atr,
    createdAt: row.created_at,
    ticksRemaining: row.ticks_remaining,
    invalidatedAt: row.invalidated_at,
  };
}

/** Semua state yang masih hidup (belum invalidated, ticks_remaining > 0). */
export async function getActiveSmWatchStates(): Promise<SmWatchStateRow[]> {
  const res = await requireDb()
    .prepare(
      "SELECT symbol, scenario, score, trigger_price, trigger_atr, created_at, ticks_remaining, invalidated_at FROM sm_watch_states " +
        "WHERE invalidated_at IS NULL AND ticks_remaining > 0",
    )
    .all<{
      symbol: string;
      scenario: string;
      score: number;
      trigger_price: number;
      trigger_atr: number;
      created_at: number;
      ticks_remaining: number;
      invalidated_at: number | null;
    }>();
  return (res.results ?? []).map((row) => ({
    symbol: row.symbol,
    scenario: row.scenario,
    score: row.score,
    triggerPrice: row.trigger_price,
    triggerAtr: row.trigger_atr,
    createdAt: row.created_at,
    ticksRemaining: row.ticks_remaining,
    invalidatedAt: row.invalidated_at,
  }));
}

/** Kurangi ticks_remaining satu untuk semua state hidup; auto-expire saat mencapai 0. */
export async function decrementActiveSmWatchTicks(): Promise<void> {
  await requireDb()
    .prepare("UPDATE sm_watch_states SET ticks_remaining = ticks_remaining - 1 WHERE invalidated_at IS NULL AND ticks_remaining > 0")
    .run();
}

/** Tandai satu state gugur (invalidated_at diisi) -- dipanggil saat setup batal lebih awal. */
export async function invalidateSmWatchState(symbol: string, invalidatedAt: number): Promise<void> {
  await requireDb().prepare("UPDATE sm_watch_states SET invalidated_at = ? WHERE symbol = ?").bind(invalidatedAt, symbol).run();
}

/** Prune state lama (created_at < cutoff) -- housekeeping, dipanggil dari scheduled prune. */
export async function pruneOldSmWatchStates(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM sm_watch_states WHERE created_at < ?").bind(cutoffMs).run();
}

// Satu row per tick: daftar SYMBOL yang di-skip pre-filter Wave 1
// (entryRanking.ts -- di luar TOP-N, tidak masuk hard-screen/Wave 1/2).
// Dipakai buat AUDIT lanjutan: cek apakah pair yang di-skip pernah jadi
// setup bagus di pipeline lama -- kalau iya, N terlalu kecil atau formula
// ranking salah. Retensi beberapa hari (prune di index.ts scheduled),
// lebih panjang dari run_log karena butuh window audit manual, bukan
// lookback 8 jam heartbeat.
export interface EntryAlertSkipLogRow {
  runAt: number;
  skippedSymbols: string[];
  topN: number;
}

export async function insertEntryAlertSkipLog(row: EntryAlertSkipLogRow): Promise<void> {
  await requireDb()
    .prepare("INSERT INTO entry_alert_skip_log (run_at, skipped_symbols, skipped_count, top_n) VALUES (?, ?, ?, ?)")
    .bind(row.runAt, JSON.stringify(row.skippedSymbols), row.skippedSymbols.length, row.topN)
    .run();
}

export async function pruneOldEntryAlertSkipLog(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM entry_alert_skip_log WHERE run_at < ?").bind(cutoffMs).run();
}

// ── pipeline_decision_log (migration 0011) ───────────────────────────────
// Compact per-symbol keputusan full_pipeline. Write path: entry-alert Phase 2
// (selalu) + whalescope_full_pipeline kalau persist=true. Forward return
// TIDAK disimpan -- query + klines on-demand di
// whalescope_backtest_pipeline_decisions.

interface RawPipelineDecisionLogRow {
  run_at: number;
  symbol: string;
  source: string;
  source_ref: string | null;
  decision: string;
  ranking_score: number;
  hard_screen_passed: number;
  hard_screen_reasons: string | null;
  quote_volume_usd: number | null;
  funding_rate: number | null;
  regime_1h: string | null;
  regime_4h: string | null;
  grid_risk_status: string | null;
  lower_price: number | null;
  upper_price: number | null;
  stop_loss: number | null;
  mm_component: number | null;
  smart_money_component: number | null;
  regime_component: number | null;
  buy_pressure_component: number | null;
}

function mapPipelineDecisionLogRow(r: RawPipelineDecisionLogRow): PipelineDecisionLogRow {
  let reasons: string[] = [];
  if (r.hard_screen_reasons) {
    try {
      const parsed = JSON.parse(r.hard_screen_reasons) as unknown;
      reasons = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      reasons = [];
    }
  }
  return {
    runAt: r.run_at,
    symbol: r.symbol,
    source: r.source as PipelineDecisionLogRow["source"],
    sourceRef: r.source_ref,
    decision: r.decision,
    rankingScore: r.ranking_score,
    hardScreenPassed: r.hard_screen_passed === 1,
    hardScreenReasons: reasons,
    quoteVolumeUsd: r.quote_volume_usd,
    fundingRate: r.funding_rate,
    regime1h: r.regime_1h,
    regime4h: r.regime_4h,
    gridRiskStatus: r.grid_risk_status,
    lowerPrice: r.lower_price,
    upperPrice: r.upper_price,
    stopLoss: r.stop_loss,
    mmComponent: r.mm_component,
    smartMoneyComponent: r.smart_money_component,
    regimeComponent: r.regime_component,
    buyPressureComponent: r.buy_pressure_component,
  };
}

export async function insertPipelineDecisionLogs(rows: PipelineDecisionLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const database = requireDb();
  const stmt = database.prepare(
    "INSERT INTO pipeline_decision_log (run_at, symbol, source, source_ref, decision, ranking_score, hard_screen_passed, hard_screen_reasons, quote_volume_usd, funding_rate, regime_1h, regime_4h, grid_risk_status, lower_price, upper_price, stop_loss, mm_component, smart_money_component, regime_component, buy_pressure_component) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await database.batch(
    rows.map((r) =>
      stmt.bind(
        r.runAt,
        r.symbol.toUpperCase(),
        r.source,
        r.sourceRef,
        r.decision,
        r.rankingScore,
        r.hardScreenPassed ? 1 : 0,
        JSON.stringify(r.hardScreenReasons),
        r.quoteVolumeUsd,
        r.fundingRate,
        r.regime1h,
        r.regime4h,
        r.gridRiskStatus,
        r.lowerPrice,
        r.upperPrice,
        r.stopLoss,
        r.mmComponent,
        r.smartMoneyComponent,
        r.regimeComponent,
        r.buyPressureComponent,
      ),
    ),
  );
}

export async function queryPipelineDecisionLog(opts: {
  startTime: number;
  endTime: number;
  symbol?: string;
  source?: string;
  sourceRef?: string;
  limit?: number;
}): Promise<PipelineDecisionLogRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const database = requireDb();
  const clauses = ["run_at BETWEEN ? AND ?"];
  const binds: unknown[] = [opts.startTime, opts.endTime];
  if (opts.symbol) {
    clauses.push("symbol = ?");
    binds.push(opts.symbol.toUpperCase());
  }
  if (opts.source) {
    clauses.push("source = ?");
    binds.push(opts.source);
  }
  if (opts.sourceRef) {
    clauses.push("source_ref = ?");
    binds.push(opts.sourceRef);
  }
  binds.push(limit);
  const result = await database
    .prepare(
      `SELECT run_at, symbol, source, source_ref, decision, ranking_score, hard_screen_passed, hard_screen_reasons, quote_volume_usd, funding_rate, regime_1h, regime_4h, grid_risk_status, lower_price, upper_price, stop_loss, mm_component, smart_money_component, regime_component, buy_pressure_component FROM pipeline_decision_log WHERE ${clauses.join(" AND ")} ORDER BY run_at DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<RawPipelineDecisionLogRow>();
  return (result.results ?? []).map(mapPipelineDecisionLogRow);
}

export async function pruneOldPipelineDecisionLog(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM pipeline_decision_log WHERE run_at < ?").bind(cutoffMs).run();
}

// Baca src/cron/pipelineDecisionOutcomeCron.ts untuk alur lengkap. Row
// "pending" = forward_return_24h masih NULL DAN run_at sudah cukup lama
// (window 24h forward sudah lewat) DAN belum melewati batas retry (lihat
// olderThanMs di caller -- symbol delisted/gagal terus-menerus akhirnya
// berhenti di-retry, bukan makan budget cron selamanya).
export interface PendingPipelineDecisionOutcomeRow {
  id: number;
  runAt: number;
  symbol: string;
  stopLoss: number | null;
}

interface RawPendingPipelineDecisionOutcomeRow {
  id: number;
  run_at: number;
  symbol: string;
  stop_loss: number | null;
}

export async function queryPendingPipelineDecisionOutcomes(
  readyBeforeMs: number,
  notOlderThanMs: number,
  limit: number,
): Promise<PendingPipelineDecisionOutcomeRow[]> {
  const result = await requireDb()
    .prepare(
      "SELECT id, run_at, symbol, stop_loss FROM pipeline_decision_log " +
        "WHERE forward_return_24h IS NULL AND run_at < ? AND run_at > ? " +
        "ORDER BY run_at ASC LIMIT ?",
    )
    .bind(readyBeforeMs, notOlderThanMs, limit)
    .all<RawPendingPipelineDecisionOutcomeRow>();

  return result.results.map((r) => ({ id: r.id, runAt: r.run_at, symbol: r.symbol, stopLoss: r.stop_loss }));
}

export interface PipelineDecisionOutcomeUpdate {
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn24h: number | null;
  slTouched24h: boolean | null;
}

export async function updatePipelineDecisionOutcome(id: number, outcome: PipelineDecisionOutcomeUpdate): Promise<void> {
  await requireDb()
    .prepare(
      "UPDATE pipeline_decision_log SET forward_return_1h = ?, forward_return_4h = ?, forward_return_24h = ?, sl_touched_24h = ? WHERE id = ?",
    )
    .bind(
      outcome.forwardReturn1h,
      outcome.forwardReturn4h,
      outcome.forwardReturn24h,
      outcome.slTouched24h === null ? null : outcome.slTouched24h ? 1 : 0,
      id,
    )
    .run();
}

// Dipakai heartbeatCron.ts -- kalau ada minimal 1 alert TRADE/WATCH beneran
// terkirim dalam window lookback, gak perlu heartbeat (user udah dapet
// sinyal asli).
export async function countEntryAlertsSince(cutoffMs: number): Promise<number> {
  const row = await requireDb()
    .prepare("SELECT COUNT(*) as count FROM entry_alert_state WHERE last_alert_at >= ?")
    .bind(cutoffMs)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ── DCA active plans (Phase 3 Smart Money Adapter) ────────────────────────

export type DcaPauseStatus = "NONE" | "PAUSE_SOFT" | "PAUSE_HARD" | "STOP";
export type DcaPlanSide = "LONG" | "SHORT";

export interface DcaActivePlanRow {
  id: number;
  symbol: string;
  side: DcaPlanSide;
  productType: string;
  entryCount: number;
  maxEntries: number;
  avgEntryPrice: number | null;
  totalInvested: number | null;
  nextTriggerPrice: number | null;
  intervalPct: number | null;
  pauseStatus: DcaPauseStatus;
  pauseReason: string | null;
  createdAt: number | null;
  lastEntryAt: number | null;
}

interface RawDcaActivePlanRow {
  id: number;
  symbol: string;
  side: string;
  product_type: string;
  entry_count: number;
  max_entries: number;
  avg_entry_price: number | null;
  total_invested: number | null;
  next_trigger_price: number | null;
  interval_pct: number | null;
  pause_status: string;
  pause_reason: string | null;
  created_at: number | null;
  last_entry_at: number | null;
}

function mapDcaActivePlan(r: RawDcaActivePlanRow): DcaActivePlanRow {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as DcaPlanSide,
    productType: r.product_type,
    entryCount: r.entry_count,
    maxEntries: r.max_entries,
    avgEntryPrice: r.avg_entry_price,
    totalInvested: r.total_invested,
    nextTriggerPrice: r.next_trigger_price,
    intervalPct: r.interval_pct,
    pauseStatus: r.pause_status as DcaPauseStatus,
    pauseReason: r.pause_reason,
    createdAt: r.created_at,
    lastEntryAt: r.last_entry_at,
  };
}

export async function getDcaActivePlan(symbol: string, side: DcaPlanSide): Promise<DcaActivePlanRow | null> {
  const row = await requireDb()
    .prepare("SELECT * FROM dca_active_plans WHERE symbol = ? AND side = ? LIMIT 1")
    .bind(symbol.toUpperCase(), side)
    .first<RawDcaActivePlanRow>();
  return row ? mapDcaActivePlan(row) : null;
}

export interface UpsertDcaActivePlanInput {
  symbol: string;
  side: DcaPlanSide;
  productType?: string;
  entryCount?: number;
  maxEntries?: number;
  avgEntryPrice?: number | null;
  totalInvested?: number | null;
  nextTriggerPrice?: number | null;
  intervalPct?: number | null;
  pauseStatus?: DcaPauseStatus;
  pauseReason?: string | null;
  createdAt?: number;
  lastEntryAt?: number | null;
}

export async function upsertDcaActivePlan(input: UpsertDcaActivePlanInput): Promise<void> {
  const symbol = input.symbol.toUpperCase();
  const now = Date.now();
  const existing = await getDcaActivePlan(symbol, input.side);
  if (existing) {
    await requireDb()
      .prepare(
        "UPDATE dca_active_plans SET entry_count = ?, max_entries = ?, avg_entry_price = ?, total_invested = ?, " +
          "next_trigger_price = ?, interval_pct = ?, pause_status = ?, pause_reason = ?, last_entry_at = ? " +
          "WHERE symbol = ? AND side = ?",
      )
      .bind(
        input.entryCount ?? existing.entryCount,
        input.maxEntries ?? existing.maxEntries,
        input.avgEntryPrice ?? existing.avgEntryPrice,
        input.totalInvested ?? existing.totalInvested,
        input.nextTriggerPrice ?? existing.nextTriggerPrice,
        input.intervalPct ?? existing.intervalPct,
        input.pauseStatus ?? existing.pauseStatus,
        input.pauseReason ?? existing.pauseReason,
        input.lastEntryAt ?? existing.lastEntryAt,
        symbol,
        input.side,
      )
      .run();
    return;
  }
  await requireDb()
    .prepare(
      "INSERT INTO dca_active_plans (symbol, side, product_type, entry_count, max_entries, avg_entry_price, " +
        "total_invested, next_trigger_price, interval_pct, pause_status, pause_reason, created_at, last_entry_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      symbol,
      input.side,
      input.productType ?? "FUTURES",
      input.entryCount ?? 0,
      input.maxEntries ?? 6,
      input.avgEntryPrice ?? null,
      input.totalInvested ?? null,
      input.nextTriggerPrice ?? null,
      input.intervalPct ?? null,
      input.pauseStatus ?? "NONE",
      input.pauseReason ?? null,
      input.createdAt ?? now,
      input.lastEntryAt ?? null,
    )
    .run();
}

export async function deleteDcaActivePlan(symbol: string, side: DcaPlanSide): Promise<void> {
  await requireDb()
    .prepare("DELETE FROM dca_active_plans WHERE symbol = ? AND side = ?")
    .bind(symbol.toUpperCase(), side)
    .run();
}

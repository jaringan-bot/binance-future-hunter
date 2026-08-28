// Wrapper tipis di atas D1 (binding DB, lihat wrangler.toml + migrations/0001_init.sql)
// buat time-series: basis/funding/OI snapshot (market_snapshots) dan skor
// sinyal MM (signal_history), keduanya diisi Cron tiap 5 menit (src/index.ts
// scheduled handler) untuk SNAPSHOT_WATCHLIST (shared.ts). Pola module-level
// setter sama seperti kvConfig.ts/binanceProxyClient.ts -- di-set sekali di
// awal fetch()/scheduled() sebelum tool logic jalan.
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
  watchCount: number;
  tradeCount: number;
}

export async function insertEntryAlertRunLog(row: EntryAlertRunLogRow): Promise<void> {
  await requireDb()
    .prepare("INSERT INTO entry_alert_run_log (run_at, total, errors, watch_count, trade_count) VALUES (?, ?, ?, ?, ?)")
    .bind(row.runAt, row.total, row.errors, row.watchCount, row.tradeCount)
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

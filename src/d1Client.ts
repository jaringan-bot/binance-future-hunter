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

  const result = await requireDb()
    .prepare(
      "SELECT captured_at, qty FROM wall_tracking WHERE symbol = ? AND side = ? AND price BETWEEN ? AND ? AND captured_at >= ? ORDER BY captured_at ASC",
    )
    .bind(symbol.toUpperCase(), side, lowPrice, highPrice, cutoff)
    .all<RawWallCandidateRow>();

  return result.results.map((r) => ({ capturedAt: r.captured_at, qty: r.qty }));
}

// Dipanggil dari scheduled() (index.ts) di tick 5-menit yang sudah ada --
// retensi 48 jam lebih dari cukup buat interval prune 5 menit, gak perlu
// Cron Trigger ke-3 cuma buat pembersihan (slot free-tier terbatas 5).
export async function pruneOldWallTracking(cutoffMs: number): Promise<void> {
  await requireDb().prepare("DELETE FROM wall_tracking WHERE captured_at < ?").bind(cutoffMs).run();
}

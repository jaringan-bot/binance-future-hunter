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

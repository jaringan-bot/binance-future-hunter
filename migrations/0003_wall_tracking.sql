-- wall_tracking: catat wall kandidat (level order book dgn qty >= 2x median
-- level lain di sisi yg sama) dari watchlist tetap (SNAPSHOT_WATCHLIST,
-- shared.ts), diisi Cron Trigger terpisah tiap 1 menit (beda dari cron
-- mm_activity/market_snapshots yg tiap 5 menit). Tujuan: lacak wall
-- bertahan/menyusut/hilang lintas waktu -- dibaca tool
-- binance_get_orderbook_wall_persistence (queryWallPersistence, d1Client.ts).
-- Ambang 2x median DI SINI cuma buat storage/tracking, BUKAN ambang 3x yg
-- dipakai keputusan trading di tempat lain -- jangan disamakan.
-- Row >48 jam di-prune tiap tick cron 5 menit (pruneOldWallTracking).
CREATE TABLE IF NOT EXISTS wall_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('bid','ask')),
  price REAL NOT NULL,
  qty REAL NOT NULL,
  median_ratio REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wall_symbol_time
  ON wall_tracking(symbol, captured_at);

CREATE INDEX IF NOT EXISTS idx_wall_symbol_side_price
  ON wall_tracking(symbol, side, price);

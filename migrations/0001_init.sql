-- market_snapshots: basis + funding + OI snapshot per watchlist pair,
-- diisi Cron tiap 5 menit (src/index.ts scheduled handler). Gantikan
-- BasisSnapshot yang tadinya di Workers KV (limit 1.000 write/hari
-- bikin watchlist dibatasi 3 pair -- D1 (5 juta write/hari) cukup buat 10).
CREATE TABLE market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  spot_price REAL,
  mark_price REAL,
  basis REAL,
  funding_rate REAL,
  open_interest REAL
);
CREATE INDEX idx_market_snapshots_symbol_time ON market_snapshots(symbol, timestamp);

-- signal_history: snapshot 6 skor sinyal binance_detect_mm_activity per
-- watchlist pair, diisi Cron yang sama. forward_return_* SENGAJA tidak
-- disimpan di sini -- binance_backtest_signal hitung on-demand dari klines
-- historis (Binance klines gak ada batas retensi kayak OI history, jadi
-- gak perlu cron kedua buat "isi ulang" kolom ini belakangan).
CREATE TABLE signal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  signal_type TEXT NOT NULL,
  score REAL NOT NULL,
  evidence TEXT
);
CREATE INDEX idx_signal_history_symbol_type_time ON signal_history(symbol, signal_type, timestamp);

-- Satu row per tick entryAlertCron.ts (runEntryAlertCheck): daftar SYMBOL
-- yang di-skip oleh pre-filter Wave 1 (entryRanking.ts -- di luar TOP-N,
-- jadi TIDAK masuk hard-screen maupun Wave 1/2 yang mahal).
--
-- Tujuan: AUDIT. Setelah beberapa hari, cek apakah pair yang di-skip
-- ternyata pernah jadi setup bagus (TRADE/WATCH) di logika lama -- kalau
-- iya, N (top_n) terlalu kecil atau formula ranking (funding_abs +
-- |priceChange24h|) salah bobot. skipped_symbols = JSON array string.
--
-- Di-prune otomatis (lihat pruneOldEntryAlertSkipLog di index.ts scheduled).
-- Retensi lebih panjang dari entry_alert_run_log (yang cuma 24 jam buat
-- lookback heartbeat 8 jam) karena window audit ini manual & multi-hari.
CREATE TABLE entry_alert_skip_log (
  run_at INTEGER PRIMARY KEY,
  skipped_symbols TEXT NOT NULL,
  skipped_count INTEGER NOT NULL,
  top_n INTEGER NOT NULL
);

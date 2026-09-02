-- Histori laporan CFTC COT (Traders in Financial Futures) per coin, satu row
-- per (coin, report_date) -- sebelum ini cftcClient.ts cuma ambil row
-- TERBARU tanpa disimpan (dataset CFTC sendiri dianggap cukup sebagai
-- histori). Table ini menutup gap itu: nyimpen snapshot lokal supaya bisa
-- hitung TREND rate-of-change multi-minggu (computeCftcTrend, cftcClient.ts)
-- tanpa bergantung ke query range CFTC yang lebih rumit/lambat per call.
--
-- Diisi idempotent (INSERT OR IGNORE, unique index coin+report_date) dari
-- cron yang piggyback HEARTBEAT_CRON (3x/hari) -- data CFTC sendiri cuma
-- update mingguan (Jumat), jadi cron ngecek lebih sering dari itu tidak
-- masalah (unique constraint yang jaga no-op kalau report_date belum ganti).
--
-- Retensi: TIDAK di-prune. 2 coin x ~1 row/minggu = ~104 row/tahun -- jauh di
-- bawah skala market_snapshots/signal_history yang butuh prune, dan histori
-- panjang justru berguna buat trend jangka panjang (bukan cuma WoW).
CREATE TABLE cftc_positioning_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin TEXT NOT NULL,
  report_date TEXT NOT NULL,
  open_interest REAL NOT NULL,
  lev_long REAL NOT NULL,
  lev_short REAL NOT NULL,
  lev_net_pct REAL NOT NULL,
  am_long REAL NOT NULL,
  am_short REAL NOT NULL,
  am_net_pct REAL NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_cftc_positioning_history_coin_date ON cftc_positioning_history(coin, report_date);

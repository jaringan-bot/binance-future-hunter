-- Satu row per tick entryAlertCron.ts (runEntryAlertCheck) -- rekam berapa
-- pair diproses vs gagal (error/rate-limit) + berapa yang WATCH/TRADE.
-- Dipakai heartbeatCron.ts (3x/hari) buat bedain "market emang sepi" vs
-- "backend bermasalah" pas 8 jam terakhir gak ada alert TRADE/WATCH sama
-- sekali. Di-prune otomatis (lihat pruneOldEntryAlertRunLog di index.ts),
-- retensi jauh lebih pendek dari request_log karena cuma dipakai buat window
-- lookback 8 jam.
CREATE TABLE entry_alert_run_log (
  run_at INTEGER PRIMARY KEY,
  total INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  watch_count INTEGER NOT NULL,
  trade_count INTEGER NOT NULL
);

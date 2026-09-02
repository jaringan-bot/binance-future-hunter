-- Tutup gap "no durable (features,label) dataset" -- pipeline_decision_log
-- (migration 0011) sudah punya fitur (ranking_score, hard_screen_*, regime,
-- funding, dst) tapi TIDAK PERNAH nyimpen outcome-nya balik, forward return
-- selalu dihitung transien di tool whalescope_backtest_pipeline_decisions.
-- Kolom di bawah diisi BELAKANGAN oleh cron backfill
-- (src/cron/pipelineDecisionOutcomeCron.ts, piggyback tick */5) setelah
-- window forward-nya lewat -- NULL sampai saat itu, bukan default 0 (0
-- return valid secara matematis, NULL != "belum dihitung").
--
-- SENGAJA additive ALTER TABLE (pola sama migration 0008/0009), BUKAN
-- table baru -- row yang sudah ada (existing sebelum migration ini)
-- otomatis eligible di-backfill karena filter cron-nya
-- "forward_return_24h IS NULL", bukan butuh row baru.
--
-- TIDAK mengubah cara whalescope_backtest_pipeline_decisions bekerja --
-- tool itu TETAP hitung on-demand (pola lama dipertahankan apa adanya,
-- lihat komentar di file tool-nya). Kolom ini dipakai KONSUMEN BARU:
-- script kalibrasi offline (scripts/calibrate-ranking-weights.mjs) yang
-- butuh dataset (fitur, label) yang SUDAH JADI tanpa refetch klines
-- berulang tiap kali mau eksperimen.
ALTER TABLE pipeline_decision_log ADD COLUMN forward_return_1h REAL;
ALTER TABLE pipeline_decision_log ADD COLUMN forward_return_4h REAL;
ALTER TABLE pipeline_decision_log ADD COLUMN forward_return_24h REAL;
-- 0/1, NULL kalau stop_loss row ini NULL (grid risk REJECT/gagal hard
-- screen) -- sama semantik dengan didStopLossTouch() (pipelineDecisionLog.ts)
-- yang sudah balikin null buat kasus itu.
ALTER TABLE pipeline_decision_log ADD COLUMN sl_touched_24h INTEGER;

-- Backfill cron query pending rows via "forward_return_24h IS NULL" --
-- index ini bikin scan itu murah begitu tabel tumbuh (90 hari retensi,
-- ~350k row proyeksi di README).
CREATE INDEX idx_pipeline_decision_log_pending_outcome ON pipeline_decision_log(forward_return_24h, run_at);

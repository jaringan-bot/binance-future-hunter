-- 4.3 (2026-09-04, Stage 4 signal-integrity): penanda percobaan backfill,
-- supaya baris yang gagal PERMANEN berhenti memblokir antrian outcome.
--
-- LATAR: queryPendingPipelineDecisionOutcomes() memilih baris dengan
--   WHERE forward_return_24h IS NULL AND run_at < ready AND run_at > giveUp
--   ORDER BY run_at ASC LIMIT 30
-- Urutan `run_at ASC` berarti baris TERTUA selalu dipilih ulang. Kalau ada
-- >= 30 baris yang gagal permanen (symbol delisted, klines < 289 candle,
-- gap data), ketiga puluh slot per tick habis dipakai baris yang sama
-- SETIAP tick selama 14 hari -- dan TIDAK ADA baris baru yang pernah
-- di-backfill. Antrian macet total tanpa satu pun error yang terlihat:
-- cron tetap "sukses", cuma updated=0 selamanya.
--
-- Kolom ini menghitung berapa kali sebuah baris sudah dicoba DAN gagal.
-- Baris yang sudah >= MAX_OUTCOME_ATTEMPTS dikeluarkan dari kandidat, jadi
-- slot per tick mengalir ke baris berikutnya.
--
-- NOT NULL DEFAULT 0 aman untuk ALTER TABLE SQLite (default konstan):
-- semua baris lama langsung bernilai 0 alias "belum pernah gagal" -- itu
-- benar, karena sebelum migration ini kegagalan memang tidak pernah
-- dicatat. Tidak ada semantik lama vs baru yang bercampur di kolom ini,
-- jadi TIDAK perlu nullable seperti 0013/0014/0015.
ALTER TABLE pipeline_decision_log ADD COLUMN outcome_attempts INTEGER NOT NULL DEFAULT 0;

-- Index pendukung urutan kandidat baru (outcome_attempts ASC, run_at ASC)
-- dengan predikat NULL yang sama -- partial index supaya kecil: hanya
-- baris yang BELUM punya outcome yang masuk.
CREATE INDEX IF NOT EXISTS idx_pdl_pending_outcome
  ON pipeline_decision_log (outcome_attempts, run_at)
  WHERE forward_return_24h IS NULL;

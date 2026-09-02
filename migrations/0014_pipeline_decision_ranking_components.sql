-- Persist 4 sub-skor komponen ranking Tier-1 ke pipeline_decision_log.
-- scoreTier1Signals() (src/pipelineEngine.ts) menghasilkan 4 komponen
-- (mm 35% / smartMoney 30% / regime 20% / buyPressure 15%) yang dijumlah
-- jadi ranking_score. Sampai migration ini, cuma ranking_score total yang
-- tersimpan -- 4 komponennya cuma ada di `notes` string, hilang buat
-- analisis. Blocker nyata buat scripts/calibrate-ranking-weights.mjs
-- (fit ulang bobot 4 komponen) jalan pakai data production asli:
-- tanpa nilai per-komponen historis, kalibrasi tidak bisa jalan.
--
-- SENGAJA additive ALTER TABLE + nullable (pola sama 0013). Row lama
-- (sebelum migration ini + row hard-screen-fail yang tidak sampai
-- scoreTier1Signals) TETAP NULL selamanya -- TIDAK ada backfill, NULL !=
-- "komponen bernilai 0". Konsumen (script kalibrasi) filter
-- "mm_component IS NOT NULL".
--
-- TIDAK mengubah cara ranking_score dihitung atau threshold TRADE/WATCH
-- (55) -- kolom ini murni observasi tambahan.
ALTER TABLE pipeline_decision_log ADD COLUMN mm_component REAL;
ALTER TABLE pipeline_decision_log ADD COLUMN smart_money_component REAL;
ALTER TABLE pipeline_decision_log ADD COLUMN regime_component REAL;
ALTER TABLE pipeline_decision_log ADD COLUMN buy_pressure_component REAL;

-- Satu row per symbol per tick entry-alert Phase 2 (dan opsional
-- whalescope_full_pipeline persist=true). Compute sudah dibayar cron;
-- yang tadinya dibuang (keputusan + alasan hard-screen + bound grid)
-- disimpan compact supaya formula terpasang (skor 55, vol $5M, funding
-- 0.05%, spike darurat) bisa diuji maju. Forward return TIDAK disimpan
-- -- dihitung on-demand dari klines (whalescope_backtest_pipeline_decisions),
-- pola yang sama dengan signal_history / binance_backtest_signal.
--
-- source: entry_alert | manual | dropstab
-- source_ref: opsional (slug tab Dropstab, dll)
CREATE TABLE pipeline_decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  decision TEXT NOT NULL,
  ranking_score REAL NOT NULL,
  hard_screen_passed INTEGER NOT NULL,
  hard_screen_reasons TEXT,
  quote_volume_usd REAL,
  funding_rate REAL,
  regime_1h TEXT,
  regime_4h TEXT,
  grid_risk_status TEXT,
  lower_price REAL,
  upper_price REAL,
  stop_loss REAL
);
CREATE INDEX idx_pipeline_decision_log_symbol_time ON pipeline_decision_log(symbol, run_at);
CREATE INDEX idx_pipeline_decision_log_run_at ON pipeline_decision_log(run_at);
CREATE INDEX idx_pipeline_decision_log_source_time ON pipeline_decision_log(source, run_at);

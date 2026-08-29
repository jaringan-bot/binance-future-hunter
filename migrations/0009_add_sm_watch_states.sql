-- Smart Money Core Engine V2 (src/cron/smartMoneyPipelineEngine.ts):
-- state watch per-symbol dengan countdown ticks_remaining (default 4) +
-- invalidated_at, plus tally head Traditional/Smart-Money per tick entry-alert
-- (sejajar watch_count/trade_count grid & dca_* di entry_alert_run_log).
-- trad_* DEFAULT 0 supaya baris run-log lama tetap valid.
CREATE TABLE IF NOT EXISTS sm_watch_states (
    symbol TEXT PRIMARY KEY,
    scenario TEXT,
    score INTEGER,
    trigger_price REAL,
    trigger_atr REAL,
    created_at INTEGER,
    ticks_remaining INTEGER DEFAULT 4,
    invalidated_at INTEGER
);
ALTER TABLE entry_alert_run_log ADD COLUMN trad_trade_count INTEGER DEFAULT 0;
ALTER TABLE entry_alert_run_log ADD COLUMN trad_watch_count INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS entry_alert_state (
  symbol TEXT PRIMARY KEY,
  last_decision TEXT NOT NULL,
  last_alert_at INTEGER
);

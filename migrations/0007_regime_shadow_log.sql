-- regime_shadow_log: shadow-mode observation table for RegimeCap threshold
-- calibration (2026-08-27, see regimecap_shadow_mode_design_2026-08-27.md
-- in the WhaleScope prompt workspace, not checked into this repo). Fills
-- the 1.4x-4.9x volatilitySpike blind spot the emergency patch's
-- SPIKE_FALLBACK_MIN=4.0 was picked without any real data for. Additive
-- observation only -- never read by evaluateHardScreen()/scoreTier1Signals(),
-- does not influence any live decision.
--
-- Deliberately NOT auto-pruned like request_log/wall_tracking/
-- entry_alert_run_log -- the whole point is longitudinal data over weeks
-- for calibration. Revisit retention once enough data is collected.
CREATE TABLE IF NOT EXISTS regime_shadow_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  timeframe TEXT NOT NULL,
  regime TEXT NOT NULL,
  adx REAL NOT NULL,
  volatility_spike REAL NOT NULL,
  entry_close REAL NOT NULL,
  hard_screen_passed INTEGER NOT NULL,
  hard_screen_reason TEXT,
  forward_return_5 REAL,
  forward_return_10 REAL,
  forward_return_20 REAL,
  forward_computed_at INTEGER
);
CREATE INDEX idx_regime_shadow_log_captured_at ON regime_shadow_log(captured_at);
CREATE INDEX idx_regime_shadow_log_symbol ON regime_shadow_log(symbol);
CREATE INDEX idx_regime_shadow_log_forward_pending ON regime_shadow_log(forward_computed_at);

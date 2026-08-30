-- Phase 3 DCA Smart Money Adapter V3: stateful tracking rencana DCA aktif
-- per symbol/side sebelum memicu notifikasi Telegram (entry ke-N, avg price,
-- next trigger, pause guard). Dipakai src/cron/dcaSmartMoneyAdapter.ts +
-- entryAlertCron.ts.
CREATE TABLE IF NOT EXISTS dca_active_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'LONG',
    product_type TEXT NOT NULL DEFAULT 'FUTURES',
    entry_count INTEGER DEFAULT 0,
    max_entries INTEGER DEFAULT 6,
    avg_entry_price REAL,
    total_invested REAL,
    next_trigger_price REAL,
    interval_pct REAL,
    pause_status TEXT DEFAULT 'NONE',
    pause_reason TEXT,
    created_at INTEGER,
    last_entry_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dca_active_plans_symbol_side
    ON dca_active_plans (symbol, side);

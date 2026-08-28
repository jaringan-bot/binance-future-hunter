-- Tally head DCA per tick entry-alert, sejajar watch_count/trade_count yang
-- SEKARANG bermakna GRID (nama kolom lama dipertahankan). Observability saja:
-- heartbeatCron.ts belum baca kolom ini -- suppression "market sepi" jalan
-- lewat entry_alert_state.last_alert_at yang di-update alert gabungan
-- grid+DCA. DEFAULT 0 supaya baris lama tetap valid.
ALTER TABLE entry_alert_run_log ADD COLUMN dca_watch_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entry_alert_run_log ADD COLUMN dca_trade_count INTEGER NOT NULL DEFAULT 0;

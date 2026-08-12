-- request_log: catat tiap request masuk ke /mcp (IP, negara, colo,
-- user-agent) -- dasar buat endpoint owner-only GET /admin/usage
-- (src/index.ts). BUKAN buat MCP tool (privasi: siapa aja yang connect ke
-- server ini bisa manggil tool, jangan bocorin log visitor lain ke mereka).
-- Row di-prune otomatis oleh scheduled() (>30 hari) -- beda dari
-- market_snapshots/signal_history yang row-nya kekontrol ketat (watchlist
-- 10 pair tetap), tabel ini bisa growth gak terduga kalau ada traffic asing.
CREATE TABLE request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  ip TEXT,
  country TEXT,
  colo TEXT,
  user_agent TEXT
);
CREATE INDEX idx_request_log_timestamp ON request_log(timestamp);

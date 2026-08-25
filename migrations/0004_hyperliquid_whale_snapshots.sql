CREATE TABLE IF NOT EXISTS hyperliquid_whale_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  coin TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('long','short')),
  size REAL NOT NULL,
  entry_price REAL,
  leverage REAL
);

CREATE INDEX IF NOT EXISTS idx_hlwhale_addr_coin_time
  ON hyperliquid_whale_snapshots(wallet_address, coin, captured_at);

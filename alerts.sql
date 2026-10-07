CREATE TABLE IF NOT EXISTS alerts (
  owner TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ticker TEXT NOT NULL,
  threshold_bps REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, symbol)
);

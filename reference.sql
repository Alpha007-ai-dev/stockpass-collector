CREATE TABLE IF NOT EXISTS reference_prices (
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  bid REAL,
  ask REAL,
  mid REAL,
  last_px REAL,
  market_state TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ref_ts ON reference_prices (ticker, ts);

CREATE TABLE IF NOT EXISTS measurements (
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  symbol TEXT NOT NULL,
  issuer TEXT NOT NULL,
  size_usd INTEGER NOT NULL,
  market_state TEXT NOT NULL,
  quotable INTEGER NOT NULL,
  buy_px REAL,
  sell_px REAL,
  entry_bps INTEGER,
  exit_bps INTEGER,
  multiplier REAL,
  supply REAL
);
CREATE INDEX IF NOT EXISTS idx_ts ON measurements (ticker, ts);

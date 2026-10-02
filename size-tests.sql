CREATE TABLE IF NOT EXISTS size_tests (
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  symbol TEXT NOT NULL,
  issuer TEXT NOT NULL,
  size_usd INTEGER NOT NULL,
  market_state TEXT,
  quotable INTEGER NOT NULL,
  entry_bps INTEGER,
  exit_bps INTEGER
);
CREATE INDEX IF NOT EXISTS idx_size_symbol ON size_tests(symbol, size_usd, ts);

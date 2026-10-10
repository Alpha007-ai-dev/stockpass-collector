CREATE TABLE IF NOT EXISTS tokens (
  symbol TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  issuer TEXT NOT NULL,
  mint TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  icon TEXT,
  name TEXT,
  updated_at INTEGER NOT NULL
);

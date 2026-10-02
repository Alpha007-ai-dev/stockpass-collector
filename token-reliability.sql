CREATE TABLE IF NOT EXISTS token_reliability (
  symbol TEXT PRIMARY KEY,
  ticker TEXT,
  issuer TEXT,
  samples INTEGER,
  quotable_count INTEGER,
  availability INTEGER,
  avg_entry REAL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_token_rel_issuer ON token_reliability(issuer, availability);

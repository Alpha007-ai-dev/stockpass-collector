CREATE TABLE IF NOT EXISTS reliability_cache (
  issuer TEXT PRIMARY KEY,
  samples INTEGER,
  tokens INTEGER,
  availability REAL,
  avg_entry REAL,
  reliable_tokens INTEGER,
  never_quotable INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS weakest_cache (
  symbol TEXT PRIMARY KEY,
  issuer TEXT,
  samples INTEGER,
  quotable_count INTEGER,
  availability REAL,
  updated_at INTEGER
);

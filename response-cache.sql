CREATE TABLE IF NOT EXISTS response_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

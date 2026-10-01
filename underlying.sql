CREATE TABLE IF NOT EXISTS underlying (
  ticker TEXT PRIMARY KEY,
  name TEXT, industry TEXT, exchange TEXT, country TEXT,
  market_cap REAL, employees INTEGER, ipo TEXT, weburl TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_date TEXT NOT NULL,
  detail TEXT, amount REAL, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ticker ON events(ticker, event_date);

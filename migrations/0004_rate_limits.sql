-- Fixed-window rate-limit counters (H-2). One row per (bucket, IP/actor); the
-- window_start epoch lets a stale row be reused instead of accumulating forever.
CREATE TABLE IF NOT EXISTS rate_limits (
  k            TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

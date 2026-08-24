CREATE TABLE IF NOT EXISTS security_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_rate_limits_window
  ON security_rate_limits(window_start);

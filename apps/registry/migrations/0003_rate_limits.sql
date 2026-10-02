-- Phase 3: strongly consistent rate-limit counters (fixed windows), used for publishes and failed
-- authentication. Cloudflare's Rate Limiting binding is approximate, so security-relevant limits
-- are also enforced here.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits(window_start);

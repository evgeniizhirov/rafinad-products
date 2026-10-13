-- P07 / FR-01: personal API keys for Claude Code, Codex and integrations.
-- Only a SHA-256 hash of the token is stored; the token is shown once on creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  prefix         TEXT NOT NULL UNIQUE,          -- public part of the token (rr_<prefix>_<secret>), for lookup and display
  secret_hash    TEXT NOT NULL,                 -- sha256 of the whole token
  scopes         TEXT NOT NULL,                 -- JSON array
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  revoked_by     TEXT REFERENCES users(id),
  last_used_at   TEXT,
  use_count      INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT,                          -- rate limit window (1 minute)
  window_count   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_id);

-- which key performed an audited action (NULL for browser sessions)
ALTER TABLE audit_log ADD COLUMN api_key_id TEXT;

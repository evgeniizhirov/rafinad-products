-- P08 / FR-08: manual export of tasks (XLSX download or the «Import» tab of an admin-configured Google spreadsheet).
CREATE TABLE IF NOT EXISTS export_runs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT REFERENCES users(id),
  api_key_id   TEXT,
  target       TEXT NOT NULL CHECK (target IN ('xlsx', 'google')),
  query        TEXT NOT NULL,           -- filter snapshot (URL query string)
  row_count    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  error        TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
-- one Google export at a time: a second concurrent run fails on this index instead of interleaving writes
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_runs_google_running ON export_runs(target) WHERE status = 'running' AND target = 'google';

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('export_google_spreadsheet_id', ''),
  ('export_google_roles', 'product,admin');

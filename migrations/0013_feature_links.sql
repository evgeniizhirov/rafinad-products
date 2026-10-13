-- vNext PR 3 (ТЗ §3): external links of a task — plain URLs only (Bitrix24, Jira, documentation, other).
-- No integration: the app never calls Jira / Bitrix24 / Confluence and never reads what is behind a link.
CREATE TABLE IF NOT EXISTS feature_links (
  id               TEXT PRIMARY KEY,
  feature_id       TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('bitrix24', 'jira', 'docs', 'other')),
  url              TEXT NOT NULL,                      -- validated http(s) URL, stored as entered (trimmed)
  title            TEXT,                               -- optional readable name
  -- origin: 'manual' = added in the card / API; 'import' = created by a sheet source (PR 4).
  -- An import never changes or removes a manual link; a manual edit of an imported link sets locally_edited.
  origin           TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'import')),
  source_id        TEXT REFERENCES sheet_sources(id) ON DELETE SET NULL,
  source_column    TEXT,
  locally_edited   INTEGER NOT NULL DEFAULT 0 CHECK (locally_edited IN (0, 1)),
  created_at       TEXT NOT NULL,
  created_by       TEXT REFERENCES users(id),
  updated_at       TEXT NOT NULL,
  updated_by       TEXT REFERENCES users(id),
  version          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (feature_id, url)                             -- the same URL is never stored twice on a task
);
CREATE INDEX IF NOT EXISTS idx_feature_links_feature ON feature_links(feature_id);

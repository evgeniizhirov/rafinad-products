-- P06 / FR-03: business blockers — what we wait for, from whom, since when. Technical "blocks" relations stay as they are.
CREATE TABLE IF NOT EXISTS feature_blockers (
  id                    TEXT PRIMARY KEY,
  feature_id            TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  expectation           TEXT NOT NULL,              -- what is expected: input data, approval, decision…
  owner_department_id   TEXT REFERENCES departments(id) ON DELETE SET NULL,
  owner_name            TEXT,                       -- person / external party (free text)
  started_at            TEXT NOT NULL,              -- waiting since (date)
  due_at                TEXT,                       -- answer expected by (optional)
  resolved_at           TEXT,
  resolution            TEXT,
  created_at            TEXT NOT NULL,
  created_by            TEXT REFERENCES users(id),
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_feature_blockers_open ON feature_blockers(feature_id) WHERE resolved_at IS NULL;

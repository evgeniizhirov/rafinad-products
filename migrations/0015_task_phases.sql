-- vNext PR 5 (ТЗ §2.2–2.3): stages of every task on the Gantt — plan from the sprint, baseline, confirmed facts, forecast.
-- Owner decision 13.10: phases ARE the team stages, in this order: Продукт → Дизайн → Разработка (Backend и Frontend вместе) → QA → Релиз.

-- the phase a stage belongs to (NULL = not shown on the Gantt)
ALTER TABLE stages ADD COLUMN phase TEXT CHECK (phase IN ('product', 'design', 'dev', 'qa', 'release'));
UPDATE stages SET phase = 'product' WHERE code = 'product';
UPDATE stages SET phase = 'design'  WHERE code = 'design';
UPDATE stages SET phase = 'dev'     WHERE code IN ('backend', 'frontend');
UPDATE stages SET phase = 'qa'      WHERE code = 'qa';
UPDATE stages SET phase = 'release' WHERE code = 'release';

-- Baseline of a task's phases, captured when the release plan is approved (owner decision 13.10).
-- Never overwritten: a revised agreement is a new revision with a reason. Sprint moves change the plan, not this.
CREATE TABLE IF NOT EXISTS feature_plan_baselines (
  id            TEXT PRIMARY KEY,
  feature_id    TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  release_id    TEXT REFERENCES releases(id) ON DELETE SET NULL,
  sprint_id     TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  dev_start     TEXT,
  dev_end       TEXT,
  qa_start      TEXT,
  qa_end        TEXT,
  release_date  TEXT,
  reason        TEXT,
  captured_at   TEXT NOT NULL,
  captured_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (feature_id, revision)
);

-- Confirmed phase transitions (facts). A calendar date passing never creates one.
CREATE TABLE IF NOT EXISTS feature_phase_events (
  id           TEXT PRIMARY KEY,
  feature_id   TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  phase        TEXT NOT NULL CHECK (phase IN ('product', 'design', 'dev', 'qa', 'release')),
  kind         TEXT NOT NULL CHECK (kind IN ('start', 'done')),
  at           TEXT NOT NULL,                 -- YYYY-MM-DD of the fact
  original_at  TEXT,                          -- set when the date was corrected later
  reason       TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  corrected_at TEXT,
  corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_phase_events_feature ON feature_phase_events(feature_id);

-- Product forecast for an unfinished phase (delay / early finish), with a reason. Not a change of the baseline.
CREATE TABLE IF NOT EXISTS feature_phase_forecasts (
  feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('product', 'design', 'dev', 'qa', 'release')),
  end_date    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (feature_id, phase)
);

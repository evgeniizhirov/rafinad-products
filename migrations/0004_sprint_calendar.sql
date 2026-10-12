-- P03 / FR-06 (+ focus from FR-03): calendar months, two-sprint releases, task → sprint.
-- Additive. capacity_periods / features.period_id keep their meaning (old planning periods) and are not touched.

-- Release cycle number (e.g. 8 for "Релиз 8"); NULL for releases created by hand before the calendar existed.
ALTER TABLE releases ADD COLUMN cycle_number INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_cycle ON releases(cycle_number) WHERE cycle_number IS NOT NULL;

-- Sprint = 14 days Wednesday..Tuesday, two per release. Testing starts the next day,
-- production deadline is the Thursday 9 days after the sprint end.
CREATE TABLE IF NOT EXISTS sprints (
  id              TEXT PRIMARY KEY,
  release_id      TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL CHECK (ordinal IN (1, 2)),
  code            TEXT NOT NULL UNIQUE,              -- "8.1"
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  testing_start   TEXT NOT NULL,
  production_due  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'closed')),
  closed_at       TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (release_id, ordinal),
  CHECK (end_date >= start_date AND testing_start > end_date AND production_due >= testing_start)
);
CREATE INDEX IF NOT EXISTS idx_sprints_dates ON sprints(start_date, end_date);

-- Calendar month for budget and resource availability (1st .. last day). Never equal to a sprint.
CREATE TABLE IF NOT EXISTS accounting_months (
  id                TEXT PRIMARY KEY,                 -- "m_2026_10"
  month             TEXT NOT NULL UNIQUE,             -- "2026-10"
  start_date        TEXT NOT NULL,
  end_date          TEXT NOT NULL,
  budget_limit_rub  REAL,                             -- set in P04; NULL = not set
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  CHECK (end_date >= start_date)
);

-- Task → sprint (planned tasks: part of the sprint plan; bugs / operational fixes: reference only).
ALTER TABLE features ADD COLUMN sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL;
-- Planned production date (defaults to the sprint deadline, changes when the task moves).
ALTER TABLE features ADD COLUMN planned_production_date TEXT;
-- First promised production date; never moved by rescheduling (timeliness analytics, FR-11).
ALTER TABLE features ADD COLUMN baseline_production_date TEXT;
-- Release commitment to the business ("фокусная задача"); independent of status and of the Gantt.
ALTER TABLE features ADD COLUMN is_focus INTEGER NOT NULL DEFAULT 0 CHECK (is_focus IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_features_sprint ON features(sprint_id);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('calendar_anchor_date', '2026-10-07'),
  ('calendar_anchor_release', '8'),
  ('calendar_releases_ahead', '3'),
  ('calendar_months_ahead', '12');

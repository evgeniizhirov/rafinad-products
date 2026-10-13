-- P04 / FR-05: team rates versioned by sprint, monthly budget and capacity, month snapshots.

-- Rate history. Rows are never updated: a new row starting at a later sprint supersedes the previous one.
CREATE TABLE IF NOT EXISTS team_rates (
  id                   TEXT PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES resource_teams(id) ON DELETE CASCADE,
  effective_sprint_id  TEXT REFERENCES sprints(id),        -- NULL = initial rate (from the beginning)
  effective_from       TEXT NOT NULL,                      -- start date of that sprint (or 2000-01-01)
  rate_rub_per_hour    REAL NOT NULL CHECK (rate_rub_per_hour >= 0),
  include_in_budget    INTEGER NOT NULL CHECK (include_in_budget IN (0, 1)),
  note                 TEXT,
  created_at           TEXT NOT NULL,
  created_by           TEXT REFERENCES users(id),
  UNIQUE (team_id, effective_from)
);

-- Guaranteed team hours per calendar month (team aggregate; per-employee breakdown is an open decision).
CREATE TABLE IF NOT EXISTS month_capacities (
  month_id    TEXT NOT NULL REFERENCES accounting_months(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES resource_teams(id) ON DELETE CASCADE,
  hours       REAL NOT NULL CHECK (hours >= 0),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (month_id, team_id)
);

-- Frozen calculation of a closed month: later rate changes never rewrite it.
CREATE TABLE IF NOT EXISTS month_snapshots (
  month_id    TEXT PRIMARY KEY REFERENCES accounting_months(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id)
);

-- Initial rates (FR-05): Backend / Frontend / QA / DevOps 2200 ₽/h in the budget; Product / Design count in hours only.
INSERT OR IGNORE INTO team_rates (id, team_id, effective_sprint_id, effective_from, rate_rub_per_hour, include_in_budget, note, created_at)
SELECT 'rate_init_' || id, id, NULL, '2000-01-01',
       CASE WHEN code IN ('backend', 'frontend', 'qa', 'devops') THEN 2200 ELSE 0 END,
       CASE WHEN code IN ('backend', 'frontend', 'qa', 'devops') THEN 1 ELSE 0 END,
       'Начальная ставка', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM resource_teams;

-- How forecast hours of a work interval are spread over calendar months (open decision №2 of the TZ).
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('budget_allocation', 'workdays');

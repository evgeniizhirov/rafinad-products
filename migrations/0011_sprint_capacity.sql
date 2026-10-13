-- Owner decisions of 13.10 on top of P04/P08:
--   * team availability is ONE number per team per SPRINT (not per month, not per employee);
--   * the monthly budget stays a rouble limit set per calendar month (accounting_months.budget_limit_rub).
-- month_capacities (0009) never reached production and is replaced by sprint_capacities.
CREATE TABLE IF NOT EXISTS sprint_capacities (
  sprint_id   TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES resource_teams(id) ON DELETE CASCADE,
  hours       REAL NOT NULL CHECK (hours >= 0),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (sprint_id, team_id)
);
DROP TABLE IF EXISTS month_capacities;


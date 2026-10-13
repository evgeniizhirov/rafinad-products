-- vNext v2-10 (owner decision 13.10 №11 «Старые плановые периоды — удалить»): the old planning periods
-- (capacity_periods, team_capacities, features.period_id / placement_locked), the period auto-planner (plan_runs)
-- and its plan alerts (plan_alerts) are removed. Planning is by sprints only: «Планировщик», «Бюджет», the Gantt.
-- ⚠ DESTRUCTIVE: deletes the periods and team hours of the old planner. On prod (13.10): 8 periods, 36 capacity
--   rows, 0 tasks placed in a period. Apply only with the owner's confirmation at deploy time, after a D1 Time Travel
--   bookmark. Audit records of old placements stay in audit_log (history), they reference ids only.
-- Order matters: drop the index and the columns first (features.period_id references capacity_periods), then tables.
UPDATE features SET period_id = NULL WHERE period_id IS NOT NULL;
DROP INDEX IF EXISTS idx_features_period;
ALTER TABLE features DROP COLUMN period_id;
ALTER TABLE features DROP COLUMN placement_locked;
DROP TABLE IF EXISTS team_capacities;
DROP TABLE IF EXISTS capacity_periods;
DROP TABLE IF EXISTS plan_runs;
DROP TABLE IF EXISTS plan_alerts;
DELETE FROM app_settings WHERE key IN ('planning_horizon', 'public_show_capacity');

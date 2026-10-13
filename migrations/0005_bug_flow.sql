-- P05 / FR-07: bugs and operational improvements.
-- Their state is the ordinary status (semantic new / in_progress / done …), the planned fix date is planned_end,
-- the actual fix date is closed_at. New here: urgency (not a department vote) and actual hours (analytics only).
ALTER TABLE features ADD COLUMN urgency TEXT CHECK (urgency IN ('low', 'medium', 'high', 'critical'));
ALTER TABLE features ADD COLUMN fact_hours REAL CHECK (fact_hours IS NULL OR fact_hours >= 0);

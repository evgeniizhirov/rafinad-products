-- Import runs can be built from a CSV export uploaded by the user (origin = 'file')
-- instead of reading the connected Google Sheet (origin = 'source').
ALTER TABLE import_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'source';

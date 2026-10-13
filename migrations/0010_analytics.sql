-- P09 / FR-11: analytics settings and an index for status-history scans.
-- Status / priority history is read from audit_log (it records every change since a task was created in the app).
-- A task without a 'created' / 'import_created' record (demo seed, data loaded before the app) has no reliable
-- history and is reported as «нет истории», never as «не откладывалась».
CREATE INDEX IF NOT EXISTS idx_audit_entity_action ON audit_log(entity_type, action, entity_id);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('analytics_high_priority', '4');

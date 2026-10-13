-- vNext PR 8 (ТЗ §5): permanent deletion by an administrator.
-- Additive. A record deleted for good must not come back with the next sync from the source it was imported from:
-- the link (source, external id) is replaced by a tombstone. The import preview shows such a row as skipped
-- («удалена администратором»); choosing «Восстановить импорт» creates it anew and removes the tombstone.
-- Only what is needed to recognise the row is kept — no title, no content (owner decision 13.10: history is wiped).
CREATE TABLE IF NOT EXISTS import_tombstones (
  source_id    TEXT NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('feature', 'epic')),
  external_id  TEXT NOT NULL,
  entity_key   TEXT NOT NULL,             -- RF-12 / EP-3 of the deleted record, for the preview message
  deleted_at   TEXT NOT NULL,
  deleted_by   TEXT,                      -- user id (no FK: the user may be removed later)
  PRIMARY KEY (source_id, entity_type, external_id)
);

-- Numbers of deleted records are never reused: app_settings 'number_floor.features|epics|proposals' keeps the
-- highest deleted number (written by the delete itself, no rows needed here).

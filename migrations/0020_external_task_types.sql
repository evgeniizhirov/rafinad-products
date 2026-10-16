-- Empty allowlist: migration never discloses or reclassifies existing RF tasks.
CREATE TABLE external_task_types (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type_value TEXT NOT NULL CHECK(length(trim(type_value)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source,type_value)
);
CREATE TABLE external_type_revision (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
INSERT INTO external_type_revision VALUES('catalog',1);
ALTER TABLE inbox_items ADD COLUMN auto_managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_items ADD COLUMN rf_sync TEXT NOT NULL DEFAULT '{}';
ALTER TABLE inbox_items ADD COLUMN classified_type TEXT;
-- A field has one source owner even when multiple external tasks share one RF.
CREATE TABLE external_rf_owners (
  feature_id TEXT PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL UNIQUE REFERENCES inbox_items(id)
);

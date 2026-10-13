-- vNext PR 9 (ТЗ §4; owner decision 13.10 №15, variant A): templates of the export builder.
-- Additive. A template is a JSON spec: columns (field + title), backlog filters, sort, up to two groupings, subtotals.
-- personal — visible and editable by its owner only; shared — created / edited by an administrator, visible to all
-- employees (fields a viewer may not see are dropped for that viewer on the server).
-- The built-in «TaskFlow — 12 колонок» template is not stored: it is fixed in code (domain/exportFields.ts).
CREATE TABLE IF NOT EXISTS export_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('personal', 'shared')),
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  spec        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_export_templates_owner ON export_templates(owner_id);

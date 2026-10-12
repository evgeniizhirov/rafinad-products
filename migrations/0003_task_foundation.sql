-- P02 / FR-02, FR-07 (base), FR-10: work type, Product-internal tasks, initiator.
-- Additive only: existing tasks become 'planned', not internal, without an initiator.

-- planned | bug | operational_improvement (bugs and operational fixes never enter planning or budgets)
ALTER TABLE features ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'planned'
  CHECK (task_kind IN ('planned', 'bug', 'operational_improvement'));

-- Hidden Product task: visible to product/admin only. Independent of visibility ('internal' = all employees).
ALTER TABLE features ADD COLUMN is_product_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_product_internal IN (0, 1));

-- Initiator (who asked for the task) — separate from created_by / author_name / assignee_name.
ALTER TABLE features ADD COLUMN initiator_type TEXT CHECK (initiator_type IN ('free_text', 'user', 'department'));
ALTER TABLE features ADD COLUMN initiator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE features ADD COLUMN initiator_department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
-- free text, or a snapshot of the user / department name at the moment of the choice
ALTER TABLE features ADD COLUMN initiator_name TEXT;

CREATE INDEX IF NOT EXISTS idx_features_kind ON features(task_kind);
CREATE INDEX IF NOT EXISTS idx_features_internal ON features(is_product_internal);

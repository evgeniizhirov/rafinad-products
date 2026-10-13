-- vNext PR 2 (ТЗ §1.2): «Предложения» — business needs / expected results raised by any employee.
-- Not the old offers catalog: a separate entity with its own ids (P-N).
CREATE TABLE IF NOT EXISTS proposals (
  id               TEXT PRIMARY KEY,
  number           INTEGER NOT NULL UNIQUE,                 -- shown as P-<number>
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',                -- the business need
  expected_result  TEXT,                                    -- what should change for the business
  author_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name      TEXT NOT NULL,                           -- snapshot: survives a deleted user
  department_id    TEXT REFERENCES departments(id) ON DELETE SET NULL,  -- initiating department (optional)
  -- new → review → accepted / postponed / rejected → planned → implemented (transitions: worker/domain/proposals.ts)
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'review', 'accepted', 'postponed', 'rejected', 'planned', 'implemented')),
  decision_reason  TEXT,                                    -- required for postponed / rejected
  decided_at       TEXT,
  decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  implemented_at   TEXT,
  merged_into_id   TEXT REFERENCES proposals(id),           -- duplicate merged into another proposal (kept for history and authors)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

-- importance from departments: one vote per department (same weights and membership rules as task votes)
CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id    TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  voted_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  voted_at       TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (proposal_id, department_id)
);

-- many-to-many: a proposal can be delivered by several tasks, a task can deliver several proposals
CREATE TABLE IF NOT EXISTS proposal_features (
  proposal_id  TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  feature_id   TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (proposal_id, feature_id)
);
CREATE INDEX IF NOT EXISTS idx_proposal_features_feature ON proposal_features(feature_id);

CREATE TABLE IF NOT EXISTS proposal_comments (
  id           TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name  TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  moved_from   TEXT                                         -- proposal the comment came from when duplicates were merged
);
CREATE INDEX IF NOT EXISTS idx_proposal_comments_proposal ON proposal_comments(proposal_id);

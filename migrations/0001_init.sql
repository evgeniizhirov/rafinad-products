-- Rafinad Product Roadmap — initial schema (Cloudflare D1 / SQLite)
-- Conventions:
--   * ids are TEXT (random), timestamps are ISO-8601 UTC strings, booleans are INTEGER 0/1
--   * every user-editable entity has `version` for optimistic locking
--   * visibility: 'draft' (not reviewed), 'internal' (employees only), 'public' (guests too)

-- ───────────────────────────── Access ─────────────────────────────
CREATE TABLE roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  rank        INTEGER NOT NULL
);

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                  TEXT NOT NULL,
  role_code             TEXT NOT NULL REFERENCES roles(code),
  password_hash         TEXT,
  must_change_password  INTEGER NOT NULL DEFAULT 1,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_login_at         TEXT,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- SHA-256 of the cookie token, never the token itself
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE invites (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE login_attempts (
  key               TEXT PRIMARY KEY,      -- 'email:<email>' or 'ip:<ip>'
  failures          INTEGER NOT NULL,
  first_failure_at  TEXT NOT NULL,
  locked_until      TEXT
);

-- ───────────────────────────── Dictionaries ─────────────────────────────
CREATE TABLE departments (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  is_product  INTEGER NOT NULL DEFAULT 0,  -- tie-breaker department ("Product")
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE department_memberships (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE resource_teams (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,       -- also the default Google Sheets column prefix: <code>_hours
  name        TEXT NOT NULL,
  color       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1
);

-- semantic drives business rules (planning, completion dates) so admins can rename / add statuses freely
CREATE TABLE statuses (
  id          TEXT PRIMARY KEY,
  entity      TEXT NOT NULL CHECK (entity IN ('feature','epic','offer','release')),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  semantic    TEXT NOT NULL,
  color       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (entity, code)
);

CREATE TABLE stages (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE capacity_periods (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  CHECK (end_date >= start_date)
);

CREATE TABLE team_capacities (
  period_id   TEXT NOT NULL REFERENCES capacity_periods(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES resource_teams(id) ON DELETE CASCADE,
  hours       REAL NOT NULL CHECK (hours >= 0),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (period_id, team_id)
);

CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ───────────────────────────── Catalog ─────────────────────────────
CREATE TABLE epics (
  id             TEXT PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE,
  external_ref   TEXT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
  owner_name     TEXT,
  status_id      TEXT NOT NULL REFERENCES statuses(id),
  start_date     TEXT,
  end_date       TEXT,
  visibility     TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','internal','public')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE features (
  id               TEXT PRIMARY KEY,
  number           INTEGER NOT NULL UNIQUE,
  external_ref     TEXT,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category_id      TEXT REFERENCES categories(id) ON DELETE SET NULL,
  epic_id          TEXT REFERENCES epics(id) ON DELETE SET NULL,
  status_id        TEXT NOT NULL REFERENCES statuses(id),
  stage_id         TEXT REFERENCES stages(id) ON DELETE SET NULL,
  author_name      TEXT,
  assignee_name    TEXT,
  requested_at     TEXT,
  planned_start    TEXT,
  planned_end      TEXT,
  closed_at        TEXT,
  visibility       TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','internal','public')),
  period_id        TEXT REFERENCES capacity_periods(id) ON DELETE SET NULL,
  placement_locked INTEGER NOT NULL DEFAULT 0,   -- placement confirmed by product team; planner never moves it
  private_notes    TEXT,
  merged_into_id   TEXT REFERENCES features(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  created_by       TEXT REFERENCES users(id),
  updated_by       TEXT REFERENCES users(id),
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_features_epic ON features(epic_id);
CREATE INDEX idx_features_period ON features(period_id);
CREATE INDEX idx_features_status ON features(status_id);
CREATE INDEX idx_features_merged ON features(merged_into_id);

CREATE TABLE feature_tags (
  feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (feature_id, tag)
);

CREATE TABLE feature_estimates (
  feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES resource_teams(id) ON DELETE CASCADE,
  hours       REAL NOT NULL CHECK (hours >= 0 AND hours <= 100000),
  is_manual   INTEGER NOT NULL DEFAULT 1,     -- 0 = came from import and never refined by hand
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (feature_id, team_id)
);

CREATE TABLE offers (
  id             TEXT PRIMARY KEY,
  external_code  TEXT UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
  direction      TEXT,
  status_id      TEXT NOT NULL REFERENCES statuses(id),
  visibility     TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','internal','public')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE feature_offers (
  feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  offer_id    TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  PRIMARY KEY (feature_id, offer_id)
);
CREATE INDEX idx_feature_offers_offer ON feature_offers(offer_id);

CREATE TABLE feature_relations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('blocks','related_to','duplicate_of')),
  from_id     TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  UNIQUE (type, from_id, to_id),
  CHECK (from_id <> to_id)
);
CREATE INDEX idx_relations_to ON feature_relations(to_id);

-- ───────────────────────────── Prioritisation ─────────────────────────────
CREATE TABLE department_votes (
  feature_id     TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  voted_by       TEXT REFERENCES users(id),
  voted_at       TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (feature_id, department_id)
);
CREATE INDEX idx_votes_department ON department_votes(department_id);

-- ───────────────────────────── Releases ─────────────────────────────
CREATE TABLE releases (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version_label TEXT,
  description   TEXT NOT NULL DEFAULT '',
  status_id     TEXT NOT NULL REFERENCES statuses(id),
  planned_date  TEXT,
  actual_date   TEXT,
  approved_at   TEXT,
  approved_by   TEXT REFERENCES users(id),
  visibility    TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('draft','internal','public')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id),
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE release_features (
  release_id  TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  feature_id  TEXT NOT NULL UNIQUE REFERENCES features(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL,
  added_by    TEXT REFERENCES users(id),
  PRIMARY KEY (release_id, feature_id)
);

-- ───────────────────────────── Collaboration & history ─────────────────────────────
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id),
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  moved_from  TEXT               -- original feature id when moved by a duplicate merge
);
CREATE INDEX idx_comments_feature ON comments(feature_id);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor_id     TEXT,
  actor_name   TEXT,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  changes      TEXT,             -- JSON [{field, old, new}]
  reason       TEXT,
  is_override  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_at ON audit_log(at);

-- ───────────────────────────── Import (Google Sheets / CSV) ─────────────────────────────
CREATE TABLE sheet_sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('google','csv')),
  spreadsheet_id  TEXT,
  config          TEXT NOT NULL,     -- JSON: sheet names + column mapping
  csv_data        TEXT,              -- JSON {sheet: csvText} for kind = 'csv'
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT NOT NULL,
  last_checked_at TEXT,
  last_check_ok   INTEGER,
  last_check_msg  TEXT,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE import_runs (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('preview','applied','failed','stale','discarded')),
  source_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id),
  applied_at   TEXT,
  applied_by   TEXT REFERENCES users(id),
  counts       TEXT,                 -- JSON
  error        TEXT
);
CREATE INDEX idx_import_runs_source ON import_runs(source_id, created_at);

CREATE TABLE import_items (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  sheet         TEXT NOT NULL,
  row_number    INTEGER NOT NULL,
  entity_type   TEXT NOT NULL,
  external_id   TEXT,
  action        TEXT NOT NULL CHECK (action IN ('create','update','unchanged','duplicate','error')),
  target_id     TEXT,
  target_version INTEGER,
  candidates    TEXT,                -- JSON [{id,label,score,reason}]
  payload       TEXT,                -- JSON normalised row
  diff          TEXT,                -- JSON [{field, local, source, last, kind}]
  errors        TEXT,                -- JSON [string]
  warnings      TEXT,                -- JSON [string]
  resolution    TEXT,                -- JSON {mode:'create'|'link'|'skip', target_id?, fields:{field:'source'|'local'}, protected:{field:true}}
  UNIQUE (run_id, seq)
);

CREATE TABLE import_apply_locks (
  run_id      TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

CREATE TABLE source_entity_links (
  source_id     TEXT NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  last_values   TEXT,               -- JSON of last imported values (3-way conflict detection)
  first_run_id  TEXT,
  last_run_id   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source_id, entity_type, external_id)
);
CREATE INDEX idx_source_links_entity ON source_entity_links(entity_type, entity_id);

-- ───────────────────────────── Planning ─────────────────────────────
CREATE TABLE plan_runs (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id),
  params       TEXT NOT NULL,       -- JSON
  input_hash   TEXT NOT NULL,
  result       TEXT NOT NULL,       -- JSON
  status       TEXT NOT NULL CHECK (status IN ('proposed','approved','discarded')),
  approved_at  TEXT,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE plan_alerts (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  resolved_at  TEXT,
  resolved_by  TEXT REFERENCES users(id)
);

-- Helper used to abort a D1 batch (= transaction) when a precondition fails.
-- INSERT INTO _guard(v) SELECT 1 WHERE <precondition violated>  → CHECK fails → whole batch rolls back.
CREATE TABLE _guard (
  v     INTEGER NOT NULL CHECK (v = 0),
  tag   TEXT
);

-- ───────────────────────────── Reference data ─────────────────────────────
INSERT INTO roles (code, name, rank) VALUES
  ('department_lead', 'Руководитель / представитель отдела', 1),
  ('product',         'Продуктовая команда', 2),
  ('admin',           'Администратор', 3);

INSERT INTO statuses (id, entity, code, name, semantic, color, sort_order) VALUES
  ('st_f_new',        'feature', 'new',         'Новая',                 'new',         '#8a94a6', 10),
  ('st_f_analysis',   'feature', 'analysis',    'На проработке',         'analysis',    '#6b7fd7', 20),
  ('st_f_ready',      'feature', 'ready',       'Готова к планированию', 'ready',       '#2f9e8f', 30),
  ('st_f_planned',    'feature', 'planned',     'Запланирована',         'planned',     '#3b82c4', 40),
  ('st_f_progress',   'feature', 'in_progress', 'В работе',              'in_progress', '#d08a1e', 50),
  ('st_f_blocked',    'feature', 'blocked',     'Заблокирована',         'blocked',     '#c4473b', 60),
  ('st_f_postponed',  'feature', 'postponed',   'Отложена',              'postponed',   '#9b8b6e', 70),
  ('st_f_done',       'feature', 'done',        'Завершена',             'done',        '#3f8f4f', 80),
  ('st_f_cancelled',  'feature', 'cancelled',   'Отменена',              'cancelled',   '#7d7d7d', 90),
  ('st_e_new',        'epic',    'new',         'Идея',                  'new',         '#8a94a6', 10),
  ('st_e_active',     'epic',    'active',      'В работе',              'in_progress', '#d08a1e', 20),
  ('st_e_paused',     'epic',    'paused',      'Приостановлен',         'postponed',   '#9b8b6e', 30),
  ('st_e_done',       'epic',    'done',        'Завершён',              'done',        '#3f8f4f', 40),
  ('st_e_cancelled',  'epic',    'cancelled',   'Отменён',               'cancelled',   '#7d7d7d', 50),
  ('st_o_active',     'offer',   'active',      'Активен',               'active',      '#3f8f4f', 10),
  ('st_o_launch',     'offer',   'launch',      'Подготовка к запуску',  'new',         '#6b7fd7', 20),
  ('st_o_paused',     'offer',   'paused',      'Приостановлен',         'postponed',   '#9b8b6e', 30),
  ('st_o_archived',   'offer',   'archived',    'В архиве',              'cancelled',   '#7d7d7d', 40),
  ('st_r_planned',    'release', 'planned',     'Планируется',           'planned',     '#3b82c4', 10),
  ('st_r_progress',   'release', 'in_progress', 'В разработке',          'in_progress', '#d08a1e', 20),
  ('st_r_released',   'release', 'released',    'Выпущен',               'done',        '#3f8f4f', 30),
  ('st_r_cancelled',  'release', 'cancelled',   'Отменён',               'cancelled',   '#7d7d7d', 40);

INSERT INTO stages (id, code, name, sort_order) VALUES
  ('stg_product',  'product',  'Product',  10),
  ('stg_design',   'design',   'Design',   20),
  ('stg_backend',  'backend',  'Backend',  30),
  ('stg_frontend', 'frontend', 'Frontend', 40),
  ('stg_qa',       'qa',       'QA',       50),
  ('stg_release',  'release',  'Релиз',    60);

INSERT INTO app_settings (key, value) VALUES
  ('public_show_estimates', '0'),
  ('public_show_capacity', '0'),
  ('planning_horizon', '3');

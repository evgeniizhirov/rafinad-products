-- Inbox is deliberately separate from features and sheet imports.
CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  adapter TEXT NOT NULL DEFAULT 'canonical_v1' CHECK(adapter IN ('canonical_v1','bitrix_email')),
  allowed_sender TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  ordering TEXT NOT NULL DEFAULT 'none' CHECK(ordering IN ('none','version','time')),
  last_poll_at TEXT,
  last_ingest_at TEXT,
  last_processed_at TEXT,
  heartbeat TEXT,
  window_start TEXT,
  window_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  external_task_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  field_clocks TEXT NOT NULL DEFAULT '{}',
  overrides TEXT NOT NULL DEFAULT '{}',
  review_state TEXT NOT NULL DEFAULT 'new' CHECK(review_state IN ('new','needs_info','accepted','rejected')),
  feature_id TEXT REFERENCES features(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source, source_instance_id, external_task_id)
);
CREATE INDEX idx_inbox_review ON inbox_items(review_state, updated_at);
CREATE INDEX idx_inbox_feature ON inbox_items(feature_id);
CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id),
  item_id TEXT REFERENCES inbox_items(id),
  source TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_event_id TEXT,
  external_task_id TEXT,
  event_type TEXT,
  content_hash TEXT NOT NULL,
  raw_payload TEXT,
  normalized_payload TEXT,
  conflicts TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','applied','retry_wait','manual_error','paused')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  error_code TEXT,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source, source_instance_id, source_event_id)
);
CREATE INDEX idx_inbox_events_due ON inbox_events(state, next_attempt_at);
CREATE INDEX idx_inbox_events_item ON inbox_events(item_id, received_at);
CREATE INDEX idx_inbox_events_lease ON inbox_events(state, lease_until);
CREATE TABLE inbox_deliveries (
  connection_id TEXT NOT NULL REFERENCES integration_connections(id),
  delivery_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES inbox_events(id),
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(connection_id, delivery_id)
);
CREATE TABLE inbox_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT REFERENCES inbox_items(id),
  event_id TEXT REFERENCES inbox_events(id),
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_inbox_audit_item ON inbox_audit(item_id, id);
CREATE TABLE inbox_operations (
  operation_key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

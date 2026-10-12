// "Approved plan needs review" signals (TZ §15.5). Approved releases / locked placements are never
// changed automatically — we only record that something they depend on has changed.

import type { D1Database } from '../env';
import { newId, nowIso, stmt } from './db';

/** Inserts an alert only when `existsSql` finds at least one approved item that is affected. */
export function planAlertIfStmt(
  db: D1Database,
  kind: string,
  message: string,
  entityType: string | null,
  entityId: string | null,
  existsSql: string,
  ...values: unknown[]
) {
  return stmt(
    db,
    `INSERT INTO plan_alerts (id, created_at, kind, message, entity_type, entity_id)
     SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${existsSql})`,
    newId('pa'), nowIso(), kind, message, entityType, entityId, ...values,
  );
}

export const LOCKED_IN_PERIOD_SQL = `SELECT 1 FROM features f
  LEFT JOIN release_features rf ON rf.feature_id = f.id
  LEFT JOIN releases r ON r.id = rf.release_id
  WHERE f.merged_into_id IS NULL AND f.period_id = ? AND (f.placement_locked = 1 OR r.approved_at IS NOT NULL)`;

export const ANY_LOCKED_SQL = `SELECT 1 FROM features f
  LEFT JOIN release_features rf ON rf.feature_id = f.id
  LEFT JOIN releases r ON r.id = rf.release_id
  WHERE f.merged_into_id IS NULL AND f.period_id IS NOT NULL AND (f.placement_locked = 1 OR r.approved_at IS NOT NULL)`;

export const FEATURE_LOCKED_SQL = `SELECT 1 FROM features f
  LEFT JOIN release_features rf ON rf.feature_id = f.id
  LEFT JOIN releases r ON r.id = rf.release_id
  WHERE f.id = ? AND (f.placement_locked = 1 OR r.approved_at IS NOT NULL)`;

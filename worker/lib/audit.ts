import type { D1Database } from '../env';
import type { SessionUser } from './auth';
import { nowIso, stmt, type Row } from './db';

export interface Change {
  field: string;
  old: unknown;
  new: unknown;
}

export function auditStmt(
  db: D1Database,
  actor: Pick<SessionUser, 'id' | 'name'> | null,
  entityType: string,
  entityId: string,
  action: string,
  changes?: Change[] | null,
  reason?: string | null,
  isOverride = false,
) {
  return stmt(
    db,
    `INSERT INTO audit_log (at, actor_id, actor_name, entity_type, entity_id, action, changes, reason, is_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIso(),
    actor?.id ?? null,
    actor?.name ?? 'Система',
    entityType,
    entityId,
    action,
    changes && changes.length ? JSON.stringify(changes) : null,
    reason ?? null,
    isOverride ? 1 : 0,
  );
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Lists changed fields between the current row and a patch (only keys present in the patch). */
export function diffFields(before: Row, patch: Record<string, unknown>): Change[] {
  const out: Change[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!same(before[k], v)) out.push({ field: k, old: before[k] ?? null, new: v ?? null });
  }
  return out;
}

import type { Env } from '../env';
import { prepareExternalRf } from './external-rf';
import { normalizeIncoming } from '../domain/bitrix-email';
import { eventSchema, mergeSource, type Clock, type Fields } from '../domain/inbox';
import { abortIf, all, first, guardVersion, newId, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';

export const MAX_INBOX_ATTEMPTS = 8;
export const LEASE_MS = 120_000;

/** Bounded durable queue. Token guards fence out expired workers, including their error paths. */
export async function processInbox(env: Env, limit = 25) {
  if (env.INBOX_INGEST_ENABLED !== '1') return { processed: 0 };
  const db = env.DB; const now = nowIso();
  const due = await all(db, `SELECT e.id FROM inbox_events e JOIN integration_connections c ON c.id=e.connection_id
    WHERE c.enabled=1 AND ((e.state IN ('pending','retry_wait') AND e.next_attempt_at<=?) OR (e.state='processing' AND e.lease_until<=?))
    ORDER BY e.received_at,e.id LIMIT ?`, now, now, Math.max(1, Math.min(limit, 100)));
  let processed = 0;
  for (const candidate of due) {
    const token = newId('lease'); const at = nowIso();
    const e = await first(db, `UPDATE inbox_events SET state='processing', attempts=attempts+1, lease_token=?, lease_until=?, version=version+1
      WHERE id=? AND ((state IN ('pending','retry_wait') AND next_attempt_at<=?) OR (state='processing' AND lease_until<=?))
      RETURNING *`, token, new Date(Date.now()+LEASE_MS).toISOString(), candidate.id, at, at);
    if (!e) continue;
    try {
      const connection = await first(db, 'SELECT * FROM integration_connections WHERE id=?', e.connection_id);
      if (!connection?.enabled) {
        await stmt(db, "UPDATE inbox_events SET state='pending', lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?", e.id, token).run();
        continue;
      }
      let normalized;
      try { normalized = normalizeIncoming(parseJson(e.raw_payload,null), connection as any); } catch { /* durable quarantine */ }
      const parsed = eventSchema.safeParse(normalized);
      const fence = () => abortIf(db, 'inbox_lease', `NOT EXISTS(SELECT 1 FROM inbox_events WHERE id=? AND state='processing' AND lease_token=? AND lease_until>?)`, e.id, token, nowIso());
      if (e.attempts > MAX_INBOX_ATTEMPTS) {
        await tx(db, [fence(), stmt(db, "UPDATE inbox_events SET state='manual_error',error_code='attempts_exhausted',lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=?", e.id)]);
        continue;
      }
      if (!parsed.success) {
        await tx(db, [fence(), stmt(db, `UPDATE inbox_events SET state='manual_error', error_code='invalid_event', lease_token=NULL, lease_until=NULL, version=version+1 WHERE id=?`, e.id)]);
        continue;
      }
      const event = parsed.data;
      const current = await first(db, 'SELECT * FROM inbox_items WHERE source=? AND source_instance_id=? AND external_task_id=?', e.source, e.source_instance_id, event.external_task_id);
      const id = current?.id ?? newId('inb');
      const merged = mergeSource(parseJson<Fields>(current?.snapshot, {}), parseJson<Record<string, Clock>>(current?.field_clocks, {}), event, connection.ordering);
      const hasConflicts = Object.keys(merged.conflicts).length > 0;
      const statements = [fence(), abortIf(db, 'connection_changed', 'NOT EXISTS(SELECT 1 FROM integration_connections WHERE id=? AND enabled=1 AND version=?)', connection.id, connection.version)];
      if (current) {
        statements.push(guardVersion(db, 'inbox_items', id, current.version), stmt(db, `UPDATE inbox_items SET snapshot=?,field_clocks=?,title=?,updated_at=?,version=version+1 WHERE id=?`,
          JSON.stringify(merged.snapshot), JSON.stringify(merged.clocks), String(merged.snapshot.title ?? ''), at, id));
      } else {
        statements.push(stmt(db, `INSERT INTO inbox_items(id,source,source_instance_id,external_task_id,title,snapshot,field_clocks,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          id,e.source,e.source_instance_id,event.external_task_id,String(merged.snapshot.title ?? ''),JSON.stringify(merged.snapshot),JSON.stringify(merged.clocks),at,at));
      }
      const rf=await prepareExternalRf(env,current??{id,source:e.source,review_state:'new'},merged.snapshot,e.id);
      statements.push(...rf.statements);
      statements.push(
        stmt(db, `UPDATE inbox_events SET item_id=?,normalized_payload=?,conflicts=?,state=?,error_code=?,lease_token=NULL,lease_until=NULL,applied_at=?,version=version+1 WHERE id=?`,
          id,JSON.stringify(event),JSON.stringify(merged.conflicts),hasConflicts||rf.error?'manual_error':'applied',hasConflicts?'field_conflict':rf.error,at,e.id),
        stmt(db, 'UPDATE integration_connections SET last_processed_at=? WHERE id=?', at, e.connection_id),
        stmt(db, 'INSERT INTO inbox_audit(item_id,event_id,action,details,at) VALUES(?,?,?,?,?)',id,e.id,hasConflicts?'source_conflict':'source_applied',JSON.stringify({ fields: Object.keys(event.payload), conflicts: Object.keys(merged.conflicts) }),at),
      );
      await tx(db, statements);
      processed++;
    } catch {
      // Never send SQL errors or corporate payloads to global logs.
      const exhausted = e.attempts >= MAX_INBOX_ATTEMPTS;
      await stmt(db, `UPDATE inbox_events SET state=?,error_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,version=version+1
        WHERE id=? AND state='processing' AND lease_token=?`, exhausted?'manual_error':'retry_wait',exhausted?'attempts_exhausted':'processing_retry',
        new Date(Date.now()+Math.min(3_600_000,30_000*2**Math.min(e.attempts-1,7))).toISOString(),e.id,token).run();
    }
  }
  return { processed };
}

export function eventDto(e: Row) {
  return { id:e.id,item_id:e.item_id,connection_id:e.connection_id,external_task_id:e.external_task_id,event_type:e.event_type,state:e.state,
    attempts:e.attempts,error_code:e.error_code,received_at:e.received_at,applied_at:e.applied_at,next_attempt_at:e.next_attempt_at,version:e.version,
    conflicts:parseJson(e.conflicts,{}) };
}

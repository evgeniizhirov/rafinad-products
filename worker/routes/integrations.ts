import { z } from 'zod';
import type { Env } from '../env';
import { normalizeIncoming } from '../domain/bitrix-email';
import { canonical, eventSchema, INBOX_BODY_LIMIT } from '../domain/inbox';
import { sha256Hex } from '../lib/crypto';
import { first, newId, nowIso, parseJson, stmt, tx } from '../lib/db';
import { HttpError, json } from '../lib/http';

const envelope = z.object({ delivery_id:z.string().min(1).max(300),source_event_id:z.string().min(1).max(200).optional(),event:z.unknown() }).strict();
export const isIntegrationEndpoint = (path: string) => path === '/api/integrations/events' || path === '/api/integrations/heartbeat';

async function boundedJson(req: Request) {
  if (!req.headers.get('content-type')?.includes('application/json')) throw new HttpError(415,'content_type','Ожидается JSON');
  const reader=req.body?.getReader(); if (!reader) throw new HttpError(400,'empty_body','Пустое сообщение');
  const chunks:Uint8Array[]=[]; let size=0;
  while (true) {
    const part=await reader.read(); if (part.done) break;
    size+=part.value.byteLength;
    if (size>INBOX_BODY_LIMIT) { await reader.cancel(); throw new HttpError(413,'too_large','Превышен лимит сообщения'); }
    chunks.push(part.value);
  }
  const bytes=new Uint8Array(size); let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new HttpError(400,'invalid_json','Некорректный JSON'); }
}

/** Separate machine authentication: it never creates a user/session or grants a read scope. */
export async function handleIntegration(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method!=='POST') throw new HttpError(405,'method_not_allowed','Метод не поддерживается');
  if (env.INBOX_INGEST_ENABLED!=='1') throw new HttpError(503,'ingest_disabled','Приём событий выключен');
  const id=req.headers.get('x-integration-id') ?? '';
  const keys:unknown=typeof env.INBOX_INGEST_KEYS==='string'
    ? parseJson<unknown>(env.INBOX_INGEST_KEYS, {}) : env.INBOX_INGEST_KEYS;
  const secret=keys && typeof keys==='object' && !Array.isArray(keys) && Object.hasOwn(keys,id)
    ? (keys as Record<string,unknown>)[id] : undefined;
  const token=/^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (typeof secret!=='string' || secret.length<32 || secret.length>256 || !token || token.length>256) throw new HttpError(401,'invalid_integration_key','Нет доступа');
  const a=await sha256Hex(secret), b=await sha256Hex(token); let difference=0;
  for (let i=0;i<a.length;i++) difference|=a.charCodeAt(i)^b.charCodeAt(i);
  if (difference) throw new HttpError(401,'invalid_integration_key','Нет доступа');
  const connection=await first(env.DB,'SELECT * FROM integration_connections WHERE id=? AND enabled=1',id);
  if (!connection) throw new HttpError(403,'connection_disabled','Подключение выключено');
  const now=nowIso(), windowFrom=new Date(Date.now()-60_000).toISOString();
  const rate=await first<{window_count:number}>(env.DB,`UPDATE integration_connections SET
    window_count=CASE WHEN window_start>? THEN window_count+1 ELSE 1 END,
    window_start=CASE WHEN window_start>? THEN window_start ELSE ? END WHERE id=? RETURNING window_count`,windowFrom,windowFrom,now,id);
  if ((rate?.window_count ?? 0)>120) throw new HttpError(429,'rate_limited','Слишком много запросов');
  const body=await boundedJson(req);
  if (path.endsWith('/heartbeat')) {
    const h=z.object({ found:z.number().int().nonnegative(),sent:z.number().int().nonnegative(),errors:z.number().int().nonnegative(),oldest_pending_at:z.string().datetime({offset:true}).nullable().optional() }).strict().parse(body);
    await stmt(env.DB,'UPDATE integration_connections SET last_poll_at=?,heartbeat=? WHERE id=?',now,JSON.stringify(h),id).run();
    return json({ok:true});
  }
  const input=envelope.parse(body);
  const hash=await sha256Hex(canonical({event:input.event,source_event_id:input.source_event_id ?? null}));
  const existingDelivery=async () => {
    const d=await first(env.DB,'SELECT * FROM inbox_deliveries WHERE connection_id=? AND delivery_id=?',id,input.delivery_id);
    if (!d) return null;
    if (d.content_hash!==hash) throw new HttpError(409,'delivery_conflict','Идентификатор доставки уже использован для другого содержимого');
    return json({accepted:true,event_id:d.event_id,duplicate:true},200);
  };
  const old=await existingDelivery(); if (old) return old;
  let normalized;
  try { normalized=normalizeIncoming(input.event,connection as any); } catch { /* preserve original in quarantine */ }
  const parsed=eventSchema.safeParse(normalized);
  for (let attempt=0;attempt<3;attempt++) {
    const existingEvent=input.source_event_id ? await first(env.DB,'SELECT id,content_hash FROM inbox_events WHERE source=? AND source_instance_id=? AND source_event_id=?',connection.source,connection.source_instance_id,input.source_event_id) : null;
    if (existingEvent && existingEvent.content_hash!==hash) throw new HttpError(409,'source_event_conflict','Идентификатор события имеет другое содержимое');
    const eventId=existingEvent?.id ?? newId('evt');
    const statements=[];
    if (!existingEvent) statements.push(stmt(env.DB,`INSERT INTO inbox_events(id,connection_id,source,source_instance_id,source_event_id,external_task_id,event_type,content_hash,raw_payload,state,error_code,next_attempt_at,received_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,eventId,id,connection.source,connection.source_instance_id,input.source_event_id,parsed.success?parsed.data.external_task_id:null,parsed.success?parsed.data.event_type:null,hash,JSON.stringify(input.event ?? null),parsed.success?'pending':'manual_error',parsed.success?null:'invalid_event',now,now));
    statements.push(stmt(env.DB,'INSERT INTO inbox_deliveries(connection_id,delivery_id,event_id,content_hash,received_at) VALUES(?,?,?,?,?)',id,input.delivery_id,eventId,hash,now),stmt(env.DB,'UPDATE integration_connections SET last_ingest_at=? WHERE id=?',now,id));
    try { await tx(env.DB,statements); return json({accepted:true,event_id:eventId,duplicate:!!existingEvent,quarantined:!parsed.success},202); }
    catch(e) {
      if ((e as {code?:string}).code!=='unique_violation') throw new HttpError(503,'ingest_retry','Повторите доставку позже');
      const duplicate=await existingDelivery(); if (duplicate) return duplicate;
    }
  }
  throw new HttpError(503,'ingest_retry','Повторите доставку позже');
}

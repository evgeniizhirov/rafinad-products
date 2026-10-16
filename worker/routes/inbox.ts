import { z } from 'zod';
import { prepareExternalRf } from '../services/external-rf';
import { canonical, eventClock, eventSchema, type Fields } from '../domain/inbox';
import { normalizeTitle, similarity } from '../domain/text';
import { guessKind } from '../domain/links';
import { bitrixTaskKey } from '../domain/external-task';
import { perms, requirePerm } from '../lib/auth';
import { requireInboxAccess } from '../lib/inbox-access';
import { sha256Hex } from '../lib/crypto';
import { abortIf, all, first, guardVersion, newId, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { createSchema, featureFields, prepareFeatureCreate } from '../services/feature-create';
import { eventDto, processInbox } from '../services/inbox-processor';

const version=z.number().int().positive();
const editable=z.object({ title:featureFields.title.optional(),description:featureFields.description,task_kind:featureFields.task_kind,
  initiator:featureFields.initiator,author_name:featureFields.author_name,assignee_name:featureFields.assignee_name,tags:featureFields.tags }).strict();
const decision=z.object({version,mode:z.enum(['create','link']),target_id:z.string().max(100).optional()}).strict();
const confirmDecision=decision.extend({preview_hash:z.string().length(64),operation_key:z.string().min(16).max(100),confirm_incomplete:z.boolean().default(false)});

async function item(ctx: Ctx, id: string) {
  const row=await first(ctx.env.DB,'SELECT * FROM inbox_items WHERE id=?',id);
  if (!row) throw notFound('Входящая не найдена'); return row;
}
function itemDto(row: Row) { return {...row,snapshot:parseJson(row.snapshot,{}),overrides:parseJson(row.overrides,{})}; }
function audit(ctx: Ctx, itemId: string|null, eventId: string|null, action: string, details: unknown) {
  return stmt(ctx.env.DB,'INSERT INTO inbox_audit(item_id,event_id,actor_id,action,details,at) VALUES(?,?,?,?,?,?)',itemId,eventId,ctx.user!.id,action,JSON.stringify(details),nowIso());
}
const linkKey = bitrixTaskKey;
async function candidates(ctx: Ctx, row: Row) {
  const source=parseJson<Fields>(row.snapshot,{}); const overrides=parseJson<Fields>(row.overrides,{});
  const title=String(overrides.title ?? source.title ?? ''); const sourceKey=linkKey(String(source.source_url ?? ''));
  const links=await all(ctx.env.DB,'SELECT feature_id,url FROM feature_links');
  const exact=new Set(links.filter(l=>sourceKey && linkKey(l.url)===sourceKey).map(l=>l.feature_id));
  const rows=await all(ctx.env.DB,'SELECT id,number,title,external_ref,merged_into_id FROM features');
  const byId=new Map(rows.map(f=>[f.id,f]));
  const result=new Map<string,Row>();
  for (const original of rows) {
    const score=title ? similarity(title,original.title) : 0;
    const urlMatch=exact.has(original.id);
    const refMatch=original.external_ref===row.external_task_id;
    if (!urlMatch && !refMatch && score<0.65) continue;
    let f=original; const seen=new Set<string>();
    while (f.merged_into_id && !seen.has(f.id)) { seen.add(f.id); const next=byId.get(f.merged_into_id); if (!next) break; f=next; }
    if (f.merged_into_id) continue;
    const candidate={id:f.id,key:`RF-${f.number}`,title:f.title,exact:urlMatch,score:urlMatch?1:score,reason:urlMatch?'Та же ссылка Bitrix':refMatch?'Совпадает внешний ID (проверьте источник)':normalizeTitle(title)===normalizeTitle(original.title)?'Совпадает название':'Похожее название'};
    const previous=result.get(f.id); if (!previous || candidate.exact || candidate.score>previous.score) result.set(f.id,candidate);
  }
  return [...result.values()].sort((a,b)=>Number(b.exact)-Number(a.exact)||b.score-a.score).slice(0,15);
}
function rfFields(row: Row) {
  const source=parseJson<Fields>(row.snapshot,{}), overrides=parseJson<Fields>(row.overrides,{});
  const data:Record<string,unknown>={title:source.title ?? '',description:source.description ?? '',task_kind:source.task_kind ?? 'planned',author_name:source.author_name ?? '',assignee_name:source.assignee_name ?? null,tags:source.tags ?? [],initiator:source.initiator_name ? {type:'free_text',name:source.initiator_name}:null,...overrides,
    is_product_internal:true,visibility:'draft'};
  // No automatic mapping of Bitrix deadlines, priorities, status, IDs of users or hours.
  if (typeof data.author_name==='string' && /^user_\d+$/.test(data.author_name) && !('author_name' in overrides)) data.author_name='';
  return data;
}
async function preview(ctx: Ctx, row: Row, input: z.infer<typeof decision>) {
  if (row.version!==input.version) throw conflict('stale_preview','Карточка изменилась. Обновите предпросмотр.');
  if (row.review_state==='accepted') throw conflict('already_accepted','Карточка уже принята.');
  const found=await candidates(ctx,row);
  const warnings:string[]=[]; let target:Row|null=null; let fields:Record<string,unknown>|null=null;
  if (input.mode==='link') {
    if (!input.target_id) throw badRequest('Выберите RF-задачу');
    const m=/^(?:RF-)?(\d+)$/i.exec(input.target_id);
    target=m ? await first(ctx.env.DB,'SELECT * FROM features WHERE number=?',Number(m[1])) : await first(ctx.env.DB,'SELECT * FROM features WHERE id=?',input.target_id);
    if (!target || target.merged_into_id) throw badRequest('Выберите существующую основную RF-задачу');
    if (found.some(f=>f.exact && f.id!==target!.id)) throw conflict('duplicate_source','Ссылка уже связана с другой RF-задачей');
  } else {
    if (found.some(f=>f.exact)) throw conflict('duplicate_source','RF с этой ссылкой уже существует. Выберите привязку.');
    fields=rfFields(row);
    const parsed=createSchema.safeParse(fields);
    if (!parsed.success) throw badRequest('Проверьте название и поля RF. Описание должно быть не длиннее 20 000 символов.', parsed.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));
    if (!String(fields.description ?? '').trim()) warnings.push('Описание отсутствует — задача требует уточнения.');
    if (!fields.initiator) warnings.push('Инициатор неизвестен.');
    if (!fields.author_name) warnings.push('Постановщик не сопоставлен. Исходное значение останется во входящей.');
    if (!fields.assignee_name) warnings.push('Исполнитель не указан.');
    if (fields.task_kind==='bug') warnings.push('Проверьте ожидаемое и фактическое поведение, воспроизведение и влияние бага.');
    else if (fields.task_kind==='operational_improvement') warnings.push('Проверьте цель, ожидаемый результат и ответственную сторону.');
    else warnings.push('Проверьте ожидаемый результат и критерии готовности.');
    if (found.length) warnings.push('Есть похожие RF — проверьте кандидатов перед созданием.');
  }
  const source=parseJson<Fields>(row.snapshot,{});
  const result={item_id:row.id,version:row.version,mode:input.mode,target:target?{id:target.id,key:`RF-${target.number}`,title:target.title,version:target.version}:null,
    fields,source_url:source.source_url ?? null,warnings,candidates:found};
  return {...result,preview_hash:await sha256Hex(canonical(result))};
}

export function registerInboxRoutes(r: Router) {
  r.get('/api/inbox', async ctx=>{
    await requireInboxAccess(ctx);
    const q=ctx.url.searchParams; const clauses:string[]=[]; const values:unknown[]=[];
    const duplicateSql=`EXISTS(SELECT 1 FROM features f WHERE f.merged_into_id IS NULL AND (i.feature_id IS NULL OR f.id<>i.feature_id) AND
      ((i.title<>'' AND lower(f.title)=lower(COALESCE(json_extract(i.overrides,'$.title'),i.title))) OR
       EXISTS(SELECT 1 FROM feature_links l WHERE l.feature_id=f.id AND l.url=json_extract(i.snapshot,'$.source_url'))))`;
    if (q.get('q')) {clauses.push('(i.title LIKE ? OR i.external_task_id LIKE ? OR i.overrides LIKE ?)'); const s=`%${q.get('q')!.slice(0,300)}%`; values.push(s,s,s);}
    for (const key of ['review_state','source'] as const) if(q.get(key)){clauses.push(`i.${key}=?`);values.push(q.get(key));}
    if(q.get('kind')){clauses.push("COALESCE(json_extract(i.overrides,'$.task_kind'),json_extract(i.snapshot,'$.task_kind'),'planned')=?");values.push(q.get('kind'));}
    if(q.get('instance')){clauses.push('i.source_instance_id=?');values.push(q.get('instance'));}
    if(q.get('duplicates')==='1')clauses.push(duplicateSql);
    if(q.get('from')){clauses.push('i.created_at>=?');values.push(q.get('from'));}
    if(q.get('to')){clauses.push('i.created_at<?');values.push(q.get('to')+'T23:59:59.999Z');}
    if(q.get('errors')==='1')clauses.push("EXISTS(SELECT 1 FROM inbox_events e WHERE e.item_id=i.id AND e.state='manual_error')");
    const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
    const offset=Math.max(0,Math.min(1_000_000,Number(q.get('offset'))||0));
    const sort=({updated:'i.updated_at DESC',created:'i.created_at DESC',title:"COALESCE(json_extract(i.overrides,'$.title'),i.title) COLLATE NOCASE"} as Record<string,string>)[q.get('sort')??'updated']??'i.updated_at DESC';
    const items=await all(ctx.env.DB,`SELECT i.*,f.number AS feature_number,${duplicateSql} AS duplicate_candidate,
      (SELECT COUNT(*) FROM inbox_events e WHERE e.item_id=i.id AND e.state='manual_error') AS errors,
      (SELECT state FROM inbox_events e WHERE e.item_id=i.id ORDER BY received_at DESC,id DESC LIMIT 1) AS sync_state
      FROM inbox_items i LEFT JOIN features f ON f.id=i.feature_id ${where} ORDER BY ${sort},i.id LIMIT 50 OFFSET ?`,...values,offset);
    const total=await first<{n:number}>(ctx.env.DB,`SELECT COUNT(*) AS n FROM inbox_items i ${where}`,...values);
    const counts=await all(ctx.env.DB,'SELECT review_state,COUNT(*) AS n FROM inbox_items GROUP BY review_state');
    return json({items:items.map(row=>{const dto=itemDto(row); const source=dto.snapshot as Fields; const overrides=dto.overrides as Fields;
      return {id:row.id,source:row.source,source_instance_id:row.source_instance_id,external_task_id:row.external_task_id,title:overrides.title ?? row.title,external_status:source.external_status ?? null,initiator:overrides.initiator ?? source.initiator_name ?? null,assignee_name:overrides.assignee_name ?? source.assignee_name ?? null,task_kind:overrides.task_kind ?? source.task_kind ?? null,review_state:row.review_state,duplicate_candidate:!!row.duplicate_candidate,errors:row.errors,sync_state:row.sync_state,feature_number:row.feature_number,created_at:row.created_at,updated_at:row.updated_at};}),total:total?.n ?? 0,counts});
  });
  r.get('/api/inbox/:id',async ctx=>{
    await requireInboxAccess(ctx); const row=await item(ctx,ctx.params.id);
    const events=await all(ctx.env.DB,'SELECT * FROM inbox_events WHERE item_id=? ORDER BY received_at DESC,id DESC LIMIT 100',row.id);
    return json({item:itemDto(row),candidates:await candidates(ctx,row),events:events.map(eventDto),history:await all(ctx.env.DB,'SELECT a.*,u.name AS actor_name FROM inbox_audit a LEFT JOIN users u ON u.id=a.actor_id WHERE item_id=? ORDER BY a.id DESC LIMIT 100',row.id)});
  });
  r.patch('/api/inbox/:id',async ctx=>{
    await requireInboxAccess(ctx);
    const b=await readJson(ctx,z.object({version,fields:editable.optional(),remove_overrides:z.array(z.enum(Object.keys(editable.shape) as [string,...string[]])).optional(),review_state:z.enum(['new','needs_info','rejected']).optional(),reason:z.string().trim().max(2000).optional()}).strict());
    const row=await item(ctx,ctx.params.id);
    if (row.review_state==='accepted') throw conflict('already_accepted','Редактируйте принятую RF; решение о принятии уже зафиксировано.');
    if(b.review_state==='rejected'&&!b.reason)throw badRequest('Укажите причину отклонения');
    const overrides:Fields={...parseJson<Fields>(row.overrides,{}),...b.fields};
    for(const key of b.remove_overrides??[])delete overrides[key];
    await tx(ctx.env.DB,[guardVersion(ctx.env.DB,'inbox_items',row.id,b.version),stmt(ctx.env.DB,'UPDATE inbox_items SET overrides=?,review_state=?,rejection_reason=?,updated_at=?,version=version+1 WHERE id=?',JSON.stringify(overrides),b.review_state??row.review_state,b.review_state==='rejected'?b.reason:row.rejection_reason,nowIso(),row.id),audit(ctx,row.id,null,'review_updated',b)]);
    return json({ok:true});
  });
  r.post('/api/inbox/:id/preview',async ctx=>{
    await requireInboxAccess(ctx); const b=await readJson(ctx,decision); return json(await preview(ctx,await item(ctx,ctx.params.id),b));
  });
  r.post('/api/inbox/:id/accept',async ctx=>{
    await requireInboxAccess(ctx); const user=requirePerm(ctx,perms.editCatalog); const b=await readJson(ctx,confirmDecision);
    const requestHash=await sha256Hex(canonical({id:ctx.params.id,...b}));
    const existing=await first(ctx.env.DB,'SELECT * FROM inbox_operations WHERE operation_key=?',b.operation_key);
    if(existing){if(existing.request_hash!==requestHash)throw conflict('operation_conflict','Ключ операции уже использован');return json(parseJson(existing.result,{}));}
    for(let attempt=0;attempt<3;attempt++){
      const row=await item(ctx,ctx.params.id); const plan=await preview(ctx,row,b);
      if(plan.preview_hash!==b.preview_hash)throw conflict('stale_preview','Предпросмотр устарел. Проверьте актуальные данные.');
      if(plan.warnings.length&&!b.confirm_incomplete)throw badRequest('Подтвердите предупреждения предпросмотра');
      const db=ctx.env.DB,now=nowIso();
      const prepared=b.mode==='create'?await prepareFeatureCreate(ctx,plan.fields):null;
      const result=prepared?.result ?? {id:plan.target!.id,number:Number(plan.target!.key.slice(3)),key:plan.target!.key};
      const st=[guardVersion(db,'inbox_items',row.id,b.version),abortIf(db,'already_accepted',"EXISTS(SELECT 1 FROM inbox_items WHERE id=? AND review_state='accepted')",row.id)];
      if(prepared)st.push(...prepared.statements);
      else st.push(guardVersion(db,'features',result.id,plan.target!.version),abortIf(db,'merged_target','EXISTS(SELECT 1 FROM features WHERE id=? AND merged_into_id IS NOT NULL)',result.id));
      if(typeof plan.source_url==='string' && plan.source_url){
        st.push(abortIf(db,'duplicate_source','EXISTS(SELECT 1 FROM feature_links WHERE url=? AND feature_id<>?)',plan.source_url,result.id));
        st.push(stmt(db,`INSERT OR IGNORE INTO feature_links(id,feature_id,kind,url,origin,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,'manual',?,?,?,?)`,newId('lnk'),result.id,guessKind(plan.source_url),plan.source_url,now,user.id,now,user.id));
      }
      st.push(stmt(db,"UPDATE inbox_items SET feature_id=?,review_state='accepted',updated_at=?,version=version+1 WHERE id=?",result.id,now,row.id),audit(ctx,row.id,null,b.mode==='create'?'rf_created':'rf_linked',{feature_id:result.id,warnings:plan.warnings}),stmt(db,'INSERT INTO inbox_operations(operation_key,item_id,request_hash,result,created_at) VALUES(?,?,?,?,?)',b.operation_key,row.id,requestHash,JSON.stringify(result),now));
      try {await tx(db,st);return json(result,prepared?201:200);}catch(e){
        const completed=await first(db,'SELECT request_hash,result FROM inbox_operations WHERE operation_key=?',b.operation_key);
        if(completed?.request_hash===requestHash)return json(parseJson(completed.result,{}));
        if((e as {code?:string}).code==='unique_violation'&&attempt<2)continue;throw e;
      }
    }
    throw conflict('retry','Повторите действие');
  });
  r.get('/api/inbox-events',async ctx=>{
    await requireInboxAccess(ctx); const state=ctx.url.searchParams.get('state');
    const rows=await all(ctx.env.DB,`SELECT * FROM inbox_events ${state?'WHERE state=?':''} ORDER BY received_at DESC,id DESC LIMIT 100`,...(state?[state]:[]));
    return json({events:rows.map(eventDto)});
  });
  r.get('/api/inbox-events/:id',async ctx=>{
    await requireInboxAccess(ctx);const e=await first(ctx.env.DB,'SELECT * FROM inbox_events WHERE id=?',ctx.params.id);if(!e)throw notFound();
    return json({event:{...eventDto(e),raw:parseJson(e.raw_payload,null),normalized:parseJson(e.normalized_payload,null)}});
  });
  r.post('/api/inbox-events/:id/retry',async ctx=>{
    await requireInboxAccess(ctx);const b=await readJson(ctx,z.object({version}));
    const e=await first(ctx.env.DB,'SELECT * FROM inbox_events WHERE id=?',ctx.params.id);if(!e)throw notFound();
    if(!['manual_error','retry_wait','paused'].includes(e.state))throw conflict('event_state','Это событие нельзя повторить сейчас');
    await tx(ctx.env.DB,[guardVersion(ctx.env.DB,'inbox_events',e.id,b.version),stmt(ctx.env.DB,"UPDATE inbox_events SET state='pending',attempts=0,error_code=NULL,next_attempt_at=?,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=?",nowIso(),e.id),audit(ctx,e.item_id,e.id,'retry_requested',{})]);return json({ok:true});
  });
  r.post('/api/inbox-events/:id/resolve',async ctx=>{
    await requireInboxAccess(ctx);const b=await readJson(ctx,z.object({version,item_version:version,choices:z.record(z.enum(['current','incoming']))}).strict());
    const e=await first(ctx.env.DB,'SELECT * FROM inbox_events WHERE id=?',ctx.params.id);
    if(!e?.item_id || e.state!=='manual_error' || e.error_code!=='field_conflict')throw badRequest('Нет конфликта полей');
    const row=await item(ctx,e.item_id), conflicts=parseJson<Record<string,{current:unknown;incoming:unknown}>>(e.conflicts,{});
    if(Object.keys(conflicts).some(k=>!b.choices[k])||Object.keys(b.choices).some(k=>!conflicts[k]))throw badRequest('Выберите решение для каждого конфликтующего поля');
    const snapshot=parseJson<Fields>(row.snapshot,{}),clocks=parseJson<Record<string,unknown>>(row.field_clocks,{});
    const connection=await first(ctx.env.DB,'SELECT ordering FROM integration_connections WHERE id=?',e.connection_id);
    const clock=eventClock(eventSchema.parse(parseJson(e.normalized_payload,{})),connection?.ordering ?? 'none');
    for(const [key,choice] of Object.entries(b.choices))if(choice==='incoming'){snapshot[key]=conflicts[key].incoming;if(clock)clocks[key]=clock;else delete clocks[key];}
    const rf=await prepareExternalRf(ctx.env,row,snapshot,e.id);
    await tx(ctx.env.DB,[guardVersion(ctx.env.DB,'inbox_events',e.id,b.version),guardVersion(ctx.env.DB,'inbox_items',row.id,b.item_version),stmt(ctx.env.DB,'UPDATE inbox_items SET snapshot=?,field_clocks=?,title=?,updated_at=?,version=version+1 WHERE id=?',JSON.stringify(snapshot),JSON.stringify(clocks),String(snapshot.title??''),nowIso(),row.id),stmt(ctx.env.DB,"UPDATE inbox_events SET state='applied',error_code=NULL,conflicts='{}',version=version+1 WHERE id=?",e.id),...rf.statements,stmt(ctx.env.DB,'UPDATE inbox_events SET state=?,error_code=? WHERE id=?',rf.error?'manual_error':'applied',rf.error,e.id),audit(ctx,row.id,e.id,'conflict_resolved',b.choices)]);return json({ok:true});
  });
  r.get('/api/inbox-connections',async ctx=>{
    await requireInboxAccess(ctx);const rows=await all(ctx.env.DB,'SELECT * FROM integration_connections ORDER BY name');
    const queue=await all(ctx.env.DB,'SELECT state,COUNT(*) AS n,MIN(received_at) AS oldest FROM inbox_events GROUP BY state');
    return json({ingest_enabled:ctx.env.INBOX_INGEST_ENABLED==='1',connections:rows.map(c=>({...c,heartbeat:parseJson(c.heartbeat,null),heartbeat_stale:!!c.enabled&&(!c.last_poll_at||Date.now()-Date.parse(c.last_poll_at)>20*60_000)})),queue});
  });
  r.post('/api/inbox-connections',async ctx=>{
    await requireInboxAccess(ctx);requirePerm(ctx,perms.admin);
    const b=await readJson(ctx,z.object({id:z.string().regex(/^[a-z0-9_-]{1,64}$/),name:z.string().trim().min(1).max(200),source:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),source_instance_id:z.string().regex(/^[a-z0-9.-]+$/).max(200),adapter:z.enum(['canonical_v1','bitrix_email']),allowed_sender:z.string().email().optional(),enabled:z.boolean().default(false),ordering:z.enum(['none','version','time']).default('none')}).strict());
    if(b.adapter==='bitrix_email'&&(b.source!=='bitrix'||!b.allowed_sender||b.ordering!=='none'))throw badRequest('Для письма нужны отправитель и ordering=none');
    await tx(ctx.env.DB,[stmt(ctx.env.DB,'INSERT INTO integration_connections(id,name,source,source_instance_id,adapter,allowed_sender,enabled,ordering,created_at) VALUES(?,?,?,?,?,?,?,?,?)',b.id,b.name,b.source,b.source_instance_id,b.adapter,b.allowed_sender,b.enabled,b.ordering,nowIso()),audit(ctx,null,null,'connection_created',{id:b.id})]);return json({ok:true},201);
  });
  r.patch('/api/inbox-connections/:id',async ctx=>{
    await requireInboxAccess(ctx);requirePerm(ctx,perms.admin);const b=await readJson(ctx,z.object({version,enabled:z.boolean()}).strict());
    await tx(ctx.env.DB,[guardVersion(ctx.env.DB,'integration_connections',ctx.params.id,b.version),stmt(ctx.env.DB,'UPDATE integration_connections SET enabled=?,version=version+1 WHERE id=?',b.enabled,ctx.params.id),audit(ctx,null,null,'connection_toggled',{id:ctx.params.id,enabled:b.enabled})]);return json({ok:true});
  });
  r.post('/api/inbox-process',async ctx=>{await requireInboxAccess(ctx);return json(await processInbox(ctx.env));});
}


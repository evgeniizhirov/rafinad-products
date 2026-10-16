import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeIncoming } from '../worker/domain/bitrix-email';
import { eventSchema, mergeSource } from '../worker/domain/inbox';
import { processInbox } from '../worker/services/inbox-processor';
import { setup, type TestApp } from './helpers';
import worker from '../worker/index';

const secret='test-integration-secret-with-at-least-32-characters';
const headers={authorization:`Bearer ${secret}`,'x-integration-id':'mail'};
const mail={subject:'RAFINAD_SYNC | BITRIX | CREATE | 402775',from:'Kokoc Portal <robot@my.kokocgroup.ru>',text:`КОКОС GROUP
ID задачи Bitrix: 402775
Ссылка на задачу: https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/402775/
Название: Тестовая
Дата создания: 14.10.2026 11:43:07
Описание: Проверка отправки триггера в статусе бэклог
Тип задачи: Rafinad
Приоритет Bitrix: N
Связанные задачи:
Постановщик: user_4158
Крайний срок: 22.10.2026 10:00:00
КОКОС GROUP`};
const connection={adapter:'bitrix_email',allowed_sender:'robot@my.kokocgroup.ru',source_instance_id:'my.kokocgroup.ru'};
const event=(payload:Record<string,unknown>={title:'Unique inbox request',description:'Complete original'},extra:Record<string,unknown>={})=>({schema_version:1,external_task_id:'task-001',event_type:'CREATE',payload_mode:'patch',payload,...extra});
async function harness(adapter='canonical_v1',ordering='version'){
  const app=await setup(); const admin=await app.user('inbox-admin@test.io','admin');
  app.env.INBOX_INGEST_ENABLED='1';app.env.INBOX_INGEST_KEYS=JSON.stringify({mail:secret});
  const result=await app.call('POST','/api/inbox-connections',{id:'mail',name:'Test mail',source:'bitrix',source_instance_id:'my.kokocgroup.ru',adapter,allowed_sender:connection.allowed_sender,ordering:adapter==='bitrix_email'?'none':ordering,enabled:true},admin);
  assert.equal(result.status,201,JSON.stringify(result.body));return {app,admin};
}
async function deliver(app:TestApp,e:unknown,id='delivery-1',sourceId?:string){
  const r=await app.call('POST','/api/integrations/events',{delivery_id:id,event:e,...(sourceId?{source_event_id:sourceId}:{})},undefined,headers);
  assert.ok([200,202].includes(r.status),JSON.stringify(r.body));return r.body;
}
test('Dashboard JSON binding and string secret both authenticate; malformed maps fail closed',async()=>{
  const {app}=await harness();
  for(const keys of [{mail:secret},JSON.stringify({mail:secret})]){
    app.env.INBOX_INGEST_KEYS=keys;
    assert.equal((await app.call('POST','/api/integrations/heartbeat',{found:0,sent:0,errors:0},undefined,headers)).status,200);
  }
  for(const keys of ['null','[]','false','invalid',{mail:123},{mail:{}},{mail:'short'},{mail:'x'.repeat(257)},Object.create({mail:secret})]){
    app.env.INBOX_INGEST_KEYS=keys;
    assert.equal((await app.call('POST','/api/integrations/heartbeat',{found:0,sent:0,errors:0},undefined,headers)).status,401);
  }
  app.env.INBOX_INGEST_KEYS={mail:secret};
  const e=await deliver(app,event());await worker.scheduled({},app.env);
  assert.equal(app.one('SELECT state FROM inbox_events WHERE id=?',e.event_id).state,'applied');
  assert.ok(app.one('SELECT feature_id FROM inbox_items').feature_id);
});
test('Gmail duplicate URL persists a single clean RF link and redelivery remains idempotent',async()=>{
  const {app}=await harness('bitrix_email','none');
  const url='https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/402775/';
  const raw={...mail,text:mail.text.replace(url,url+':\r\n'+url)};
  const e=await deliver(app,raw);await worker.scheduled({},app.env);
  const item=app.one('SELECT * FROM inbox_items');
  assert.equal(JSON.parse(item.snapshot).source_url,url);
  assert.equal(app.one('SELECT url FROM feature_links WHERE feature_id=?',item.feature_id).url,url);
  const stored=app.one('SELECT * FROM inbox_events WHERE id=?',e.event_id);
  assert.equal(JSON.parse(stored.raw_payload).text,raw.text);
  assert.equal(JSON.parse(stored.normalized_payload).payload.source_url,url);
  assert.equal((await deliver(app,raw)).duplicate,true);await worker.scheduled({},app.env);
  assert.equal(app.one('SELECT COUNT(*) n FROM external_rf_owners').n,1);
  assert.equal(app.one('SELECT COUNT(*) n FROM feature_links WHERE feature_id=?',item.feature_id).n,1);
});
for (const status of ['BLOCKED','POSTPONED','DONE','REOPENED']) test(`mail ${status}: scheduled handler creates one RF and keeps external and RF statuses separate`, async()=>{
  const {app}=await harness('bitrix_email','none');
  const created=await deliver(app,mail);
  assert.equal(app.one('SELECT state FROM inbox_events WHERE id=?',created.event_id).state,'pending');
  app.env.INBOX_INGEST_ENABLED='0';await worker.scheduled({},app.env);
  assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,0);
  app.env.INBOX_INGEST_ENABLED='1';await worker.scheduled({},app.env);
  const item=app.one('SELECT * FROM inbox_items'),rf=app.one('SELECT * FROM features WHERE id=?',item.feature_id);
  assert.equal(item.review_state,'accepted');assert.equal(rf.is_product_internal,1);
  assert.equal(app.one('SELECT state FROM inbox_events WHERE id=?',created.event_id).state,'applied');
  assert.equal((await deliver(app,mail)).duplicate,true);
  const update=await deliver(app,{...mail,subject:mail.subject.replace('CREATE',status)},'status-'+status);
  await worker.scheduled({},app.env);
  assert.equal(app.one('SELECT state FROM inbox_events WHERE id=?',update.event_id).state,'applied');
  assert.equal(JSON.parse(app.one('SELECT snapshot FROM inbox_items').snapshot).external_status,status);
  assert.equal(app.one('SELECT status_id FROM features WHERE id=?',rf.id).status_id,rf.status_id);
  assert.equal(app.one('SELECT COUNT(*) n FROM external_rf_owners').n,1);
  assert.ok(app.one('SELECT last_processed_at FROM integration_connections').last_processed_at);
  const changed=await deliver(app,{...mail,subject:mail.subject.replace('CREATE','UPDATE'),text:mail.text.replace('Название: Тестовая','Название: Изменённая')},'changed');
  await worker.scheduled({},app.env);
  assert.equal(app.one('SELECT error_code FROM inbox_events WHERE id=?',changed.event_id).error_code,'field_conflict');
  assert.equal(app.one('SELECT title FROM features WHERE id=?',rf.id).title,rf.title);
});
// Legacy/manual exception fixture: existing undecided Inbox rows must retain the preview workflow.
async function seeded(){
  const h=await harness();await deliver(h.app,event(undefined,{source_event_version:1}));await processInbox(h.app.env);
  const created=h.app.one('SELECT feature_id FROM inbox_items').feature_id;
  h.app.db.raw.prepare('DELETE FROM features WHERE id=?').run(created);
  h.app.db.raw.exec("UPDATE inbox_items SET review_state='new',auto_managed=0,rf_sync='{}',classified_type=NULL");
  return {...h,item:()=>h.app.one('SELECT * FROM inbox_items')};
}
async function acceptBody(app:TestApp,admin:string,item:any,mode='create',target_id?:string){
  const body={version:item.version,mode,...(target_id?{target_id}:{})};
  const p=await app.call('POST',`/api/inbox/${item.id}/preview`,body,admin);assert.equal(p.status,200,JSON.stringify(p.body));
  return {...body,preview_hash:p.body.preview_hash,operation_key:crypto.randomUUID(),confirm_incomplete:true};
}

describe('Bitrix mail adapter and source ordering',()=>{
  test('Gmail repeated anchor URL becomes one link; differing targets are rejected',()=>{
    const url='https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/402775/';
    const duplicated={...mail,text:mail.text.replace(url,url+':\r\n'+url+'\r\n')};
    assert.equal(normalizeIncoming(duplicated,connection).payload.source_url,url);
    assert.equal(normalizeIncoming({...mail,text:mail.text.replace(url,url+':'+url)},connection).payload.source_url,url);
    for(const other of [url.replace('402775','402776'),url.replace('my.kokocgroup.ru','evil.example'),url.replace('/2669/','/9999/'),'https://evil.example/']){
      for(const pair of [url+':\n'+other,other+':\n'+url])assert.throws(()=>normalizeIncoming({...mail,text:mail.text.replace(url,pair)},connection));
    }
  });
  test('screen example preserves raw participants/type/priority/dates; never guesses source order',()=>{
    const e=normalizeIncoming(mail,connection);
    assert.equal(e.external_task_id,'402775');assert.equal(e.payload.title,'Тестовая');assert.equal(e.payload.description,'Проверка отправки триггера в статусе бэклог');
    assert.equal(e.payload.source_task_type,'Rafinad');assert.equal(e.payload.priority,'N');assert.equal(e.payload.author_name,'user_4158');
    assert.equal(e.payload.source_due_at,'22.10.2026 10:00:00');assert.equal(e.source_event_at,undefined);assert.equal(e.payload.task_kind,undefined);
  });
  test('multiline text, Cyrillic, HTML and URL wrapping survive as inert text',()=>{
    const text=mail.text.replace('Проверка отправки триггера в статусе бэклог','Строка 1\nСтрока 2: <script>alert(1)</script>\nhttps://example.com/a?x=1&y=2').replace('/tasks/task/','/\ntasks/task/');
    const e=normalizeIncoming({...mail,text},connection);assert.match(e.payload.description!,/Строка 2: <script>/);assert.ok(e.payload.source_url!.endsWith('/402775/'));
  });
  test('mismatched IDs, other sender/portal, repeated labels and oversize description are rejected',()=>{
    for(const bad of [{...mail,subject:mail.subject.replace('402775','402776')},{...mail,from:'attacker@example.com'},{...mail,text:mail.text.replaceAll('https://my.kokocgroup.ru','https://evil.example')},{...mail,text:mail.text.replace('Описание:','Название: injected\nОписание:')},{...mail,text:mail.text.replace('Проверка отправки триггера в статусе бэклог','я'.repeat(100001))}])assert.throws(()=>normalizeIncoming(bad,connection));
  });
  test('missing patch fields remain, explicit clears differ from empty strings, old events do not roll back',()=>{
    const first=mergeSource({}, {},eventSchema.parse(event({title:'new',description:'long'},{source_event_version:10})),'version');
    const second=mergeSource(first.snapshot,first.clocks,eventSchema.parse(event({title:'old',priority:'N'},{source_event_version:2})),'version');
    assert.equal(second.snapshot.title,'new');assert.equal(second.snapshot.description,'long');assert.equal(second.snapshot.priority,'N');
    const clear=mergeSource(second.snapshot,second.clocks,eventSchema.parse(event({}, {source_event_version:11,clear_fields:['description']})),'version');
    assert.equal(clear.snapshot.description,null);
  });
  test('equal time/version and missing order conflict per field without suppressing independent fields',()=>{
    const state=mergeSource({}, {},eventSchema.parse(event({title:'a'},{source_event_version:1})),'version');
    for(const extra of [{source_event_version:1},{}]){
      const r=mergeSource(state.snapshot,state.clocks,eventSchema.parse(event({title:'b',priority:'N'},extra)),'version');assert.equal(r.snapshot.title,'a');assert.ok(r.conflicts.title);assert.equal(r.snapshot.priority,'N');
    }
    const t='2026-10-15T10:00:00Z';const initial=mergeSource({}, {},eventSchema.parse(event({title:'a'},{source_event_at:t})),'time');
    assert.ok(mergeSource(initial.snapshot,initial.clocks,eventSchema.parse(event({title:'b'},{source_event_at:t})),'time').conflicts.title);
  });
});

describe('Inbox durable transport and privacy',()=>{
  test('same delivery, replay after body cleanup and same source event with different delivery apply once',async()=>{
    const {app}=await harness();const e=event();const one=await deliver(app,e,'a','source-1');
    assert.equal((await deliver(app,e,'a','source-1')).event_id,one.event_id);
    assert.equal((await deliver(app,e,'b','source-1')).event_id,one.event_id);
    await processInbox(app.env);assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,1);assert.equal(app.one('SELECT COUNT(*) n FROM inbox_events').n,1);
    app.db.raw.exec('UPDATE inbox_events SET raw_payload=NULL');
    assert.equal((await deliver(app,e,'a','source-1')).event_id,one.event_id);assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,1);
  });
  test('reusing a delivery or logical event ID for different content is a conflict',async()=>{
    const {app}=await harness();await deliver(app,event(),'a','s1');
    for(const delivery_id of ['a','b'])assert.equal((await app.call('POST','/api/integrations/events',{delivery_id,source_event_id:'s1',event:event({title:'different'})},undefined,headers)).status,409);
  });
  test('unknown schema, missing ID and too-long content are durable errors, no partial Inbox card',async()=>{
    const {app}=await harness();
    for(const [n,e] of [event(undefined,{external_task_id:''}),event(undefined,{schema_version:99}),event({description:'x'.repeat(100001)})].entries())assert.equal((await deliver(app,e,`bad-${n}`)).quarantined,true);
    await processInbox(app.env);assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,0);assert.equal(app.one("SELECT COUNT(*) n FROM inbox_events WHERE state='manual_error'").n,3);
    const oversized=await app.call('POST','/api/integrations/events',{delivery_id:'huge',event:event({description:'я'.repeat(250001)})},undefined,headers);assert.equal(oversized.status,413);
  });
  test('mail sample is parsed on backend; retry preserves original and source data is separate',async()=>{
    const {app,admin}=await harness('bitrix_email');const receipt=await deliver(app,mail);await processInbox(app.env);
    const row=app.one('SELECT * FROM inbox_items');assert.equal(row.title,'Тестовая');
    const detail=await app.call('GET',`/api/inbox-events/${receipt.event_id}`,undefined,admin);assert.deepEqual(detail.body.event.raw,mail);
    assert.equal(app.one('SELECT COUNT(*) n FROM features WHERE title=?','Тестовая').n,1);
    assert.equal(app.one('SELECT is_product_internal FROM features WHERE id=?',row.feature_id).is_product_internal,1);
  });
  test('ACL: admin without membership allowed; Product membership rechecked; keys cannot read Inbox',async()=>{
    const {app,admin,item}=await seeded();const product=await app.user('pm@test.io','product',['dep_product']);const outsider=await app.user('pm-out@test.io','product');const lead=await app.user('lead-inbox@test.io','department_lead');
    for(const cookie of [admin,product])assert.equal((await app.call('GET','/api/inbox',undefined,cookie)).status,200);
    for(const cookie of [outsider,lead])for(const path of ['/api/inbox',`/api/inbox/${item().id}`,'/api/inbox-events','/api/inbox-connections'])assert.equal((await app.call('GET',path,undefined,cookie)).status,404);
    assert.equal((await app.call('GET','/api/inbox')).status,401);
    const key=await app.call('POST','/api/me/api-keys',{name:'inbox key',scopes:['tasks:read','tasks:create','tasks:update'],expires_in_days:1},admin);assert.equal(key.status,201);
    assert.equal((await app.call('GET','/api/inbox',undefined,undefined,{authorization:`Bearer ${key.body.token}`})).status,403);
    app.db.raw.exec("DELETE FROM department_memberships WHERE user_id=(SELECT id FROM users WHERE email='pm@test.io')");assert.equal((await app.call('GET','/api/inbox',undefined,product)).status,404);
    assert.equal((await app.call('GET','/api/auth/me',undefined,product)).body.user.permissions.inbox,false);
  });
  test('machine credential never reads, wrong credentials and disabled connections reject, heartbeat independent',async()=>{
    const {app,admin}=await harness();assert.equal((await app.call('GET','/api/inbox',undefined,undefined,headers)).status,401);
    assert.equal((await app.call('POST','/api/integrations/events',{delivery_id:'x',event:event()},admin)).status,401);
    assert.equal((await app.call('POST','/api/integrations/heartbeat',{found:0,sent:0,errors:0},undefined,headers)).status,200);
    const health=(await app.call('GET','/api/inbox-connections',undefined,admin)).body;assert.equal(health.connections[0].heartbeat_stale,false);assert.equal(health.connections[0].last_ingest_at,null);
    app.db.raw.exec('UPDATE integration_connections SET enabled=0');assert.equal((await app.call('POST','/api/integrations/events',{delivery_id:'x',event:event()},undefined,headers)).status,403);
    app.env.INBOX_INGEST_ENABLED='0';assert.equal((await app.call('POST','/api/integrations/events',{},undefined,headers)).status,503);
  });
  test('worker recovery after expired lease and transient failure does not lose events',async()=>{
    const {app}=await harness();await deliver(app,event());
    app.db.raw.exec("UPDATE inbox_events SET state='processing',lease_token='dead',lease_until='2000-01-01T00:00:00Z',attempts=1");
    await processInbox(app.env);assert.equal(app.one('SELECT state FROM inbox_events').state,'applied');assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,1);
    await deliver(app,event({title:'new'}, {source_event_version:2}),'second');
    const batch=app.env.DB.batch.bind(app.env.DB);let fail=true;
    app.env.DB.batch=async statements=>{if(fail){fail=false;throw new Error('simulated database failure');}return batch(statements);};
    await processInbox(app.env);assert.equal(app.one("SELECT state FROM inbox_events WHERE state='retry_wait'").state,'retry_wait');
    app.db.raw.exec("UPDATE inbox_events SET next_attempt_at='2000-01-01T00:00:00Z' WHERE state='retry_wait'");await processInbox(app.env);
    assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,1);
  });
  test('expired processor cannot commit after its lease token was replaced',async()=>{
    const {app}=await harness();await deliver(app,event());const batch=app.env.DB.batch.bind(app.env.DB);let replace=true;
    app.env.DB.batch=async statements=>{if(replace){replace=false;app.db.raw.exec("UPDATE inbox_events SET lease_token='new-owner'");}return batch(statements);};
    await processInbox(app.env);assert.equal(app.one('SELECT COUNT(*) n FROM inbox_items').n,0);assert.equal(app.one('SELECT lease_token FROM inbox_events').lease_token,'new-owner');
  });
});

describe('Inbox Product decisions and atomic RF creation',()=>{
  test('double accept and lost-response replay create exactly one draft RF, without estimates or scheduling',async()=>{
    const {app,admin,item}=await seeded();const before=app.one('SELECT COUNT(*) n FROM features').n;
    const b=await acceptBody(app,admin,item());const responses=await Promise.all([app.call('POST',`/api/inbox/${item().id}/accept`,b,admin),app.call('POST',`/api/inbox/${item().id}/accept`,{...b,operation_key:crypto.randomUUID()},admin)]);
    assert.equal(responses.filter(r=>r.status===201).length,1);assert.equal(responses.filter(r=>r.status===409).length,1);assert.equal(app.one('SELECT COUNT(*) n FROM features').n,before+1);
    const successful=responses.find(r=>r.status===201)!;
    const rf=app.one('SELECT * FROM features WHERE id=?',successful.body.id);assert.equal(rf.visibility,'draft');assert.equal(rf.is_product_internal,1);assert.equal(rf.is_focus,0);assert.equal(rf.sprint_id,null);
    assert.equal(app.one('SELECT COUNT(*) n FROM feature_estimates WHERE feature_id=?',rf.id).n,0);
    const replay=await app.call('POST',`/api/inbox/${item().id}/accept`,b,admin);assert.ok([200,409].includes(replay.status));
    assert.equal(item().review_state,'accepted');
    const listed=await app.call('GET','/api/inbox',undefined,admin);
    assert.equal(listed.body.items.find((i:any)=>i.id===item().id).duplicate_candidate,false,'linked RF is not a duplicate of itself');
  });
  test('create and link racing cannot leave an orphan RF',async()=>{
    const {app,admin,item}=await seeded();const target=app.one('SELECT id FROM features LIMIT 1').id;const before=app.one('SELECT COUNT(*) n FROM features').n;
    const create=await acceptBody(app,admin,item());const link=await acceptBody(app,admin,item(),'link',target);
    const results=await Promise.all([app.call('POST',`/api/inbox/${item().id}/accept`,create,admin),app.call('POST',`/api/inbox/${item().id}/accept`,link,admin)]);
    assert.equal(results.filter(r=>[200,201].includes(r.status)).length,1);
    assert.equal(app.one('SELECT COUNT(*) n FROM features').n,before+(item().feature_id===target?0:1));
  });
  test('stale preview rejects after a new source event and after Product edits',async()=>{
    const {app,admin,item}=await seeded();const body=await acceptBody(app,admin,item());await deliver(app,event({priority:'N'},{source_event_version:2}),'d2');await processInbox(app.env);
    assert.equal((await app.call('POST',`/api/inbox/${item().id}/accept`,body,admin)).body.error.code,'stale_preview');
    assert.equal(item().review_state,'accepted','new source processing automatically created RF');
    assert.equal((await app.call('PATCH',`/api/inbox/${item().id}`,{version:item().version,fields:{title:'Product wording'}},admin)).status,409);
  });
  test('atomic rollback if linking/audit fails leaves no RF and no accepted decision',async()=>{
    const {app,admin,item}=await seeded();const b=await acceptBody(app,admin,item());const before=app.one('SELECT COUNT(*) n FROM features').n;
    app.db.raw.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON inbox_operations BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.equal((await app.call('POST',`/api/inbox/${item().id}/accept`,b,admin)).status,500);assert.equal(app.one('SELECT COUNT(*) n FROM features').n,before);assert.equal(item().review_state,'new');
  });
  test('accepted remains accepted after source conflict; resolving source does not overwrite RF',async()=>{
    const {app,admin,item}=await seeded();const b=await acceptBody(app,admin,item());const accepted=await app.call('POST',`/api/inbox/${item().id}/accept`,b,admin);assert.equal(accepted.status,201);
    await deliver(app,event({title:'conflicting source'}),'d2');await processInbox(app.env);assert.equal(item().review_state,'accepted');
    const e=app.one("SELECT * FROM inbox_events WHERE state='manual_error'");assert.equal(e.error_code,'field_conflict');
    const resolve=await app.call('POST',`/api/inbox-events/${e.id}/resolve`,{version:e.version,item_version:item().version,choices:{title:'incoming'}},admin);assert.equal(resolve.status,200,JSON.stringify(resolve.body));
    assert.equal(item().title,'conflicting source');assert.equal(app.one('SELECT title FROM features WHERE id=?',accepted.body.id).title,'Unique inbox request');
  });
  test('rejected decision requires reason and is not reset by updates',async()=>{
    const {app,admin,item}=await seeded();assert.equal((await app.call('PATCH',`/api/inbox/${item().id}`,{version:item().version,review_state:'rejected'},admin)).status,400);
    assert.equal((await app.call('PATCH',`/api/inbox/${item().id}`,{version:item().version,review_state:'rejected',reason:'Outside scope'},admin)).status,200);
    await deliver(app,event({title:'another'},{source_event_version:2}),'d2');await processInbox(app.env);assert.equal(item().review_state,'rejected');
  });
  test('100k source text survives; RF preview rejects >20k until explicit Product shortening',async()=>{
    const {app,admin}=await harness();const long='я'.repeat(100000);await deliver(app,event({title:'Long',description:long}));await processInbox(app.env);
    let row=app.one('SELECT * FROM inbox_items');assert.equal(JSON.parse(row.snapshot).description.length,100000);
    assert.equal((await app.call('POST',`/api/inbox/${row.id}/preview`,{version:row.version,mode:'create'},admin)).status,400);
    assert.equal((await app.call('PATCH',`/api/inbox/${row.id}`,{version:row.version,fields:{description:'Reviewed summary'}},admin)).status,200);
    row=app.one('SELECT * FROM inbox_items');const b=await acceptBody(app,admin,row);assert.equal((await app.call('POST',`/api/inbox/${row.id}/accept`,b,admin)).status,201);
    assert.equal(JSON.parse(app.one('SELECT * FROM inbox_items').snapshot).description,long);
  });
  test('existing Bitrix link is suggested, prevents duplicate create, link preserves RF content',async()=>{
    const {app,admin}=await harness('bitrix_email');const target=app.one('SELECT * FROM features LIMIT 1');const url=normalizeIncoming(mail,connection).payload.source_url!;
    await app.call('POST',`/api/features/${target.id}/links`,{url},admin);await deliver(app,mail);await processInbox(app.env);
    const row=app.one('SELECT * FROM inbox_items');const d=await app.call('GET',`/api/inbox/${row.id}`,undefined,admin);assert.equal(d.body.candidates[0].id,target.id);assert.equal(d.body.candidates[0].exact,true);
    assert.equal((await app.call('POST',`/api/inbox/${row.id}/preview`,{version:row.version,mode:'create'},admin)).status,409);
    const b=await acceptBody(app,admin,row,'link',target.id);assert.equal((await app.call('POST',`/api/inbox/${row.id}/accept`,b,admin)).status,200);
    assert.equal(app.one('SELECT description FROM features WHERE id=?',target.id).description,target.description);
  });
});

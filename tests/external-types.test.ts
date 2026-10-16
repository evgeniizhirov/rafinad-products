import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers';
import { processInbox } from '../worker/services/inbox-processor';

async function harness(source='bitrix'){
  const a=await setup(),admin=await a.user('auto-admin@test.io','admin'),employee=await a.user('auto-employee@test.io','department_lead');
  a.env.INBOX_INGEST_ENABLED='1';a.env.INBOX_INGEST_KEYS=JSON.stringify({auto:'x'.repeat(40)});
  const r=await a.call('POST','/api/inbox-connections',{id:'auto',name:'Auto',source,source_instance_id:'example.test',adapter:'canonical_v1',ordering:'version',enabled:true},admin);assert.equal(r.status,201);
  let seq=0;
  async function send(payload:any,version=1,id='external-1'){
    const body={delivery_id:'delivery-'+(++seq),event:{schema_version:1,external_task_id:id,event_type:version===1?'CREATE':'UPDATE',payload_mode:'patch',source_event_version:version,payload}};
    const r=await a.call('POST','/api/integrations/events',body,undefined,{authorization:'Bearer '+'x'.repeat(40),'x-integration-id':'auto'});assert.equal(r.status,202,JSON.stringify(r.body));await processInbox(a.env);return body;
  }
  async function rule(type_value:string,enabled=true){const r=await a.call('POST','/api/admin/external-task-types',{source,type_value,enabled},admin);assert.equal(r.status,201);return r.body.id;}
  const feature=()=>a.one('SELECT f.* FROM inbox_items i JOIN features f ON f.id=i.feature_id ORDER BY i.created_at LIMIT 1');
  return {a,admin,employee,send,rule,feature};
}
for(const source of ['bitrix','jira'])test(`${source}: known, unknown, missing and empty types create RF without Product confirmation`,async()=>{
  const h=await harness(source);await h.rule('Roadmap');
  for(const [n,type] of ['Roadmap','Unknown',undefined,''].entries()){
    await h.send({title:`External ${n}`,description:'Business description',...(type!==undefined?{source_task_type:type}:{})},1,`task-${n}`);
    const item=h.a.one('SELECT * FROM inbox_items WHERE external_task_id=?',`task-${n}`);assert.equal(item.review_state,'accepted');
    const f=h.a.one('SELECT * FROM features WHERE id=?',item.feature_id);assert.equal(f.is_product_internal,n===0?0:1);assert.equal(f.visibility,'internal');
    assert.equal((await h.a.call('GET',`/api/features/${f.id}`,undefined,h.employee)).status,n===0?200:404);
    assert.equal((await h.a.call('GET',`/api/features/${f.id}`)).status,404);
    assert.equal(JSON.parse(item.snapshot).source_task_type,type);
  }
});
test('rules are exact and scoped to the source; CRUD is administrator-only',async()=>{
  const h=await harness('jira');
  assert.equal((await h.a.call('POST','/api/admin/external-task-types',{source:'bitrix',type_value:'Roadmap',enabled:true},h.employee)).status,403);
  assert.equal((await h.a.call('GET','/api/admin/external-task-types',undefined,h.employee)).status,403);
  const r=await h.a.call('POST','/api/admin/external-task-types',{source:'bitrix',type_value:'Roadmap',enabled:true},h.admin);assert.equal(r.status,201);
  await h.send({title:'Jira',source_task_type:'Roadmap'});assert.equal(h.feature().is_product_internal,1);
  await h.rule('Roadmap');await h.send({title:'Whitespace',source_task_type:' Roadmap '},1,'other');
  assert.equal(h.a.one('SELECT f.is_product_internal FROM features f JOIN inbox_items i ON i.feature_id=f.id WHERE i.external_task_id=?','other').is_product_internal,1);
  assert.equal((await h.a.call('DELETE',`/api/admin/external-task-types/${r.body.id}`,{version:1},h.admin)).status,200);
});
test('catalog changes affect new tasks only; apply requires current preview and explicit confirmation',async()=>{
  const h=await harness();await h.send({title:'Private',source_task_type:'New'});const f=h.feature();
  const id=await h.rule('New');
  await h.send({description:'Unrelated source update'},2);assert.equal(h.feature().is_product_internal,1);
  await h.send({title:'New general',source_task_type:'New'},1,'second');
  assert.equal(h.a.one('SELECT f.is_product_internal FROM features f JOIN inbox_items i ON i.feature_id=f.id WHERE i.external_task_id=?','second').is_product_internal,0);
  const p=await h.a.call('POST','/api/admin/external-task-types-preview',{},h.admin);assert.equal(p.body.changes.length,1);assert.equal(p.body.changes[0].feature_id,f.id);
  assert.equal((await h.a.call('POST','/api/admin/external-task-types-apply',{hash:p.body.hash,confirm:false},h.admin)).status,400);
  assert.equal((await h.a.call('POST','/api/admin/external-task-types-apply',{hash:p.body.hash,confirm:true},h.admin)).status,200);assert.equal(h.feature().is_product_internal,0);
  assert.equal((await h.a.call('POST','/api/admin/external-task-types-apply',{hash:p.body.hash,confirm:true},h.admin)).status,409);
  await h.a.call('PATCH',`/api/admin/external-task-types/${id}`,{version:1,source:'bitrix',type_value:'New',enabled:false},h.admin);
  await h.send({title:'After disable',source_task_type:'New'},1,'third');assert.equal(h.a.one('SELECT f.is_product_internal FROM features f JOIN inbox_items i ON i.feature_id=f.id WHERE i.external_task_id=?','third').is_product_internal,1);
  assert.equal(h.feature().is_product_internal,0,'disable did not mutate existing RF');
});
test('source type changes reclassify immediately; old events cannot disclose or undo changes',async()=>{
  const h=await harness();await h.rule('Roadmap');await h.send({title:'Secret sentinel',source_task_type:'Roadmap'});const f=h.feature();
  h.a.db.raw.prepare('INSERT INTO release_features(release_id,feature_id,added_at) VALUES(?,?,?)').run('rel_1',f.id,new Date().toISOString());
  await h.send({source_task_type:'Private'},2);assert.equal(h.feature().is_product_internal,1);assert.equal(h.a.one('SELECT COUNT(*) n FROM release_features WHERE feature_id=?',f.id).n,0);
  assert.equal((await h.a.call('GET',`/api/features/${f.id}`,undefined,h.employee)).status,404);
  for(const url of ['/api/features?internal=all&q=Secret','/api/dashboard','/api/analytics/summary','/api/releases']){
    const r=await h.a.call('GET',url,undefined,h.employee);assert.ok(!JSON.stringify(r.body).includes('Secret sentinel'),url);
  }
  await h.send({source_task_type:'Roadmap'},1);assert.equal(h.feature().is_product_internal,1);
  await h.send({source_task_type:'Roadmap'},3);assert.equal(h.feature().is_product_internal,0);
  assert.ok(h.a.one("SELECT COUNT(*) n FROM inbox_audit WHERE action='rf_reclassified'").n>=2);
});
test('safe source sync preserves local fields, RF status, estimates, and separate external states',async()=>{
  const h=await harness('jira');await h.send({title:'Original',description:'Original text',author_name:'Author',assignee_name:'A'});const f=h.feature();
  h.a.db.raw.prepare('UPDATE features SET description=?,version=version+1 WHERE id=?').run('Local product wording',f.id);
  await h.send({title:'New source title',description:'New source text',assignee_name:'B',external_status:'Done',priority:'Critical',source_due_at:'2030-01-01'},2);
  const next=h.feature();assert.equal(next.title,'New source title');assert.equal(next.description,'Local product wording');assert.equal(next.assignee_name,'B');assert.equal(next.status_id,f.status_id);assert.equal(next.planned_end,f.planned_end);assert.equal(next.urgency,f.urgency);
  const card=await h.a.call('GET',`/api/features/${f.id}`,undefined,h.admin);assert.equal(card.body.external_states?.[0]?.status??card.body.feature?.external_states?.[0]?.status,'Done');
  assert.ok(!JSON.stringify(card.body).includes('raw_payload'));
});
test('ambiguous ordering quarantines conflicts; explicit resolution also updates owned RF fields',async()=>{
  const h=await harness();await h.send({title:'Original',source_task_type:'Private'});const f=h.feature();await h.rule('Roadmap');
  await h.send({title:'Conflicting',source_task_type:'Roadmap'},1);assert.equal(h.feature().title,'Original');assert.equal(h.feature().is_product_internal,1);
  const e=h.a.one("SELECT * FROM inbox_events WHERE error_code='field_conflict'"),i=h.a.one('SELECT * FROM inbox_items');
  const r=await h.a.call('POST',`/api/inbox-events/${e.id}/resolve`,{version:e.version,item_version:i.version,choices:{title:'incoming',source_task_type:'incoming'}},h.admin);assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(h.feature().id,f.id);assert.equal(h.feature().title,'Conflicting');assert.equal(h.feature().is_product_internal,0);
});
test('repeated deliveries and source events never duplicate RF, failed batch rolls back RF and Inbox together',async()=>{
  const h=await harness();const before=h.a.one('SELECT COUNT(*) n FROM features').n;
  h.a.db.raw.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON external_rf_owners BEGIN SELECT RAISE(ABORT,'injected'); END");
  const b=await h.send({title:'Atomic'});assert.equal(h.a.one('SELECT COUNT(*) n FROM features').n,before);assert.equal(h.a.one('SELECT COUNT(*) n FROM inbox_items').n,0);
  h.a.db.raw.exec("DROP TRIGGER fail_auto; UPDATE inbox_events SET next_attempt_at='2000-01-01T00:00:00Z'");await processInbox(h.a.env);assert.equal(h.a.one('SELECT COUNT(*) n FROM features').n,before+1);
  const r=await h.a.call('POST','/api/integrations/events',b,undefined,{authorization:'Bearer '+'x'.repeat(40),'x-integration-id':'auto'});assert.equal(r.status,200);
  await h.send({title:'Atomic'},1);assert.equal(h.a.one('SELECT COUNT(*) n FROM features').n,before+1);
});
test('overlong source description is preserved and errors without a truncated RF',async()=>{
  const h=await harness();await h.send({title:'Long',description:'я'.repeat(20001)});
  assert.equal(h.a.one('SELECT * FROM inbox_items').feature_id,null);assert.equal(h.a.one('SELECT * FROM inbox_events').error_code,'rf_description_too_long');
  assert.equal(JSON.parse(h.a.one('SELECT * FROM inbox_items').snapshot).description.length,20001);
});

test('internal dashboard counts RF work only for editors; type edits invalidate previews',async()=>{
  const h=await harness();await h.send({title:'Internal work',source_task_type:'New'});const f=h.feature();
  h.a.db.raw.prepare('UPDATE features SET fact_hours=7 WHERE id=?').run(f.id);
  const r=await h.a.call('GET','/api/internal-tasks',undefined,h.admin);assert.equal(r.status,200);assert.equal(r.body.total,1);assert.equal(r.body.fact_hours,7);
  assert.equal((await h.a.call('GET','/api/internal-tasks',undefined,h.employee)).status,403);
  const id=await h.rule('New');const p=await h.a.call('POST','/api/admin/external-task-types-preview',{},h.admin);
  await h.a.call('PATCH',`/api/admin/external-task-types/${id}`,{source:'bitrix',type_value:'Changed',enabled:true,version:1},h.admin);
  assert.equal((await h.a.call('POST','/api/admin/external-task-types-apply',{hash:p.body.hash,confirm:true},h.admin)).status,409);
  assert.equal(h.feature().is_product_internal,1);
});

test('concurrent processors and expired-lease recovery cannot create duplicate automatic RF',async()=>{
  const h=await harness(),before=h.a.one('SELECT COUNT(*) n FROM features').n;
  // Queue directly to exercise two workers claiming the same durable event.
  await h.a.call('POST','/api/integrations/events',{delivery_id:'race',event:{schema_version:1,external_task_id:'race',event_type:'CREATE',payload_mode:'patch',payload:{title:'Concurrent'}}},undefined,{authorization:'Bearer '+'x'.repeat(40),'x-integration-id':'auto'});
  await Promise.all([processInbox(h.a.env),processInbox(h.a.env)]);
  assert.equal(h.a.one('SELECT COUNT(*) n FROM features').n,before+1);
  h.a.db.raw.exec("UPDATE inbox_events SET state='processing',lease_token='expired',lease_until='2000-01-01T00:00:00Z'");
  await processInbox(h.a.env);assert.equal(h.a.one('SELECT COUNT(*) n FROM features').n,before+1);
  assert.equal(h.a.one('SELECT state FROM inbox_events').state,'applied');
});

import type { Env, D1Database, D1PreparedStatement } from '../env';
import { all, first, guardVersion, newId, nowIso, parseJson, stmt, type Row } from '../lib/db';
import { auditStmt, diffFields } from '../lib/audit';
import type { Ctx } from '../lib/http';
import { canonical, type Fields } from '../domain/inbox';
import { bitrixTaskKey } from '../domain/external-task';
import { guessKind } from '../domain/links';
import { prepareFeatureCreate } from './feature-create';

export async function classification(db: D1Database, source: string, type: unknown) {
  const revision=(await first(db,"SELECT version FROM external_type_revision WHERE id='catalog'"))!.version;
  const allowed=typeof type==='string' && !!type.trim() && !!await first(db,'SELECT 1 FROM external_task_types WHERE source=? AND type_value=? AND enabled=1',source,type);
  return {internal:!allowed,revision};
}

/** Hiding is immediate, including tasks already placed in shared releases. Estimates and votes survive. */
export function classificationStatements(db:D1Database, f:Row, internal:boolean) {
  const patch:Row={is_product_internal:internal?1:0,visibility:'internal'};
  if(internal){patch.is_focus=0;patch.sprint_id=null;}
  const changes=diffFields(f,patch);
  if(!changes.length)return [];
  return [guardVersion(db,'features',f.id,f.version),
    ...(internal?[stmt(db,'DELETE FROM release_features WHERE feature_id=?',f.id)]:[]),
    stmt(db,`UPDATE features SET is_product_internal=?,visibility='internal',is_focus=?,sprint_id=?,version=version+1,updated_at=? WHERE id=?`,internal?1:0,internal?0:f.is_focus,internal?null:f.sprint_id,nowIso(),f.id),
    auditStmt(db,null,'feature',f.id,'external_classification',changes)];
}

/** Builds statements for the SAME transaction as the inbox snapshot and event acknowledgement. */
export async function prepareExternalRf(env:Env, item:Row, snapshot:Fields, eventId:string|null) {
  const db=env.DB, statements:D1PreparedStatement[]=[];
  let f=item.feature_id?await first(db,'SELECT * FROM features WHERE id=?',item.feature_id):null;
  let baseline=parseJson<Fields>(item.rf_sync,{});
  let managed=!!item.auto_managed;
  let classified=item.classified_type??null;
  let error:string|null=null;
  const type=typeof snapshot.source_task_type==='string'?snapshot.source_task_type:null;
  // Preserve prior manual decisions and deleted RF tombstones; never silently recreate a purged task.
  if(!f&&item.review_state==='accepted')return {statements,error:'linked_rf_missing'};
  if(item.review_state==='rejected')return {statements,error:null};
  if(!f){
    if(typeof snapshot.title!=='string'||!snapshot.title.trim())return {statements,error:'rf_title_required'};
    if(typeof snapshot.description==='string'&&snapshot.description.length>20000)return {statements,error:'rf_description_too_long'};
    // Exact source links require explicit association, never fuzzy title-based merging.
    if(snapshot.source_url){
      const links=await all(db,'SELECT feature_id,url FROM feature_links');
      if(links.some(l=>l.url===snapshot.source_url || item.source==='bitrix'&&bitrixTaskKey(String(snapshot.source_url))&&bitrixTaskKey(l.url)===bitrixTaskKey(String(snapshot.source_url))))return {statements,error:'rf_link_requires_review'};
    }
    const c=await classification(db,item.source,type);
    statements.push(guardVersion(db,'external_type_revision','catalog',c.revision));
    const fields:Fields={title:snapshot.title,description:snapshot.description??'',author_name:snapshot.author_name??'',assignee_name:snapshot.assignee_name??null};
    const ctx={env,user:null} as Ctx;
    const created=await prepareFeatureCreate(ctx,{...fields,visibility:'internal',is_product_internal:c.internal},newId('f'),true);
    statements.push(...created.statements);
    f={...created.result,...fields,version:1,is_product_internal:c.internal?1:0,visibility:'internal'};
    baseline=fields;managed=true;classified=type;
    statements.push(stmt(db,'INSERT INTO external_rf_owners(feature_id,item_id) VALUES(?,?)',f.id,item.id));
    if(snapshot.source_url)statements.push(stmt(db,"INSERT INTO feature_links(id,feature_id,kind,url,origin,created_at,updated_at) VALUES(?,?,?,?,'manual',?,?)",newId('lnk'),f.id,guessKind(String(snapshot.source_url)),snapshot.source_url,nowIso(),nowIso()));
    statements.push(stmt(db,'INSERT INTO inbox_audit(item_id,event_id,action,details,at) VALUES(?,?,?,?,?)',item.id,eventId,'rf_auto_created',JSON.stringify({feature_id:f.id,internal:c.internal,type}),nowIso()));
  }else if(managed){
    const owner=await first(db,'SELECT item_id FROM external_rf_owners WHERE feature_id=?',f.id);
    if(owner?.item_id!==item.id)return {statements,error:null};
    const patch:Row={};const retained:string[]=[];
    // Only source-owned values still equal to the last applied baseline are overwritten.
    for(const key of ['title','description','author_name','assignee_name']){
      if(!(key in snapshot))continue;
      const incoming=snapshot[key]??(key==='assignee_name'?null:'');
      if(key==='description'&&String(incoming).length>20000){error='rf_description_too_long';continue;}
      if(key==='title'&&!String(incoming).trim()){error='rf_title_required';continue;}
      if(canonical(f[key])===canonical(baseline[key])){if(canonical(f[key])!==canonical(incoming))patch[key]=incoming;baseline[key]=incoming;}
      else if(canonical(f[key])!==canonical(incoming))retained.push(key);
    }
    if(Object.keys(patch).length){
      statements.push(guardVersion(db,'features',f.id,f.version),stmt(db,`UPDATE features SET ${Object.keys(patch).map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`,...Object.values(patch),nowIso(),f.id),auditStmt(db,null,'feature',f.id,'external_sync',diffFields(f,patch)));
      f={...f,...patch,version:f.version+1};
    }
    if(retained.length)statements.push(stmt(db,'INSERT INTO inbox_audit(item_id,event_id,action,details,at) VALUES(?,?,?,?,?)',item.id,eventId,'rf_local_values_preserved',JSON.stringify({fields:retained}),nowIso()));
    // Catalog edits alone must never disclose previously internal tasks on unrelated updates.
    if(type!==classified){
      const c=await classification(db,item.source,type);
      statements.push(guardVersion(db,'external_type_revision','catalog',c.revision),...classificationStatements(db,f,c.internal));classified=type;
      statements.push(stmt(db,'INSERT INTO inbox_audit(item_id,event_id,action,details,at) VALUES(?,?,?,?,?)',item.id,eventId,'rf_reclassified',JSON.stringify({old_type:item.classified_type,new_type:type,internal:c.internal}),nowIso()));
    }
  }
  statements.push(stmt(db,"UPDATE inbox_items SET feature_id=?,review_state='accepted',auto_managed=?,rf_sync=?,classified_type=? WHERE id=?",f!.id,managed?1:0,JSON.stringify(baseline),classified,item.id));
  return {statements,error};
}

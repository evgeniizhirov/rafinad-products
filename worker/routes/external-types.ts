import { z } from 'zod';
import { requirePerm, perms } from '../lib/auth';
import { all, first, guardVersion, newId, nowIso, parseJson, stmt, tx } from '../lib/db';
import { auditStmt } from '../lib/audit';
import { badRequest, conflict, json, readJson, type Ctx, type Router } from '../lib/http';
import { canonical } from '../domain/inbox';
import { sha256Hex } from '../lib/crypto';
import { classificationStatements } from '../services/external-rf';
import { featureDto, indexWorld, loadWorld, isClosed } from '../lib/world';
import { queryFeatures } from './features';

const fields={source:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),type_value:z.string().min(1).max(300).refine(v=>!!v.trim(),'Укажите тип'),enabled:z.boolean()};
async function plan(ctx:Ctx){
  const revision=(await first(ctx.env.DB,"SELECT version FROM external_type_revision WHERE id='catalog'"))!.version;
  const allowed=new Set((await all(ctx.env.DB,'SELECT source,type_value FROM external_task_types WHERE enabled=1')).map(t=>canonical([t.source,t.type_value])));
  const rows=await all(ctx.env.DB,`SELECT i.*,f.version AS rf_version,f.is_product_internal,f.visibility,f.number,f.title AS rf_title,f.is_focus,f.sprint_id FROM inbox_items i JOIN external_rf_owners o ON o.item_id=i.id JOIN features f ON f.id=o.feature_id WHERE i.auto_managed=1 AND f.merged_into_id IS NULL ORDER BY i.id LIMIT 501`);
  if(rows.length>500)throw badRequest('Для пакетного пересчёта более 500 задач требуется отдельная миграция');
  const changes=[];
  for(const row of rows){
    const type=parseJson<any>(row.snapshot,{}).source_task_type??null;
    const c={internal:typeof type!=='string'||!type.trim()||!allowed.has(canonical([row.source,type]))};
    if(!!row.is_product_internal===c.internal)continue;
    changes.push({item_id:row.id,item_version:row.version,feature_id:row.feature_id,feature_version:row.rf_version,key:`RF-${row.number}`,title:row.rf_title,source:row.source,type,internal:c.internal,was_internal:!!row.is_product_internal,visibility:row.visibility,is_focus:row.is_focus,sprint_id:row.sprint_id});
  }
  return {revision,changes,hash:await sha256Hex(canonical({revision,changes}))};
}
export function registerExternalTypeRoutes(r:Router){
  r.get('/api/internal-tasks',async ctx=>{
    requirePerm(ctx,perms.editCatalog);
    const w=await loadWorld(ctx.env.DB,'editor',{includeInternal:true}),idx=indexWorld(w),p=new URLSearchParams(ctx.url.searchParams);p.set('internal','only');
    const rows=queryFeatures(p,'editor',w,idx),ids=new Set(rows.map(f=>f.id));
    return json({features:rows.map(f=>featureDto(f,'editor',w,idx)),total:rows.length,closed:rows.filter(f=>isClosed(f,idx)).length,estimated_hours:w.estimates.filter(e=>ids.has(e.feature_id)).reduce((n,e)=>n+Number(e.hours??0),0),fact_hours:rows.reduce((n,f)=>n+Number(f.fact_hours??0),0)});
  });
  r.get('/api/admin/external-task-types',async ctx=>{requirePerm(ctx,perms.admin);return json({types:await all(ctx.env.DB,'SELECT * FROM external_task_types ORDER BY source,type_value'),sources:await all(ctx.env.DB,'SELECT DISTINCT source FROM integration_connections ORDER BY source')});});
  r.post('/api/admin/external-task-types',async ctx=>{
    const user=requirePerm(ctx,perms.admin),b=await readJson(ctx,z.object(fields).strict()),id=newId('exttype');
    await tx(ctx.env.DB,[stmt(ctx.env.DB,'INSERT INTO external_task_types(id,source,type_value,enabled) VALUES(?,?,?,?)',id,b.source,b.type_value,b.enabled),stmt(ctx.env.DB,"UPDATE external_type_revision SET version=version+1 WHERE id='catalog'"),auditStmt(ctx.env.DB,user,'external_task_type',id,'created')]);return json({id},201);
  });
  r.patch('/api/admin/external-task-types/:id',async ctx=>{
    const user=requirePerm(ctx,perms.admin),b=await readJson(ctx,z.object({...fields,version:z.number().int().positive()}).strict());
    await tx(ctx.env.DB,[guardVersion(ctx.env.DB,'external_task_types',ctx.params.id,b.version),stmt(ctx.env.DB,'UPDATE external_task_types SET source=?,type_value=?,enabled=?,version=version+1 WHERE id=?',b.source,b.type_value,b.enabled,ctx.params.id),stmt(ctx.env.DB,"UPDATE external_type_revision SET version=version+1 WHERE id='catalog'"),auditStmt(ctx.env.DB,user,'external_task_type',ctx.params.id,'updated')]);return json({ok:true});
  });
  r.delete('/api/admin/external-task-types/:id',async ctx=>{
    const user=requirePerm(ctx,perms.admin),b=await readJson(ctx,z.object({version:z.number().int().positive()}).strict());
    await tx(ctx.env.DB,[guardVersion(ctx.env.DB,'external_task_types',ctx.params.id,b.version),stmt(ctx.env.DB,'DELETE FROM external_task_types WHERE id=?',ctx.params.id),stmt(ctx.env.DB,"UPDATE external_type_revision SET version=version+1 WHERE id='catalog'"),auditStmt(ctx.env.DB,user,'external_task_type',ctx.params.id,'deleted')]);return json({ok:true});
  });
  r.post('/api/admin/external-task-types-preview',async ctx=>{requirePerm(ctx,perms.admin);return json(await plan(ctx));});
  r.post('/api/admin/external-task-types-apply',async ctx=>{
    const user=requirePerm(ctx,perms.admin),b=await readJson(ctx,z.object({hash:z.string().length(64),confirm:z.literal(true)}).strict()),p=await plan(ctx);
    if(b.hash!==p.hash)throw conflict('stale_preview','Справочник или задачи изменились. Повторите предпросмотр.');
    const db=ctx.env.DB,st=[guardVersion(db,'external_type_revision','catalog',p.revision)];
    for(const c of p.changes){
      st.push(guardVersion(db,'inbox_items',c.item_id,c.item_version),...classificationStatements(db,{id:c.feature_id,version:c.feature_version,is_product_internal:c.was_internal?1:0,visibility:c.visibility,is_focus:c.is_focus,sprint_id:c.sprint_id},c.internal),
        stmt(db,'UPDATE inbox_items SET classified_type=?,version=version+1 WHERE id=?',c.type,c.item_id),
        stmt(db,'INSERT INTO inbox_audit(item_id,actor_id,action,details,at) VALUES(?,?,?,?,?)',c.item_id,user.id,'admin_reclassification',JSON.stringify(c),nowIso()));
    }
    st.push(auditStmt(db,user,'external_task_type','catalog','reclassification_confirmed',null,`${p.changes.length} задач`));
    await tx(db,st);return json({changed:p.changes.length});
  });
}

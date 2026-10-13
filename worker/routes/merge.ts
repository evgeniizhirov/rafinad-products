// Manual merge of duplicate features (TZ §4.4, §15.3): nothing is lost, conflicting department votes
// are resolved explicitly, hours are not double-counted, old links keep working (merged_into_id).

import { z } from 'zod';
import { findCycle, type Edge } from '../domain/graph';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { all, guardVersion, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, readJson, type Ctx, type Router } from '../lib/http';
import { resolveFeature } from './features';

async function analyse(ctx: Ctx, sourceRef: string, targetRef: string) {
  const db = ctx.env.DB;
  const source = await resolveFeature(ctx, sourceRef);
  const target = await resolveFeature(ctx, targetRef);
  if (source.id === target.id) throw badRequest('Нельзя объединить карточку саму с собой');
  if (source.merged_into_id) throw badRequest(`RF-${source.number} уже объединена с другой карточкой`);
  if (target.merged_into_id) throw badRequest(`RF-${target.number} уже объединена — выберите основную карточку`);
  const [votes, estimates, relations, departments, teams] = await Promise.all([
    all(db, 'SELECT * FROM department_votes WHERE feature_id IN (?, ?)', source.id, target.id),
    all(db, 'SELECT * FROM feature_estimates WHERE feature_id IN (?, ?)', source.id, target.id),
    all(db, 'SELECT * FROM feature_relations'),
    all(db, 'SELECT id, name FROM departments'),
    all(db, 'SELECT id, name FROM resource_teams'),
  ]);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const sv = votes.filter((v) => v.feature_id === source.id);
  const tv = new Map(votes.filter((v) => v.feature_id === target.id).map((v) => [v.department_id, v]));
  const voteConflicts = sv
    .filter((v) => tv.has(v.department_id) && tv.get(v.department_id)!.score !== v.score)
    .map((v) => ({ department_id: v.department_id, department: deptName.get(v.department_id), source_score: v.score, target_score: tv.get(v.department_id)!.score }));
  const se = estimates.filter((e) => e.feature_id === source.id);
  const te = new Map(estimates.filter((e) => e.feature_id === target.id).map((e) => [e.team_id, e]));
  const estimatePlan = se.map((e) => ({
    team_id: e.team_id,
    team: teamName.get(e.team_id),
    source: e.hours,
    target: te.get(e.team_id)?.hours ?? null,
    result: te.has(e.team_id) ? te.get(e.team_id)!.hours : e.hours,
    action: te.has(e.team_id) ? 'keep_target' : 'move',
  }));

  // re-point relations
  const newRelations: { rel: Row; from: string; to: string; action: 'update' | 'delete' }[] = [];
  const key = (t: string, f: string, to: string) => `${t}|${f}|${to}`;
  const existing = new Set(relations.filter((r) => r.from_id !== source.id && r.to_id !== source.id).map((r) => key(r.type, r.from_id, r.to_id)));
  for (const r of relations) {
    if (r.from_id !== source.id && r.to_id !== source.id) continue;
    const from = r.from_id === source.id ? target.id : r.from_id;
    const to = r.to_id === source.id ? target.id : r.to_id;
    const dup = existing.has(key(r.type, from, to)) || (r.type === 'related_to' && existing.has(key(r.type, to, from)));
    if (from === to || dup) newRelations.push({ rel: r, from, to, action: 'delete' });
    else {
      existing.add(key(r.type, from, to));
      newRelations.push({ rel: r, from, to, action: 'update' });
    }
  }
  const edges: Edge[] = [];
  for (const r of relations) {
    if (r.type !== 'blocks') continue;
    const nr = newRelations.find((x) => x.rel.id === r.id);
    if (nr?.action === 'delete') continue;
    edges.push(nr ? [nr.from, nr.to] : [r.from_id, r.to_id]);
  }
  const cycle = findCycle(edges);
  return { source, target, voteConflicts, sourceVotes: sv, targetVotes: tv, estimatePlan, newRelations, cycle };
}

export function registerMergeRoutes(r: Router) {
  r.get('/api/features/:id/merge-preview', async (ctx) => {
    requirePerm(ctx, perms.editCatalog);
    const target = ctx.url.searchParams.get('target_id');
    if (!target) throw badRequest('Укажите основную карточку');
    const a = await analyse(ctx, ctx.params.id, target);
    const db = ctx.env.DB;
    const counts = {
      comments: (await all(db, 'SELECT COUNT(*) AS n FROM comments WHERE feature_id = ?', a.source.id))[0].n,
      sources: (await all(db, `SELECT COUNT(*) AS n FROM source_entity_links WHERE entity_type = 'feature' AND entity_id = ?`, a.source.id))[0].n,
      links: (await all(db, 'SELECT COUNT(*) AS n FROM feature_links WHERE feature_id = ?', a.source.id))[0].n,
      relations_moved: a.newRelations.filter((x) => x.action === 'update').length,
      relations_dropped: a.newRelations.filter((x) => x.action === 'delete').length,
    };
    return json({
      source: { id: a.source.id, key: `RF-${a.source.number}`, title: a.source.title, version: a.source.version },
      target: { id: a.target.id, key: `RF-${a.target.number}`, title: a.target.title, version: a.target.version },
      vote_conflicts: a.voteConflicts,
      estimates: a.estimatePlan,
      counts,
      cycle: a.cycle,
    });
  });

  r.post('/api/features/:id/merge', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({
      target_id: z.string(),
      source_version: z.number().int(),
      target_version: z.number().int(),
      vote_choices: z.record(z.string(), z.enum(['source', 'target'])).default({}),
      confirm: z.literal(true),
    }));
    const a = await analyse(ctx, ctx.params.id, b.target_id);
    if (a.cycle) throw conflict('cycle', 'После объединения появится циклическая зависимость — сначала уберите лишние связи');
    const missing = a.voteConflicts.filter((c) => !b.vote_choices[c.department_id]);
    if (missing.length) throw badRequest(`Выберите итоговую оценку для отделов: ${missing.map((m) => m.department).join(', ')}`, { vote_conflicts: a.voteConflicts });

    const db = ctx.env.DB;
    const S = a.source.id;
    const T = a.target.id;
    const now = nowIso();
    const st = [guardVersion(db, 'features', S, b.source_version), guardVersion(db, 'features', T, b.target_version)];
    const voteChanges = [];

    // votes
    for (const v of a.sourceVotes) {
      const tv = a.targetVotes.get(v.department_id);
      if (!tv) {
        st.push(stmt(db, 'UPDATE department_votes SET feature_id = ? WHERE feature_id = ? AND department_id = ?', T, S, v.department_id));
        voteChanges.push({ field: `vote:${v.department_id}`, old: null, new: v.score });
      } else {
        if (tv.score !== v.score && b.vote_choices[v.department_id] === 'source') {
          st.push(stmt(db, 'UPDATE department_votes SET score = ?, voted_by = ?, voted_at = ?, version = version + 1 WHERE feature_id = ? AND department_id = ?', v.score, user.id, now, T, v.department_id));
          voteChanges.push({ field: `vote:${v.department_id}`, old: tv.score, new: v.score });
        }
        st.push(stmt(db, 'DELETE FROM department_votes WHERE feature_id = ? AND department_id = ?', S, v.department_id));
      }
    }
    // estimates: never sum the same work twice — target keeps its own, missing teams come from the source
    for (const e of a.estimatePlan) {
      if (e.action === 'move') st.push(stmt(db, 'UPDATE feature_estimates SET feature_id = ? WHERE feature_id = ? AND team_id = ?', T, S, e.team_id));
      else st.push(stmt(db, 'DELETE FROM feature_estimates WHERE feature_id = ? AND team_id = ?', S, e.team_id));
    }
    // relations
    for (const nr of a.newRelations) {
      if (nr.action === 'delete') st.push(stmt(db, 'DELETE FROM feature_relations WHERE id = ?', nr.rel.id));
      else st.push(stmt(db, 'UPDATE feature_relations SET from_id = ?, to_id = ? WHERE id = ?', nr.from, nr.to, nr.rel.id));
    }
    // tags, comments, import sources, release membership
    // external links: moved to the main card; a URL it already has is not duplicated
    st.push(stmt(db, `UPDATE feature_links SET feature_id = ? WHERE feature_id = ? AND url NOT IN (SELECT url FROM feature_links WHERE feature_id = ?)`, T, S, T));
    st.push(stmt(db, 'DELETE FROM feature_links WHERE feature_id = ?', S));
    st.push(stmt(db, 'INSERT OR IGNORE INTO feature_tags (feature_id, tag) SELECT ?, tag FROM feature_tags WHERE feature_id = ?', T, S));
    st.push(stmt(db, 'UPDATE comments SET feature_id = ?, moved_from = COALESCE(moved_from, ?) WHERE feature_id = ?', T, S, S));
    st.push(stmt(db, `UPDATE source_entity_links SET entity_id = ?, updated_at = ? WHERE entity_type = 'feature' AND entity_id = ?`, T, now, S));
    st.push(stmt(db, `UPDATE release_features SET feature_id = ? WHERE feature_id = ? AND NOT EXISTS (SELECT 1 FROM release_features WHERE feature_id = ?)`, T, S, T));
    st.push(stmt(db, 'DELETE FROM release_features WHERE feature_id = ?', S));
    // the source card stays (old links resolve to the target) and records the duplicate relation
    st.push(stmt(db, 'UPDATE features SET merged_into_id = ?, period_id = NULL, placement_locked = 0, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', T, now, user.id, S));
    st.push(stmt(db, 'INSERT OR IGNORE INTO feature_relations (id, type, from_id, to_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', newId('rel'), 'duplicate_of', S, T, now, user.id));
    st.push(stmt(db, 'UPDATE features SET updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', now, user.id, T));
    st.push(auditStmt(db, user, 'feature', S, 'merged_into', [{ field: 'merged_into', old: null, new: `RF-${a.target.number}` }]));
    st.push(auditStmt(db, user, 'feature', T, 'merged_from', [
      { field: 'merged_from', old: null, new: `RF-${a.source.number}` },
      ...voteChanges,
      ...a.estimatePlan.map((e) => ({ field: `hours:${e.team}`, old: e.target, new: e.result })),
    ]));
    await tx(db, st, 'Одна из карточек изменилась. Обновите предпросмотр объединения.');
    return json({ ok: true, target_id: T });
  });
}

import { z } from 'zod';
import { perms, requireUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { bool, first, nowIso, stmt, tx } from '../lib/db';
import { badRequest, conflict, forbidden, json, readJson, type Router } from '../lib/http';
import { featureDto, indexWorld, loadWorld, viewerOf, visibleFeatures } from '../lib/world';
import { resolveFeature, sortFeatures } from './features';

export function registerPriorityRoutes(r: Router) {
  /**
   * Set / change / remove the vote of ONE department for ONE feature.
   * One current score per (department, feature); every change is kept in the audit log.
   * Optimistic locking: the client sends the vote version it saw (null = "no vote yet").
   */
  r.put('/api/features/:id/votes/:departmentId', async (ctx) => {
    const user = requireUser(ctx);
    const b = await readJson(ctx, z.object({
      score: z.number().int().min(1).max(5).nullable(),
      expected_version: z.number().int().nullable(),
      reason: z.string().trim().max(500).optional(),
    }));
    const deptId = ctx.params.departmentId;
    const db = ctx.env.DB;
    const dept = await first(db, 'SELECT * FROM departments WHERE id = ?', deptId);
    if (!dept || !bool(dept.is_active)) throw badRequest('Отдел не найден или отключён');
    const own = perms.voteFor(user, deptId);
    if (!own) {
      if (!perms.overrideVote(user)) throw forbidden(`Вы не можете голосовать от имени отдела «${dept.name}»`);
      if (!b.reason) throw badRequest('Изменение оценки за другой отдел — административное действие: укажите причину');
    }
    const f = await resolveFeature(ctx, ctx.params.id);
    if (f.merged_into_id) throw conflict('merged', 'Карточка объединена — голосуйте за основную');
    if (f.visibility === 'draft' && !perms.seeDrafts(user)) throw forbidden();
    const cur = await first(db, 'SELECT * FROM department_votes WHERE feature_id = ? AND department_id = ?', f.id, deptId);
    const curVersion = cur?.version ?? null;
    if (curVersion !== b.expected_version) {
      throw conflict('version_conflict', 'Оценку этого отдела уже изменили. Обновите данные.', { current: cur ? { score: cur.score, version: cur.version, voted_at: cur.voted_at } : null });
    }
    if ((cur?.score ?? null) === b.score) return json({ ok: true, unchanged: true });
    const now = nowIso();
    const statements = [];
    // guard against a concurrent change between the read above and this write
    statements.push(cur
      ? stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'vote' WHERE NOT EXISTS (SELECT 1 FROM department_votes WHERE feature_id = ? AND department_id = ? AND version = ?)`, f.id, deptId, cur.version)
      : stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'vote' WHERE EXISTS (SELECT 1 FROM department_votes WHERE feature_id = ? AND department_id = ?)`, f.id, deptId));
    if (b.score === null) statements.push(stmt(db, 'DELETE FROM department_votes WHERE feature_id = ? AND department_id = ?', f.id, deptId));
    else if (cur) statements.push(stmt(db, 'UPDATE department_votes SET score = ?, voted_by = ?, voted_at = ?, version = version + 1 WHERE feature_id = ? AND department_id = ?', b.score, user.id, now, f.id, deptId));
    else statements.push(stmt(db, 'INSERT INTO department_votes (feature_id, department_id, score, voted_by, voted_at) VALUES (?, ?, ?, ?, ?)', f.id, deptId, b.score, user.id, now));
    statements.push(auditStmt(db, user, 'vote', f.id, own ? 'vote' : 'vote_admin_override', [{ field: `vote:${dept.name}`, old: cur?.score ?? null, new: b.score }], b.reason ?? null, !own));
    await tx(db, statements, 'Оценку этого отдела уже изменили. Обновите данные.');
    return json({ ok: true });
  });

  /** Matrix "features × departments" + overall ranking. */
  r.get('/api/priorities', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    const p = ctx.url.searchParams;
    let rows = visibleFeatures(w, viewer).filter((f) => p.get('include_closed') === '1' || !['done', 'cancelled'].includes(idx.status.get(f.status_id)?.semantic));
    const dept = p.get('department');
    if (dept && p.get('mode') === 'voted') rows = rows.filter((f) => (idx.votesBy.get(f.id) ?? []).some((v) => v.department_id === dept));
    if (dept && p.get('mode') === 'not_voted') rows = rows.filter((f) => !(idx.votesBy.get(f.id) ?? []).some((v) => v.department_id === dept));
    const q = (p.get('q') || '').trim().toLowerCase();
    if (q) rows = rows.filter((f) => `rf-${f.number} ${f.title}`.toLowerCase().includes(q));
    rows = sortFeatures(rows, w, idx, 'priority');
    const departments = w.departments.filter((d) => bool(d.is_active)).map((d) => ({ id: d.id, name: d.name, code: d.code, weight: d.weight, is_product: bool(d.is_product) }));
    const voteCounts = Object.fromEntries(departments.map((d) => [d.id, w.votes.filter((v) => v.department_id === d.id && rows.some((f) => f.id === v.feature_id)).length]));
    return json({
      departments,
      vote_counts: voteCounts,
      features: rows.map((f, i) => ({ rank: i + 1, ...featureDto(f, viewer, w, idx) })),
    });
  });
}

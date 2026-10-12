import { z } from 'zod';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt, diffFields } from '../lib/audit';
import { all, bool, first, guardVersion, newId, nowIso, placeholders, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Router } from '../lib/http';
import { canSee, featureDto, indexWorld, loadWorld, viewerOf, type Indexes, type Viewer, type World } from '../lib/world';
import { sortFeatures } from './features';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const fields = {
  name: z.string().trim().min(1).max(200),
  version_label: z.string().trim().max(50).nullable().optional(),
  description: z.string().max(20000).optional(),
  status_id: z.string().optional(),
  planned_date: date,
  actual_date: date,
  visibility: z.enum(['draft', 'internal', 'public']).optional(),
};

export function releaseSummary(rel: Row, viewer: Viewer, w: World, idx: Indexes, detail = false) {
  const all = (idx.featuresByRelease.get(rel.id) ?? []).map((id) => idx.feature.get(id)!).filter((f) => f && !f.merged_into_id);
  const visible = all.filter((f) => canSee(viewer, f.visibility));
  // public readiness is computed over public features only — hidden work never leaks through aggregates
  const counted = (viewer === 'guest' ? visible : all).filter((f) => idx.status.get(f.status_id)?.semantic !== 'cancelled');
  const done = counted.filter((f) => idx.status.get(f.status_id)?.semantic === 'done');
  const openBlockers = (f: Row) =>
    w.relations.filter((r) => r.type === 'blocks' && r.to_id === f.id).filter((r) => {
      const b = idx.feature.get(r.from_id);
      const sem = b ? idx.status.get(b.status_id)?.semantic : null;
      return b && !b.merged_into_id && sem !== 'done' && sem !== 'cancelled';
    });
  const blockers = visible
    .filter((f) => idx.status.get(f.status_id)?.semantic === 'blocked' || openBlockers(f).length > 0)
    .map((f) => ({
      feature: { id: f.id, key: `RF-${f.number}`, title: f.title },
      status_blocked: idx.status.get(f.status_id)?.semantic === 'blocked',
      blocked_by: openBlockers(f).map((r) => {
        const b = idx.feature.get(r.from_id)!;
        return canSee(viewer, b.visibility) ? { id: b.id, key: `RF-${b.number}`, title: b.title, status: idx.status.get(b.status_id)?.name } : { hidden: true };
      }),
    }));
  const s = idx.status.get(rel.status_id);
  const overdue = rel.planned_date && !rel.actual_date && s?.semantic !== 'done' && rel.planned_date < new Date().toISOString().slice(0, 10);
  return {
    id: rel.id,
    name: rel.name,
    version_label: rel.version_label,
    description: rel.description,
    status: s ? { id: s.id, name: s.name, semantic: s.semantic, color: s.color } : null,
    planned_date: rel.planned_date,
    actual_date: rel.actual_date,
    approved: !!rel.approved_at,
    approved_at: rel.approved_at,
    visibility: viewer === 'guest' ? undefined : rel.visibility,
    version: viewer === 'guest' ? undefined : rel.version,
    feature_count: counted.length,
    done_count: done.length,
    readiness: counted.length ? Math.round((done.length / counted.length) * 100) : 0,
    overdue: !!overdue,
    blockers,
    feature_ids: visible.map((f) => f.id),
    features: detail ? sortFeatures(visible, w, idx, 'priority').map((f) => featureDto(f, viewer, w, idx)) : undefined,
  };
}

export function registerReleaseRoutes(r: Router) {
  r.get('/api/releases', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    return json({ releases: w.releases.filter((x) => canSee(viewer, x.visibility)).map((x) => releaseSummary(x, viewer, w, idx, true)) });
  });

  r.get('/api/releases/:id', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    const rel = idx.release.get(ctx.params.id);
    if (!rel || !canSee(viewer, rel.visibility)) throw notFound('Релиз не найден');
    const dto = releaseSummary(rel, viewer, w, idx, true) as Record<string, unknown>;
    if (viewer !== 'guest') {
      dto.history = (await all(ctx.env.DB, `SELECT at, actor_name, action, changes, reason FROM audit_log WHERE entity_type = 'release' AND entity_id = ? ORDER BY id DESC LIMIT 100`, rel.id))
        .map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null }));
    }
    return json({ release: dto });
  });

  r.post('/api/releases', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object(fields));
    const db = ctx.env.DB;
    if (b.status_id && !(await first(db, `SELECT 1 FROM statuses WHERE id = ? AND entity = 'release'`, b.status_id))) throw badRequest('Статус не найден');
    const id = newId('r');
    const now = nowIso();
    await tx(db, [
      stmt(db, `INSERT INTO releases (id, name, version_label, description, status_id, planned_date, actual_date, visibility, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, b.name, b.version_label ?? null, b.description ?? '', b.status_id ?? 'st_r_planned', b.planned_date ?? null, b.actual_date ?? null, b.visibility ?? 'internal', now, now, user.id),
      auditStmt(db, user, 'release', id, 'created', [{ field: 'name', old: null, new: b.name }]),
    ]);
    return json({ id }, 201);
  });

  r.patch('/api/releases/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ ...fields, name: fields.name.optional(), version: z.number().int() }));
    const db = ctx.env.DB;
    const rel = await first(db, 'SELECT * FROM releases WHERE id = ?', ctx.params.id);
    if (!rel) throw notFound('Релиз не найден');
    const { version, ...patch } = b as Row;
    if (patch.status_id) {
      const s = await first(db, `SELECT semantic FROM statuses WHERE id = ? AND entity = 'release'`, patch.status_id);
      if (!s) throw badRequest('Статус не найден');
      if (s.semantic === 'done' && !rel.actual_date && patch.actual_date === undefined) patch.actual_date = nowIso().slice(0, 10);
    }
    const changes = diffFields(rel, patch);
    if (!changes.length) return json({ ok: true, unchanged: true });
    await tx(db, [
      guardVersion(db, 'releases', rel.id, version),
      stmt(db, `UPDATE releases SET ${changes.map((c) => `${c.field} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...changes.map((c) => c.new), nowIso(), rel.id),
      auditStmt(db, user, 'release', rel.id, 'updated', changes),
    ], 'Релиз изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });

  /** Replace release composition. Changing an approved release requires explicit confirmation + reason. */
  r.put('/api/releases/:id/features', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({
      feature_ids: z.array(z.string()).max(500),
      version: z.number().int(),
      confirm_approved_change: z.boolean().optional(),
      reason: z.string().trim().max(500).optional(),
    }));
    const db = ctx.env.DB;
    const rel = await first(db, 'SELECT * FROM releases WHERE id = ?', ctx.params.id);
    if (!rel) throw notFound('Релиз не найден');
    if (rel.approved_at && !b.confirm_approved_change) {
      throw conflict('approved', 'Релиз утверждён. Изменение состава нужно подтвердить и указать причину.');
    }
    if (rel.approved_at && !b.reason) throw badRequest('Укажите причину изменения состава утверждённого релиза');
    const ids = [...new Set(b.feature_ids)];
    if (ids.length) {
      const found = await all(db, `SELECT id, merged_into_id FROM features WHERE id IN (${placeholders(ids.length)})`, ...ids);
      if (found.length !== ids.length || found.some((f) => f.merged_into_id)) throw badRequest('Указаны несуществующие или объединённые задачи');
    }
    const before = (await all(db, 'SELECT feature_id FROM release_features WHERE release_id = ?', rel.id)).map((x) => x.feature_id);
    const added = ids.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !ids.includes(id));
    if (!added.length && !removed.length) return json({ ok: true, unchanged: true });
    const movedFrom = added.length ? await all(db, `SELECT feature_id, release_id FROM release_features WHERE feature_id IN (${placeholders(added.length)})`, ...added) : [];
    const now = nowIso();
    const nums = new Map((await all(db, 'SELECT id, number FROM features')).map((f) => [f.id, `RF-${f.number}`]));
    const st = [guardVersion(db, 'releases', rel.id, b.version)];
    for (const id of removed) st.push(stmt(db, 'DELETE FROM release_features WHERE release_id = ? AND feature_id = ?', rel.id, id));
    for (const m of movedFrom) {
      st.push(stmt(db, 'DELETE FROM release_features WHERE feature_id = ?', m.feature_id));
      st.push(auditStmt(db, user, 'release', m.release_id, 'feature_moved_out', [{ field: 'features', old: nums.get(m.feature_id), new: null }], `Перенесено в «${rel.name}»`));
    }
    for (const id of added) st.push(stmt(db, 'INSERT INTO release_features (release_id, feature_id, added_at, added_by) VALUES (?, ?, ?, ?)', rel.id, id, now, user.id));
    st.push(stmt(db, 'UPDATE releases SET updated_at = ?, version = version + 1 WHERE id = ?', now, rel.id));
    st.push(auditStmt(db, user, 'release', rel.id, 'composition_changed', [
      ...added.map((id) => ({ field: 'features', old: null, new: nums.get(id) })),
      ...removed.map((id) => ({ field: 'features', old: nums.get(id), new: null })),
    ], b.reason ?? null, !!rel.approved_at));
    await tx(db, st, 'Релиз изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });

  r.post('/api/releases/:id/approve', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ version: z.number().int(), approved: z.boolean() }));
    const db = ctx.env.DB;
    const rel = await first(db, 'SELECT * FROM releases WHERE id = ?', ctx.params.id);
    if (!rel) throw notFound('Релиз не найден');
    if (!!rel.approved_at === b.approved) return json({ ok: true, unchanged: true });
    const now = nowIso();
    await tx(db, [
      guardVersion(db, 'releases', rel.id, b.version),
      stmt(db, 'UPDATE releases SET approved_at = ?, approved_by = ?, updated_at = ?, version = version + 1 WHERE id = ?', b.approved ? now : null, b.approved ? user.id : null, now, rel.id),
      auditStmt(db, user, 'release', rel.id, b.approved ? 'approved' : 'unapproved'),
    ], 'Релиз изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });
}

export { bool };

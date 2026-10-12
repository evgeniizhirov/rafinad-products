// Epics and offers.
import { z } from 'zod';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt, diffFields } from '../lib/audit';
import { first, guardVersion, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { canSee, featureDto, indexWorld, loadWorld, showEstimates, viewerOf, type Indexes, type Viewer, type World } from '../lib/world';
import { sortFeatures } from './features';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const visibility = z.enum(['draft', 'internal', 'public']);

const epicFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).optional(),
  category_id: z.string().nullable().optional(),
  owner_name: z.string().trim().max(120).nullable().optional(),
  status_id: z.string().optional(),
  start_date: date,
  end_date: date,
  visibility: visibility.optional(),
  external_ref: z.string().trim().max(100).nullable().optional(),
};

const offerFields = {
  name: z.string().trim().min(1).max(300),
  external_code: z.string().trim().max(100).nullable().optional(),
  description: z.string().max(20000).optional(),
  category_id: z.string().nullable().optional(),
  direction: z.string().trim().max(120).nullable().optional(),
  status_id: z.string().optional(),
  visibility: visibility.optional(),
};

async function checkStatus(ctx: Ctx, entity: string, id?: string) {
  if (id && !(await first(ctx.env.DB, 'SELECT 1 FROM statuses WHERE id = ? AND entity = ?', id, entity))) throw badRequest('Статус не найден');
}
async function checkCategory(ctx: Ctx, id?: string | null) {
  if (id && !(await first(ctx.env.DB, 'SELECT 1 FROM categories WHERE id = ?', id))) throw badRequest('Категория не найдена');
}

/** Epic summary: hours are summed from child features only (no separate epic estimate → no double counting). */
export function epicSummary(epic: Row, viewer: Viewer, w: World, idx: Indexes) {
  const children = w.features.filter((f) => f.epic_id === epic.id && !f.merged_into_id);
  const visibleChildren = children.filter((f) => canSee(viewer, f.visibility));
  const counted = viewer === 'guest' ? visibleChildren : children; // public aggregates never include hidden work
  const active = counted.filter((f) => idx.status.get(f.status_id)?.semantic !== 'cancelled');
  const done = active.filter((f) => idx.status.get(f.status_id)?.semantic === 'done');
  const hours: Record<string, number> = {};
  let totalHours = 0;
  let doneHours = 0;
  for (const f of active) {
    const isDone = idx.status.get(f.status_id)?.semantic === 'done';
    for (const e of idx.estimatesBy.get(f.id) ?? []) {
      hours[e.team_id] = Math.round(((hours[e.team_id] ?? 0) + e.hours) * 10) / 10;
      totalHours += e.hours;
      if (isDone) doneHours += e.hours;
    }
  }
  const withEst = showEstimates(viewer, w);
  return {
    id: epic.id,
    number: epic.number,
    key: `EP-${epic.number}`,
    title: epic.title,
    description: epic.description,
    category: epic.category_id ? { id: epic.category_id, name: idx.category.get(epic.category_id)?.name } : null,
    owner_name: viewer === 'guest' ? undefined : epic.owner_name,
    status: (() => { const s = idx.status.get(epic.status_id); return s ? { id: s.id, name: s.name, semantic: s.semantic, color: s.color } : null; })(),
    start_date: epic.start_date,
    end_date: epic.end_date,
    visibility: viewer === 'guest' ? undefined : epic.visibility,
    external_ref: viewer === 'guest' ? undefined : epic.external_ref,
    version: viewer === 'guest' ? undefined : epic.version,
    feature_count: active.length,
    done_count: done.length,
    progress: active.length ? Math.round((done.length / active.length) * 100) : 0,
    hours: withEst ? hours : undefined,
    total_hours: withEst ? Math.round(totalHours * 10) / 10 : undefined,
    hours_progress: withEst && totalHours ? Math.round((doneHours / totalHours) * 100) : undefined,
    features: sortFeatures(visibleChildren, w, idx, 'priority').map((f) => featureDto(f, viewer, w, idx)),
  };
}

export function offerSummary(o: Row, viewer: Viewer, w: World, idx: Indexes, detail = false) {
  const fids = (idx.featuresByOffer.get(o.id) ?? []).filter((id) => {
    const f = idx.feature.get(id);
    return f && !f.merged_into_id && canSee(viewer, f.visibility);
  });
  const features = fids.map((id) => idx.feature.get(id)!);
  const releaseIds = [...new Set(features.map((f) => idx.releaseOf.get(f.id)).filter((x): x is string => !!x))];
  const releases = releaseIds
    .map((id) => idx.release.get(id)!)
    .filter((r) => r && canSee(viewer, r.visibility))
    .map((r) => ({ id: r.id, name: r.name, version_label: r.version_label, planned_date: r.planned_date, status: idx.status.get(r.status_id)?.name, approved: !!r.approved_at }));
  const s = idx.status.get(o.status_id);
  return {
    id: o.id,
    external_code: o.external_code,
    name: o.name,
    description: detail ? o.description : (o.description || '').slice(0, 200),
    category: o.category_id ? { id: o.category_id, name: idx.category.get(o.category_id)?.name } : null,
    direction: o.direction,
    status: s ? { id: s.id, name: s.name, semantic: s.semantic, color: s.color } : null,
    visibility: viewer === 'guest' ? undefined : o.visibility,
    version: viewer === 'guest' ? undefined : o.version,
    feature_count: features.length,
    open_feature_count: features.filter((f) => !['done', 'cancelled'].includes(idx.status.get(f.status_id)?.semantic)).length,
    releases,
    features: detail ? sortFeatures(features, w, idx, 'priority').map((f) => featureDto(f, viewer, w, idx)) : undefined,
  };
}

async function nextNumber(ctx: Ctx, table: 'epics') {
  return ((await first<{ n: number }>(ctx.env.DB, `SELECT COALESCE(MAX(number), 0) + 1 AS n FROM ${table}`))?.n ?? 1);
}

export function registerCatalogRoutes(r: Router) {
  // ───── epics ─────
  r.get('/api/epics', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    const epics = w.epics.filter((e) => canSee(viewer, e.visibility)).map((e) => epicSummary(e, viewer, w, idx));
    const orphan = w.features.filter((f) => !f.epic_id && !f.merged_into_id && canSee(viewer, f.visibility));
    return json({ epics, without_epic: sortFeatures(orphan, w, idx, 'priority').map((f) => featureDto(f, viewer, w, idx)) });
  });

  r.get('/api/epics/:id', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    const e = w.epics.find((x) => x.id === ctx.params.id || `ep-${x.number}` === ctx.params.id.toLowerCase());
    if (!e || !canSee(viewer, e.visibility)) throw notFound('Эпик не найден');
    return json({ epic: epicSummary(e, viewer, w, idx) });
  });

  r.post('/api/epics', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object(epicFields));
    await checkStatus(ctx, 'epic', b.status_id);
    await checkCategory(ctx, b.category_id);
    const db = ctx.env.DB;
    const id = newId('e');
    const now = nowIso();
    const num = await nextNumber(ctx, 'epics');
    await tx(db, [
      stmt(db, `INSERT INTO epics (id, number, external_ref, title, description, category_id, owner_name, status_id, start_date, end_date, visibility, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, num, b.external_ref ?? null, b.title, b.description ?? '', b.category_id ?? null, b.owner_name ?? null, b.status_id ?? 'st_e_new',
        b.start_date ?? null, b.end_date ?? null, b.visibility ?? 'internal', now, now, user.id),
      auditStmt(db, user, 'epic', id, 'created', [{ field: 'title', old: null, new: b.title }]),
    ]);
    return json({ id, number: num }, 201);
  });

  r.patch('/api/epics/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({ ...epicFields, title: epicFields.title.optional(), version: z.number().int() }));
    await checkStatus(ctx, 'epic', b.status_id);
    await checkCategory(ctx, b.category_id);
    const db = ctx.env.DB;
    const e = await first(db, 'SELECT * FROM epics WHERE id = ?', ctx.params.id);
    if (!e) throw notFound('Эпик не найден');
    const { version, ...patch } = b;
    const changes = diffFields(e, patch);
    if (!changes.length) return json({ ok: true, unchanged: true });
    await tx(db, [
      guardVersion(db, 'epics', e.id, version),
      stmt(db, `UPDATE epics SET ${changes.map((c) => `${c.field} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...changes.map((c) => c.new), nowIso(), e.id),
      auditStmt(db, user, 'epic', e.id, 'updated', changes),
    ], 'Эпик изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });

  // ───── offers ─────
  r.get('/api/offers', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    return json({ offers: w.offers.filter((o) => canSee(viewer, o.visibility)).map((o) => offerSummary(o, viewer, w, idx)) });
  });

  r.get('/api/offers/:id', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    const o = idx.offer.get(ctx.params.id);
    if (!o || !canSee(viewer, o.visibility)) throw notFound('Оффер не найден');
    return json({ offer: offerSummary(o, viewer, w, idx, true) });
  });

  r.post('/api/offers', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object(offerFields));
    await checkStatus(ctx, 'offer', b.status_id);
    await checkCategory(ctx, b.category_id);
    const db = ctx.env.DB;
    if (b.external_code && (await first(db, 'SELECT 1 FROM offers WHERE external_code = ?', b.external_code))) throw conflict('exists', 'Оффер с таким внешним ID уже есть');
    const id = newId('o');
    const now = nowIso();
    await tx(db, [
      stmt(db, `INSERT INTO offers (id, external_code, name, description, category_id, direction, status_id, visibility, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, b.external_code ?? null, b.name, b.description ?? '', b.category_id ?? null, b.direction ?? null, b.status_id ?? 'st_o_active', b.visibility ?? 'internal', now, now, user.id),
      auditStmt(db, user, 'offer', id, 'created', [{ field: 'name', old: null, new: b.name }]),
    ]);
    return json({ id }, 201);
  });

  r.patch('/api/offers/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({ ...offerFields, name: offerFields.name.optional(), version: z.number().int() }));
    await checkStatus(ctx, 'offer', b.status_id);
    await checkCategory(ctx, b.category_id);
    const db = ctx.env.DB;
    const o = await first(db, 'SELECT * FROM offers WHERE id = ?', ctx.params.id);
    if (!o) throw notFound('Оффер не найден');
    const { version, ...patch } = b;
    const changes = diffFields(o, patch);
    if (!changes.length) return json({ ok: true, unchanged: true });
    await tx(db, [
      guardVersion(db, 'offers', o.id, version),
      stmt(db, `UPDATE offers SET ${changes.map((c) => `${c.field} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...changes.map((c) => c.new), nowIso(), o.id),
      auditStmt(db, user, 'offer', o.id, 'updated', changes),
    ], 'Оффер изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });
}

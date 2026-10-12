import { z } from 'zod';
import { cyclePathIfAdded, type Edge } from '../domain/graph';
import { compareByPriority } from '../domain/priority';
import { capacityKey, overloadIfAdded } from '../domain/capacity';
import { FEATURE_LOCKED_SQL, planAlertIfStmt } from '../lib/alerts';
import { perms, requirePerm, requireUser } from '../lib/auth';
import { auditStmt, diffFields, type Change } from '../lib/audit';
import { all, bool, first, guardVersion, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { canSeeFeature, featureDto, featureRef, FLAG_LABELS, hasFlag, indexWorld, isClosed, isPlannable, isProductInternal, loadWorld, matchesInitiator, TASK_KINDS, viewerOf, visibleFeatures, type FeatureFlag, type World } from '../lib/world';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД').nullable().optional();
const visibility = z.enum(['draft', 'internal', 'public']);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

const featureFields = {
  title: z.string().trim().min(1, 'Укажите название').max(300),
  description: z.string().max(20000).optional(),
  category_id: z.string().nullable().optional(),
  epic_id: z.string().nullable().optional(),
  status_id: z.string().optional(),
  stage_id: z.string().nullable().optional(),
  author_name: optText(120),
  assignee_name: optText(120),
  requested_at: date,
  planned_start: date,
  planned_end: date,
  visibility: visibility.optional(),
  external_ref: optText(100),
  private_notes: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  offer_ids: z.array(z.string()).max(100).optional(),
  task_kind: z.enum(TASK_KINDS).optional(),
  is_product_internal: z.boolean().optional(),
  /** null clears the initiator */
  initiator: z.discriminatedUnion('type', [
    z.object({ type: z.literal('free_text'), name: z.string().trim().min(1, 'Укажите имя инициатора').max(120) }),
    z.object({ type: z.literal('user'), user_id: z.string().min(1) }),
    z.object({ type: z.literal('department'), department_id: z.string().min(1) }),
  ]).nullable().optional(),
};

type InitiatorInput = z.infer<typeof featureFields.initiator>;

/** initiator → the four stored columns (with a name snapshot); validates the referenced user / department */
async function initiatorColumns(ctx: Ctx, i: InitiatorInput): Promise<Row | undefined> {
  if (i === undefined) return undefined;
  if (i === null) return { initiator_type: null, initiator_user_id: null, initiator_department_id: null, initiator_name: null };
  if (i.type === 'free_text') return { initiator_type: 'free_text', initiator_user_id: null, initiator_department_id: null, initiator_name: i.name };
  if (i.type === 'user') {
    const u = await first(ctx.env.DB, 'SELECT id, name FROM users WHERE id = ?', i.user_id);
    if (!u) throw badRequest('Пользователь-инициатор не найден');
    return { initiator_type: 'user', initiator_user_id: u.id, initiator_department_id: null, initiator_name: u.name };
  }
  const d = await first(ctx.env.DB, 'SELECT id, name FROM departments WHERE id = ?', i.department_id);
  if (!d) throw badRequest('Отдел-инициатор не найден');
  return { initiator_type: 'department', initiator_user_id: null, initiator_department_id: d.id, initiator_name: d.name };
}
const createSchema = z.object({ ...featureFields, estimates: z.record(z.string(), z.number().min(0).max(100000)).optional() });
const patchSchema = z.object({
  ...featureFields,
  title: featureFields.title.optional(),
  version: z.number().int(),
  /** required to turn a hidden Product task into a general one (it becomes visible to other departments) */
  confirm_disclose: z.boolean().optional(),
});

export async function resolveFeature(ctx: Ctx, ref: string): Promise<Row> {
  const m = /^(?:rf-)?(\d+)$/i.exec(ref);
  const f = m ? await first(ctx.env.DB, 'SELECT * FROM features WHERE number = ?', Number(m[1])) : await first(ctx.env.DB, 'SELECT * FROM features WHERE id = ?', ref);
  // hidden Product tasks do not exist for anyone else: same 404 as a missing id
  if (!f || (isProductInternal(f) && viewerOf(ctx.user) !== 'editor')) throw notFound('Задача не найдена');
  return f;
}

async function validateRefs(ctx: Ctx, b: Record<string, any>) {
  const db = ctx.env.DB;
  const checks: [string | null | undefined, string, string][] = [
    [b.category_id, 'SELECT 1 FROM categories WHERE id = ?', 'Категория не найдена'],
    [b.epic_id, 'SELECT 1 FROM epics WHERE id = ?', 'Эпик не найден'],
    [b.stage_id, 'SELECT 1 FROM stages WHERE id = ?', 'Этап не найден'],
  ];
  for (const [v, sql, msg] of checks) if (v && !(await first(db, sql, v))) throw badRequest(msg);
  if (b.status_id && !(await first(db, `SELECT 1 FROM statuses WHERE id = ? AND entity = 'feature'`, b.status_id))) throw badRequest('Статус не найден');
  if (b.offer_ids?.length) {
    for (const id of b.offer_ids) if (!(await first(db, 'SELECT 1 FROM offers WHERE id = ?', id))) throw badRequest('Оффер не найден');
  }
  if (b.estimates) {
    for (const t of Object.keys(b.estimates)) if (!(await first(db, 'SELECT 1 FROM resource_teams WHERE id = ?', t))) throw badRequest('Ресурсная команда не найдена');
  }
}

const db0 = (ctx: Ctx) => ctx.env.DB;

async function semanticOf(ctx: Ctx, statusId: string): Promise<string | null> {
  return (await first<{ semantic: string }>(ctx.env.DB, 'SELECT semantic FROM statuses WHERE id = ?', statusId))?.semantic ?? null;
}

/** closed_at follows the status: set when entering "done", cleared when the work is reopened (history keeps the old value) */
function closedAtFor(prevSemantic: string | null, nextSemantic: string | null, prevClosed: string | null): string | null {
  if (nextSemantic === 'done') return prevSemantic === 'done' && prevClosed ? prevClosed : nowIso().slice(0, 10);
  return null;
}

export function sortFeatures(rows: Row[], w: World, idx: ReturnType<typeof indexWorld>, sort: string) {
  const pr = (f: Row) => ({ ...idx.priority.get(f.id)!, createdAt: f.created_at, number: f.number });
  const cmp: Record<string, (a: Row, b: Row) => number> = {
    priority: (a, b) => compareByPriority(pr(a), pr(b)),
    number: (a, b) => a.number - b.number,
    newest: (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.number - a.number),
    title: (a, b) => a.title.localeCompare(b.title, 'ru') || a.number - b.number,
    status: (a, b) => (idx.status.get(a.status_id)?.sort_order ?? 0) - (idx.status.get(b.status_id)?.sort_order ?? 0) || a.number - b.number,
  };
  return rows.slice().sort(cmp[sort] ?? cmp.priority);
}

export function registerFeatureRoutes(r: Router) {
  r.get('/api/features', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer, { includeInternal: true });
    const idx = indexWorld(w);
    const p = ctx.url.searchParams;
    const q = (p.get('q') || '').trim().toLowerCase();
    const scope = viewer === 'editor' ? ({ '1': 'internal', only: 'internal', all: 'all' } as const)[p.get('internal') ?? ''] ?? 'general' : 'general';
    let rows = visibleFeatures(w, viewer, scope);
    const filt = (key: string, fn: (f: Row, v: string) => boolean) => {
      const vals = p.getAll(key).flatMap((v) => v.split(',')).filter(Boolean);
      if (vals.length) rows = rows.filter((f) => vals.some((v) => fn(f, v)));
    };
    filt('status', (f, v) => f.status_id === v || idx.status.get(f.status_id)?.semantic === v);
    filt('category', (f, v) => f.category_id === v);
    filt('epic', (f, v) => (v === 'none' ? !f.epic_id : f.epic_id === v));
    filt('department', (f, v) => (idx.votesBy.get(f.id) ?? []).some((x) => x.department_id === v));
    filt('offer', (f, v) => (idx.offersByFeature.get(f.id) ?? []).includes(v));
    filt('release', (f, v) => (v === 'none' ? !idx.releaseOf.has(f.id) : idx.releaseOf.get(f.id) === v));
    filt('period', (f, v) => (v === 'none' ? !f.period_id : f.period_id === v));
    filt('stage', (f, v) => f.stage_id === v);
    filt('kind', (f, v) => (f.task_kind ?? 'planned') === v);
    if (viewer !== 'guest') filt('initiator', (f, v) => matchesInitiator(f, w, v));
    if (viewer !== 'guest') filt('visibility', (f, v) => f.visibility === v);
    if (q) {
      rows = rows.filter((f) =>
        `rf-${f.number} ${f.title} ${f.description} ${(idx.tagsBy.get(f.id) ?? []).join(' ')} ${viewer !== 'guest' ? f.external_ref ?? '' : ''}`.toLowerCase().includes(q),
      );
    }
    if (p.get('hide_closed') === '1') rows = rows.filter((f) => !isClosed(f, idx));
    const flag = p.get('flag') as FeatureFlag | null;
    if (flag && flag in FLAG_LABELS) rows = rows.filter((f) => hasFlag(flag, f, w, idx));
    const tag = (p.get('tag') || '').trim().toLowerCase();
    if (tag) rows = rows.filter((f) => (idx.tagsBy.get(f.id) ?? []).some((t) => t.toLowerCase() === tag));
    rows = sortFeatures(rows, w, idx, p.get('sort') || 'priority');
    return json({ features: rows.map((f) => featureDto(f, viewer, w, idx)), total: rows.length });
  });

  r.get('/api/features/:ref', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const f0 = await resolveFeature(ctx, ctx.params.ref);
    const w = await loadWorld(ctx.env.DB, viewer, { includeInternal: true });
    const idx = indexWorld(w);
    let f = idx.feature.get(f0.id)!;
    let mergedFrom: Row | null = null;
    let guard = 0;
    while (f.merged_into_id && guard++ < 20) {
      mergedFrom = mergedFrom ?? f;
      f = idx.feature.get(f.merged_into_id)!;
    }
    if (!canSeeFeature(viewer, f)) throw notFound('Задача не найдена');
    const dto = featureDto(f, viewer, w, idx, { detail: true }) as Record<string, unknown>;
    if (mergedFrom) dto.merged_from = { id: mergedFrom.id, key: `RF-${mergedFrom.number}` };
    if (viewer !== 'guest') {
      dto.comments = await all(ctx.env.DB, 'SELECT id, author_name, body, created_at, moved_from FROM comments WHERE feature_id = ? ORDER BY created_at', f.id);
      const mergedIds = w.features.filter((x) => x.merged_into_id === f.id).map((x) => x.id);
      dto.merged_duplicates = w.features.filter((x) => x.merged_into_id === f.id).map((x) => ({ id: x.id, key: `RF-${x.number}`, title: x.title }));
      const ids = [f.id, ...mergedIds];
      dto.history = await all(
        ctx.env.DB,
        `SELECT id, at, actor_name, action, changes, reason, is_override, entity_id FROM audit_log
         WHERE entity_type IN ('feature','vote','estimate','placement','relation','comment') AND entity_id IN (${ids.map(() => '?').join(',')})
         ORDER BY id DESC LIMIT 300`,
        ...ids,
      ).then((rows) => rows.map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null, is_override: !!h.is_override })));
      if (viewer !== 'editor') {
        // relation history must not reveal hidden Product tasks (their ids live in the change records)
        const hiddenIds = (await all(ctx.env.DB, 'SELECT id FROM features WHERE is_product_internal = 1')).map((x) => x.id as string);
        if (hiddenIds.length) {
          dto.history = (dto.history as Row[]).filter((h) => h.action !== 'relation_added' && h.action !== 'relation_removed' ? true : !hiddenIds.some((hid) => JSON.stringify(h.changes ?? '').includes(hid)));
        }
      }
      if (viewer === 'editor') {
        dto.sources = await all(
          ctx.env.DB,
          `SELECT l.external_id, l.updated_at, s.name AS source_name, s.id AS source_id FROM source_entity_links l JOIN sheet_sources s ON s.id = l.source_id
           WHERE l.entity_type = 'feature' AND l.entity_id IN (${ids.map(() => '?').join(',')})`,
          ...ids,
        );
      }
    }
    return json({ feature: dto });
  });

  r.post('/api/features', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, createSchema);
    await validateRefs(ctx, b);
    const initiator = (await initiatorColumns(ctx, b.initiator)) ?? { initiator_type: null, initiator_user_id: null, initiator_department_id: null, initiator_name: null };
    const kind = b.task_kind ?? 'planned';
    const internal = b.is_product_internal ? 1 : 0;
    const db = ctx.env.DB;
    const statusId = b.status_id ?? 'st_f_new';
    const sem = await semanticOf(ctx, statusId);
    const id = newId('f');
    const now = nowIso();
    for (let attempt = 0; attempt < 3; attempt++) {
      const num = ((await first<{ n: number }>(db, 'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM features'))?.n ?? 1);
      const statements = [
        stmt(db, `INSERT INTO features (id, number, external_ref, title, description, category_id, epic_id, status_id, stage_id, author_name, assignee_name,
            requested_at, planned_start, planned_end, closed_at, visibility, private_notes, created_at, updated_at, created_by, updated_by,
            task_kind, is_product_internal, initiator_type, initiator_user_id, initiator_department_id, initiator_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, num, b.external_ref ?? null, b.title, b.description ?? '', b.category_id ?? null, b.epic_id ?? null, statusId, b.stage_id ?? null,
          b.author_name ?? user.name, b.assignee_name ?? null, b.requested_at ?? now.slice(0, 10), b.planned_start ?? null, b.planned_end ?? null,
          sem === 'done' ? now.slice(0, 10) : null, b.visibility ?? 'internal', b.private_notes ?? null, now, now, user.id, user.id,
          kind, internal, initiator.initiator_type, initiator.initiator_user_id, initiator.initiator_department_id, initiator.initiator_name),
        ...[...new Set(b.tags ?? [])].map((t) => stmt(db, 'INSERT INTO feature_tags (feature_id, tag) VALUES (?, ?)', id, t)),
        ...[...new Set(b.offer_ids ?? [])].map((o) => stmt(db, 'INSERT INTO feature_offers (feature_id, offer_id, created_at, created_by) VALUES (?, ?, ?, ?)', id, o, now, user.id)),
        ...Object.entries(b.estimates ?? {}).map(([t, h]) => stmt(db, 'INSERT INTO feature_estimates (feature_id, team_id, hours, is_manual, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)', id, t, h, now, user.id)),
        auditStmt(db, user, 'feature', id, 'created', [
          { field: 'title', old: null, new: b.title },
          ...(kind !== 'planned' ? [{ field: 'task_kind', old: null, new: kind }] : []),
          ...(internal ? [{ field: 'is_product_internal', old: null, new: 1 }] : []),
          ...(initiator.initiator_type ? [{ field: 'initiator', old: null, new: initiator.initiator_name }] : []),
        ]),
      ];
      try {
        await tx(db, statements);
        return json({ id, number: num, key: `RF-${num}` }, 201);
      } catch (e) {
        if ((e as { code?: string }).code === 'unique_violation' && attempt < 2) continue;
        throw e;
      }
    }
    throw conflict('retry', 'Не удалось создать задачу, повторите попытку');
  });

  r.patch('/api/features/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, patchSchema);
    const f = await resolveFeature(ctx, ctx.params.id);
    if (f.merged_into_id) throw conflict('merged', 'Карточка объединена с другой — редактируйте основную');
    await validateRefs(ctx, b);
    const db = ctx.env.DB;
    const { version, tags, offer_ids, initiator, is_product_internal, confirm_disclose, ...fields } = b;
    const patch: Row = { ...fields, ...(await initiatorColumns(ctx, initiator)) };
    if (is_product_internal !== undefined) patch.is_product_internal = is_product_internal ? 1 : 0;
    const wasInternal = isProductInternal(f);
    if (wasInternal && patch.is_product_internal === 0 && !confirm_disclose) {
      throw conflict('confirm_disclose', 'Задача станет видна другим отделам (и гостям, если она опубликована). Подтвердите раскрытие.');
    }
    const inRelease = await first(db0(ctx), 'SELECT release_id FROM release_features WHERE feature_id = ?', f.id);
    if (inRelease && !wasInternal && patch.is_product_internal === 1) throw badRequest('Задача входит в релиз: сначала уберите её из релиза');
    if (inRelease && fields.task_kind && fields.task_kind !== 'planned' && (f.task_kind ?? 'planned') === 'planned') {
      throw badRequest('Задача входит в релиз: баг или оперативная доработка не может быть в составе релиза');
    }
    if (fields.status_id && fields.status_id !== f.status_id) {
      const prevSem = await semanticOf(ctx, f.status_id);
      const nextSem = await semanticOf(ctx, fields.status_id);
      patch.closed_at = closedAtFor(prevSem, nextSem, f.closed_at);
    }
    const changes: Change[] = diffFields(f, patch);
    const statements = [guardVersion(db, 'features', f.id, version)];
    if (changes.length) {
      statements.push(stmt(db, `UPDATE features SET ${changes.map((c) => `${c.field} = ?`).join(', ')}, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
        ...changes.map((c) => c.new), nowIso(), user.id, f.id));
    }
    if (tags) {
      const before = (await all(db, 'SELECT tag FROM feature_tags WHERE feature_id = ? ORDER BY tag', f.id)).map((t) => t.tag);
      const after = [...new Set(tags)].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field: 'tags', old: before, new: after });
        statements.push(stmt(db, 'DELETE FROM feature_tags WHERE feature_id = ?', f.id));
        for (const t of after) statements.push(stmt(db, 'INSERT INTO feature_tags (feature_id, tag) VALUES (?, ?)', f.id, t));
      }
    }
    if (offer_ids) {
      const before = (await all(db, 'SELECT offer_id FROM feature_offers WHERE feature_id = ? ORDER BY offer_id', f.id)).map((t) => t.offer_id);
      const after = [...new Set(offer_ids)].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field: 'offers', old: before, new: after });
        const now = nowIso();
        for (const o of before.filter((x) => !after.includes(x))) statements.push(stmt(db, 'DELETE FROM feature_offers WHERE feature_id = ? AND offer_id = ?', f.id, o));
        for (const o of after.filter((x) => !before.includes(x))) statements.push(stmt(db, 'INSERT INTO feature_offers (feature_id, offer_id, created_at, created_by) VALUES (?, ?, ?, ?)', f.id, o, now, user.id));
      }
    }
    if (!changes.length) return json({ ok: true, unchanged: true, version: f.version });
    if (!changes.some((c) => !['tags', 'offers'].includes(c.field))) {
      statements.push(stmt(db, 'UPDATE features SET updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', nowIso(), user.id, f.id));
    }
    statements.push(auditStmt(db, user, 'feature', f.id, 'updated', changes));
    await tx(db, statements, 'Карточку изменил другой пользователь. Обновите данные — ваши изменения не сохранены.');
    return json({ ok: true, version: f.version + 1 });
  });

  // ───── estimates (hours per resource team) ─────
  r.put('/api/features/:id/estimates', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({
      estimates: z.record(z.string(), z.number().min(0).max(100000).nullable()),
      versions: z.record(z.string(), z.number().int().nullable()).default({}),
    }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const db = ctx.env.DB;
    const current = new Map((await all(db, 'SELECT * FROM feature_estimates WHERE feature_id = ?', f.id)).map((e) => [e.team_id, e]));
    const teams = new Map((await all(db, 'SELECT id, name FROM resource_teams')).map((t) => [t.id, t.name]));
    const statements = [];
    const changes: Change[] = [];
    const now = nowIso();
    for (const [teamId, hours] of Object.entries(b.estimates)) {
      if (!teams.has(teamId)) throw badRequest('Ресурсная команда не найдена');
      const cur = current.get(teamId);
      const expected = b.versions[teamId] ?? null;
      // optimistic locking per estimate: the client sends the version it saw (null = it saw "not estimated")
      if (cur && expected !== cur.version) throw conflict('version_conflict', `Оценку «${teams.get(teamId)}» уже изменил другой пользователь. Обновите карточку.`, { team_id: teamId, current: cur.hours });
      if (!cur && expected !== null) throw conflict('version_conflict', `Оценку «${teams.get(teamId)}» уже удалил другой пользователь. Обновите карточку.`, { team_id: teamId, current: null });
      if (hours === null) {
        if (cur) {
          statements.push(stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'est' WHERE NOT EXISTS (SELECT 1 FROM feature_estimates WHERE feature_id = ? AND team_id = ? AND version = ?)`, f.id, teamId, cur.version));
          statements.push(stmt(db, 'DELETE FROM feature_estimates WHERE feature_id = ? AND team_id = ?', f.id, teamId));
          changes.push({ field: `hours:${teams.get(teamId)}`, old: cur.hours, new: null });
        }
        continue;
      }
      if (cur && cur.hours === hours && cur.is_manual) continue;
      if (cur) {
        statements.push(stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'est' WHERE NOT EXISTS (SELECT 1 FROM feature_estimates WHERE feature_id = ? AND team_id = ? AND version = ?)`, f.id, teamId, cur.version));
        statements.push(stmt(db, 'UPDATE feature_estimates SET hours = ?, is_manual = 1, updated_at = ?, updated_by = ?, version = version + 1 WHERE feature_id = ? AND team_id = ?', hours, now, user.id, f.id, teamId));
      } else {
        statements.push(stmt(db, 'INSERT INTO feature_estimates (feature_id, team_id, hours, is_manual, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)', f.id, teamId, hours, now, user.id));
      }
      if (!cur || cur.hours !== hours) changes.push({ field: `hours:${teams.get(teamId)}`, old: cur?.hours ?? null, new: hours });
    }
    if (!statements.length) return json({ ok: true, unchanged: true });
    statements.push(stmt(db, 'UPDATE features SET updated_at = ?, updated_by = ? WHERE id = ?', now, user.id, f.id));
    if (changes.length) {
      statements.push(auditStmt(db, user, 'estimate', f.id, 'estimates_changed', changes));
      statements.push(planAlertIfStmt(db, 'estimate_changed', `Изменена оценка трудозатрат утверждённой задачи RF-${f.number}`, 'feature', f.id, FEATURE_LOCKED_SQL, f.id));
    }
    await tx(db, statements, 'Оценку изменил другой пользователь. Обновите карточку.');
    return json({ ok: true });
  });

  // ───── placement into a planning period (with overload confirmation) ─────
  r.patch('/api/features/:id/placement', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({
      period_id: z.string().nullable(),
      version: z.number().int(),
      lock: z.boolean().optional(),
      confirm_overload: z.boolean().optional(),
      reason: z.string().trim().max(500).optional(),
    }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const db = ctx.env.DB;
    if (b.period_id && !isPlannable(f)) throw badRequest('Баги, оперативные доработки и внутренние задачи продукта не размещаются в плановых периодах');
    if (b.period_id && !(await first(db, 'SELECT 1 FROM capacity_periods WHERE id = ?', b.period_id))) throw badRequest('Период не найден');
    const overload = b.period_id && b.period_id !== f.period_id ? await overloadFor(ctx, f.id, b.period_id) : [];
    if (overload.length && !b.confirm_overload) {
      throw conflict('overload', 'Перенос превышает доступные часы команды. Подтвердите с указанием причины.', { overload });
    }
    if (overload.length && !b.reason) throw badRequest('Укажите причину превышения лимита');
    const patch: Row = { period_id: b.period_id, placement_locked: b.lock === undefined ? (b.period_id ? f.placement_locked : 0) : b.lock ? 1 : 0 };
    const changes = diffFields(f, patch);
    if (!changes.length) return json({ ok: true, unchanged: true });
    await tx(db, [
      guardVersion(db, 'features', f.id, b.version),
      stmt(db, `UPDATE features SET ${changes.map((c) => `${c.field} = ?`).join(', ')}, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`, ...changes.map((c) => c.new), nowIso(), user.id, f.id),
      auditStmt(db, user, 'placement', f.id, overload.length ? 'moved_over_capacity' : 'moved', changes, b.reason ?? null, overload.length > 0),
    ], 'Карточку изменил другой пользователь. Обновите план.');
    return json({ ok: true, overload });
  });

  // ───── relations ─────
  r.post('/api/features/:id/relations', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({ type: z.enum(['blocks', 'blocked_by', 'related_to', 'duplicate_of']), target_id: z.string() }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const t = await resolveFeature(ctx, b.target_id);
    if (f.merged_into_id || t.merged_into_id) throw badRequest('Нельзя связывать объединённые карточки');
    if (f.id === t.id) throw badRequest('Нельзя связать задачу саму с собой');
    const db = ctx.env.DB;
    const type = b.type === 'blocked_by' ? 'blocks' : b.type;
    const [from, to] = b.type === 'blocked_by' ? [t.id, f.id] : [f.id, t.id];
    const existing = await all(db, 'SELECT type, from_id, to_id FROM feature_relations');
    if (type === 'related_to' && existing.some((x) => x.type === 'related_to' && ((x.from_id === from && x.to_id === to) || (x.from_id === to && x.to_id === from)))) {
      throw conflict('exists', 'Такая связь уже есть');
    }
    if (existing.some((x) => x.type === type && x.from_id === from && x.to_id === to)) throw conflict('exists', 'Такая связь уже есть');
    if (type === 'blocks') {
      const edges: Edge[] = existing.filter((x) => x.type === 'blocks').map((x) => [x.from_id, x.to_id]);
      const cycle = cyclePathIfAdded(edges, from, to);
      if (cycle) {
        const nums = new Map((await all(db, 'SELECT id, number FROM features')).map((x) => [x.id, x.number]));
        throw conflict('cycle', `Связь создаёт циклическую зависимость: ${cycle.map((id) => `RF-${nums.get(id)}`).join(' → ')}`, { cycle });
      }
    }
    const id = newId('rel');
    await tx(db, [
      stmt(db, 'INSERT INTO feature_relations (id, type, from_id, to_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', id, type, from, to, nowIso(), user.id),
      auditStmt(db, user, 'relation', from, 'relation_added', [{ field: type, old: null, new: to }]),
      auditStmt(db, user, 'relation', to, 'relation_added', [{ field: type, old: null, new: from }]),
    ]);
    return json({ id }, 201);
  });

  r.delete('/api/relations/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const db = ctx.env.DB;
    const rel = await first(db, 'SELECT * FROM feature_relations WHERE id = ?', ctx.params.id);
    if (!rel) throw notFound('Связь не найдена');
    await tx(db, [
      stmt(db, 'DELETE FROM feature_relations WHERE id = ?', rel.id),
      auditStmt(db, user, 'relation', rel.from_id, 'relation_removed', [{ field: rel.type, old: rel.to_id, new: null }]),
      auditStmt(db, user, 'relation', rel.to_id, 'relation_removed', [{ field: rel.type, old: rel.from_id, new: null }]),
    ]);
    return json({ ok: true });
  });

  // ───── comments ─────
  r.post('/api/features/:id/comments', async (ctx) => {
    const user = requirePerm(ctx, perms.comment);
    const b = await readJson(ctx, z.object({ body: z.string().trim().min(1, 'Пустой комментарий').max(5000) }));
    const f = await resolveFeature(ctx, ctx.params.id);
    if (f.visibility === 'draft' && !perms.seeDrafts(user)) throw forbidden();
    const id = newId('c');
    const db = ctx.env.DB;
    await tx(db, [
      stmt(db, 'INSERT INTO comments (id, feature_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, f.merged_into_id ?? f.id, user.id, user.name, b.body, nowIso()),
      auditStmt(db, user, 'comment', f.id, 'comment_added'),
    ]);
    return json({ id }, 201);
  });

  // ───── dependency graph ─────
  r.get('/api/graph', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const visible = new Set(visibleFeatures(w, viewer).map((f) => f.id));
    const edges = w.relations.filter((r) => r.type === 'blocks' && idx.feature.has(r.from_id) && idx.feature.has(r.to_id));
    const nodeIds = new Set<string>();
    for (const e of edges) {
      nodeIds.add(e.from_id);
      nodeIds.add(e.to_id);
    }
    // hidden nodes are anonymised; their ids are replaced so nothing can be looked up
    const anon = new Map<string, string>();
    let n = 0;
    const nodeId = (id: string) => (visible.has(id) ? id : anon.get(id) ?? (anon.set(id, `hidden-${++n}`), anon.get(id)!));
    const nodes = [...nodeIds].map((id) => {
      const f = idx.feature.get(id)!;
      if (!visible.has(id)) return { id: nodeId(id), hidden: true };
      return { ...featureRef(f, viewer, idx), id, period_id: f.period_id, epic_id: f.epic_id, priority: idx.priority.get(id)?.score ?? null };
    });
    return json({ nodes, edges: edges.map((e) => ({ id: viewer === 'editor' ? e.id : undefined, from: nodeId(e.from_id), to: nodeId(e.to_id) })) });
  });
}

/** overload of every team if `featureId` is moved into `periodId` */
export async function overloadFor(ctx: Ctx, featureId: string, periodId: string) {
  const db = ctx.env.DB;
  const est = await all(db, 'SELECT team_id, hours FROM feature_estimates WHERE feature_id = ?', featureId);
  const caps = new Map((await all(db, 'SELECT team_id, hours FROM team_capacities WHERE period_id = ?', periodId)).map((c) => [capacityKey(periodId, c.team_id), c.hours]));
  const planned = new Map(
    (await all(db, `SELECT e.team_id, SUM(e.hours) AS h FROM feature_estimates e JOIN features f ON f.id = e.feature_id
       WHERE f.period_id = ? AND f.id <> ? AND f.merged_into_id IS NULL AND f.task_kind = 'planned' AND f.is_product_internal = 0 GROUP BY e.team_id`, periodId, featureId)).map((p) => [capacityKey(periodId, p.team_id), p.h]),
  );
  const teams = new Map((await all(db, 'SELECT id, name FROM resource_teams')).map((t) => [t.id, t.name]));
  return overloadIfAdded(periodId, Object.fromEntries(est.map((e) => [e.team_id, e.hours])), caps, planned).map((o) => ({ ...o, team_name: teams.get(o.teamId) }));
}

export { bool };

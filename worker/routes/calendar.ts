// Calendar: releases of two sprints, accounting months, generator (FR-06), task schedule (release → sprint → production date).
import { z } from 'zod';
import { baselineStatements } from './phases';
import { autoPlanStatements } from './proposals';
import { planGeneration, validateAnchor, type CalendarAnchor } from '../domain/calendar';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt, type Change } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { all, bool, first, guardVersion, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { canSee, featureDto, indexWorld, isClosed, isPlannable, isProductInternal, loadWorld, viewerOf, visibleFeatures, type Indexes, type Viewer, type World } from '../lib/world';
import { budgetImpact } from './budget';
import { resolveFeature, sortFeatures } from './features';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

export function anchorOf(settings: Record<string, string>): CalendarAnchor {
  return { date: settings.calendar_anchor_date || '2026-10-07', release: Number(settings.calendar_anchor_release || 8) };
}

const today = () => new Date().toISOString().slice(0, 10);

async function existingCalendar(ctx: Ctx) {
  const db = ctx.env.DB;
  return {
    releases: (await all(db, 'SELECT id, cycle_number, name FROM releases')) as { id: string; cycle_number: number | null; name: string }[],
    sprints: (await all(db, 'SELECT id, code, release_id, start_date, end_date FROM sprints')) as { id: string; code: string; release_id: string; start_date: string; end_date: string }[],
    months: (await all(db, 'SELECT month FROM accounting_months')) as { month: string }[],
  };
}

async function generationPlan(ctx: Ctx, b: { releases_ahead?: number; months_ahead?: number; today?: string }) {
  const settings = Object.fromEntries((await all(ctx.env.DB, 'SELECT key, value FROM app_settings')).map((s) => [s.key, s.value]));
  const anchor = anchorOf(settings);
  const err = validateAnchor(anchor);
  if (err) throw badRequest(err);
  const plan = planGeneration(anchor, await existingCalendar(ctx), {
    today: b.today ?? today(),
    releasesAhead: b.releases_ahead ?? Number(settings.calendar_releases_ahead || 3),
    monthsAhead: b.months_ahead ?? Number(settings.calendar_months_ahead || 12),
  });
  return { anchor, plan, hash: await sha256Hex(JSON.stringify({ r: plan.releases, s: plan.sprints, m: plan.months })) };
}

/** per-sprint composition: planned tasks are the plan; bugs / operational fixes are reference only */
export function sprintSummary(s: Row, viewer: Viewer, w: World, idx: Indexes, detail = false) {
  const rows = visibleFeatures(w, viewer).filter((f) => f.sprint_id === s.id);
  const planned = rows.filter((f) => isPlannable(f));
  const reference = rows.filter((f) => !isPlannable(f));
  const counted = planned.filter((f) => idx.status.get(f.status_id)?.semantic !== 'cancelled');
  const done = counted.filter((f) => idx.status.get(f.status_id)?.semantic === 'done');
  return {
    id: s.id, code: s.code, ordinal: s.ordinal, release_id: s.release_id,
    start_date: s.start_date, end_date: s.end_date, testing_start: s.testing_start, production_due: s.production_due,
    status: s.status, version: viewer === 'guest' ? undefined : s.version,
    planned_count: counted.length,
    done_count: done.length,
    focus_count: counted.filter((f) => bool(f.is_focus)).length,
    focus_open: counted.filter((f) => bool(f.is_focus) && !isClosed(f, idx)).length,
    reference_count: reference.length,
    features: detail ? sortFeatures(planned, w, idx, 'priority').map((f) => featureDto(f, viewer, w, idx)) : undefined,
    reference: detail ? reference.map((f) => featureDto(f, viewer, w, idx)) : undefined,
  };
}

const scheduleSchema = z.object({
  /** null = remove from the release (planned tasks) */
  release_id: z.string().nullable().optional(),
  /** null = no sprint */
  sprint_id: z.string().nullable(),
  /** explicit production date; omitted = the sprint deadline (or the release date without a sprint) */
  planned_production_date: isoDate.nullable().optional(),
  version: z.number().int(),
  confirm_approved_change: z.boolean().optional(),
  /** FR-05: entering a sprint over the monthly budget / capacity needs an explicit confirmation with a reason */
  confirm_over_budget: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

export function registerCalendarRoutes(r: Router) {
  r.get('/api/calendar', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const anchor = anchorOf(w.settings);
    const t = today();
    const releases = w.releases
      .filter((rel) => rel.cycle_number !== null && rel.cycle_number !== undefined && canSee(viewer, rel.visibility))
      .sort((a, b) => a.cycle_number - b.cycle_number)
      .map((rel) => {
        const sprints = w.sprints.filter((s) => s.release_id === rel.id).sort((a, b) => a.ordinal - b.ordinal).map((s) => sprintSummary(s, viewer, w, idx));
        const st = idx.status.get(rel.status_id);
        return {
          id: rel.id, name: rel.name, cycle_number: rel.cycle_number, planned_date: rel.planned_date, actual_date: rel.actual_date,
          approved: !!rel.approved_at, status: st ? { id: st.id, name: st.name, semantic: st.semantic, color: st.color } : null,
          sprints,
          // the release is delivered only when the commitments of BOTH sprints are done
          planned_count: sprints.reduce((s, x) => s + x.planned_count, 0),
          done_count: sprints.reduce((s, x) => s + x.done_count, 0),
          focus_open: sprints.reduce((s, x) => s + x.focus_open, 0),
        };
      });
    const current = w.sprints.find((s) => s.start_date <= t && s.end_date >= t) ?? null;
    const out: Record<string, unknown> = {
      anchor,
      today: t,
      current_sprint_id: current?.id ?? null,
      releases,
      months: viewer === 'guest' ? [] : w.months.map((m) => ({ id: m.id, month: m.month, start_date: m.start_date, end_date: m.end_date, status: m.status, budget_limit_rub: viewer === 'editor' ? m.budget_limit_rub : undefined })),
    };
    if (viewer === 'editor') {
      // tasks placed in old planning periods that have no sprint yet: need a manual decision (never mapped automatically)
      out.unmapped = visibleFeatures(w, viewer)
        .filter((f) => isPlannable(f) && f.period_id && !f.sprint_id && !isClosed(f, idx))
        .map((f) => ({ id: f.id, key: `RF-${f.number}`, title: f.title, period: idx.period.get(f.period_id)?.name ?? null, release_id: idx.releaseOf.get(f.id) ?? null }));
    }
    return json(out);
  });

  r.get('/api/sprints', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const sprints = w.sprints.filter((s) => canSee(viewer, idx.release.get(s.release_id)?.visibility ?? 'draft'));
    return json({ sprints: sprints.map((s) => ({ ...sprintSummary(s, viewer, w, idx), release_name: idx.release.get(s.release_id)?.name })) });
  });

  r.get('/api/sprints/:id', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const s = idx.sprint.get(ctx.params.id) ?? w.sprints.find((x) => x.code === ctx.params.id);
    if (!s || !canSee(viewer, idx.release.get(s.release_id)?.visibility ?? 'draft')) throw notFound('Спринт не найден');
    return json({ sprint: { ...sprintSummary(s, viewer, w, idx, true), release_name: idx.release.get(s.release_id)?.name } });
  });

  r.post('/api/calendar/generate-preview', async (ctx) => {
    requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ releases_ahead: z.number().int().min(1).max(12).optional(), months_ahead: z.number().int().min(1).max(36).optional() }));
    const { anchor, plan, hash } = await generationPlan(ctx, b);
    return json({ anchor, plan, plan_hash: hash });
  });

  r.post('/api/calendar/generate', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({
      releases_ahead: z.number().int().min(1).max(12).optional(),
      months_ahead: z.number().int().min(1).max(36).optional(),
      plan_hash: z.string().min(10),
    }));
    const { plan, hash } = await generationPlan(ctx, b);
    if (hash !== b.plan_hash) throw conflict('stale', 'Календарь изменился после предпросмотра. Сформируйте предпросмотр заново.');
    if (!plan.releases.length && !plan.sprints.length && !plan.months.length) return json({ ok: true, created: { releases: 0, sprints: 0, months: 0 } });
    const db = ctx.env.DB;
    const now = nowIso();
    const statusId = (await first(db, `SELECT id FROM statuses WHERE entity = 'release' AND is_active = 1 ORDER BY sort_order LIMIT 1`))?.id;
    if (!statusId) throw badRequest('Нет статусов релизов в справочнике');
    const st = [];
    const relId = new Map<number, string>();
    let createdReleases = 0;
    for (const rel of plan.releases) {
      if (rel.existing_id) {
        relId.set(rel.cycle, rel.existing_id);
        continue;
      }
      const id = newId('rel');
      relId.set(rel.cycle, id);
      createdReleases++;
      st.push(stmt(db, `INSERT INTO releases (id, name, version_label, description, status_id, planned_date, visibility, created_at, updated_at, created_by, cycle_number)
        VALUES (?, ?, ?, '', ?, ?, 'internal', ?, ?, ?, ?)`, id, rel.name, String(rel.cycle), statusId, rel.planned_date, now, now, user.id, rel.cycle));
    }
    for (const s of plan.sprints) {
      st.push(stmt(db, `INSERT INTO sprints (id, release_id, ordinal, code, start_date, end_date, testing_start, production_due, created_at, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId('spr'), relId.get(s.cycle)!, s.ordinal, s.code, s.start_date, s.end_date, s.testing_start, s.production_due, now, user.id, now));
    }
    for (const m of plan.months) {
      st.push(stmt(db, 'INSERT INTO accounting_months (id, month, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        `m_${m.month.replace('-', '_')}`, m.month, m.start_date, m.end_date, now, now));
    }
    st.push(auditStmt(db, user, 'calendar', 'calendar', 'generated', [
      { field: 'releases', old: null, new: plan.releases.filter((x) => !x.existing_id).map((x) => x.cycle) },
      { field: 'sprints', old: null, new: plan.sprints.map((x) => x.code) },
      { field: 'months', old: null, new: plan.months.map((x) => x.month) },
    ]));
    // UNIQUE(code), UNIQUE(month), UNIQUE(cycle_number) make a concurrent second run fail as a whole
    await tx(db, st, 'Календарь уже обновили параллельно. Сформируйте предпросмотр заново.');
    return json({ ok: true, created: { releases: createdReleases, sprints: plan.sprints.length, months: plan.months.length } });
  });

  /** Editing an exception (holiday shift etc.). Task dates that followed the old deadline follow the new one. */
  r.patch('/api/sprints/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({
      start_date: isoDate.optional(), end_date: isoDate.optional(), testing_start: isoDate.optional(), production_due: isoDate.optional(),
      status: z.enum(['planned', 'active', 'closed']).optional(),
      version: z.number().int(),
      reason: z.string().trim().min(1, 'Укажите причину изменения спринта').max(500),
    }));
    const db = ctx.env.DB;
    const s = await first(db, 'SELECT * FROM sprints WHERE id = ?', ctx.params.id);
    if (!s) throw notFound('Спринт не найден');
    const next = { start_date: b.start_date ?? s.start_date, end_date: b.end_date ?? s.end_date, testing_start: b.testing_start ?? s.testing_start, production_due: b.production_due ?? s.production_due };
    if (!(next.end_date >= next.start_date && next.testing_start > next.end_date && next.production_due >= next.testing_start)) {
      throw badRequest('Даты спринта противоречат друг другу: начало ≤ конец < тестирование ≤ выкладка');
    }
    const overlap = await first(db, 'SELECT code FROM sprints WHERE id <> ? AND start_date <= ? AND end_date >= ?', s.id, next.end_date, next.start_date);
    if (overlap) throw badRequest(`Даты пересекаются со спринтом ${overlap.code}`);
    const changes: Change[] = [];
    for (const k of ['start_date', 'end_date', 'testing_start', 'production_due'] as const) if (next[k] !== s[k]) changes.push({ field: k, old: s[k], new: next[k] });
    if (b.status && b.status !== s.status) changes.push({ field: 'status', old: s.status, new: b.status });
    if (!changes.length) return json({ ok: true, unchanged: true });
    const now = nowIso();
    const st = [
      guardVersion(db, 'sprints', s.id, b.version),
      stmt(db, `UPDATE sprints SET start_date = ?, end_date = ?, testing_start = ?, production_due = ?, status = ?, closed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        next.start_date, next.end_date, next.testing_start, next.production_due, b.status ?? s.status,
        (b.status ?? s.status) === 'closed' ? s.closed_at ?? now : null, now, s.id),
      auditStmt(db, user, 'sprint', s.id, 'updated', changes, b.reason),
    ];
    if (next.production_due !== s.production_due) {
      st.push(stmt(db, `UPDATE features SET planned_production_date = ?, updated_at = ?, updated_by = ?, version = version + 1
        WHERE sprint_id = ? AND planned_production_date = ? AND task_kind = 'planned'`, next.production_due, now, user.id, s.id, s.production_due));
    }
    if (s.ordinal === 2 && next.production_due !== s.production_due) {
      st.push(stmt(db, 'UPDATE releases SET planned_date = ?, updated_at = ?, version = version + 1 WHERE id = ? AND planned_date = ?', next.production_due, now, s.release_id, s.production_due));
    }
    await tx(db, st, 'Спринт изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });

  /** Release → sprint → planned production date of one task. */
  r.patch('/api/features/:id/schedule', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, scheduleSchema);
    const f = await resolveFeature(ctx, ctx.params.id);
    if (f.merged_into_id) throw conflict('merged', 'Карточка объединена — планируйте основную');
    const db = ctx.env.DB;
    const sprint = b.sprint_id ? await first(db, 'SELECT * FROM sprints WHERE id = ?', b.sprint_id) : null;
    if (b.sprint_id && !sprint) throw badRequest('Спринт не найден');
    if (sprint?.status === 'closed') throw badRequest(`Спринт ${sprint.code} закрыт`);
    const plannable = isPlannable(f);
    if (isProductInternal(f) && (b.sprint_id || b.release_id)) throw badRequest('Внутренние задачи продукта не включаются в релизы и спринты');

    const curRelease = await first(db, 'SELECT r.* FROM release_features rf JOIN releases r ON r.id = rf.release_id WHERE rf.feature_id = ?', f.id);
    const curSprint = f.sprint_id ? await first(db, 'SELECT code FROM sprints WHERE id = ?', f.sprint_id) : null;
    const changes: Change[] = [];
    const st = [guardVersion(db, 'features', f.id, b.version)];
    const now = nowIso();
    const patch: Row = { sprint_id: b.sprint_id };
    let overBudget: unknown[] = [];

    if (!plannable) {
      // bug / operational improvement: the sprint is a reference only — no release, no plan, no production date change
      if (b.release_id) throw badRequest('Баги и оперативные доработки не включаются в релиз; спринт указывается только справочно');
    } else {
      let targetRelease: Row | null = curRelease;
      if (sprint) {
        if (b.release_id && b.release_id !== sprint.release_id) throw badRequest('Спринт относится к другому релизу');
        targetRelease = await first(db, 'SELECT * FROM releases WHERE id = ?', sprint.release_id);
      } else if (b.release_id !== undefined) {
        targetRelease = b.release_id ? await first(db, 'SELECT * FROM releases WHERE id = ?', b.release_id) : null;
        if (b.release_id && !targetRelease) throw badRequest('Релиз не найден');
      }
      if (sprint && sprint.id !== f.sprint_id) {
        const over = await budgetImpact(ctx, f.id, sprint.id);
        if (over.length && !b.confirm_over_budget) throw conflict('over_budget', 'Месячный бюджет или ёмкость команд будут превышены. Подтвердите с указанием причины.', { over });
        if (over.length && !b.reason) throw badRequest('Укажите причину превышения бюджета или ёмкости');
        if (over.length) overBudget = over;
      }
      const releaseChanges = (curRelease?.id ?? null) !== (targetRelease?.id ?? null);
      if (releaseChanges && (curRelease?.approved_at || targetRelease?.approved_at)) {
        if (!b.confirm_approved_change) throw conflict('approved', 'Релиз утверждён. Изменение состава нужно подтвердить и указать причину.');
        if (!b.reason) throw badRequest('Укажите причину изменения состава утверждённого релиза');
      }
      if (releaseChanges) {
        if (curRelease) {
          st.push(stmt(db, 'DELETE FROM release_features WHERE feature_id = ?', f.id));
          st.push(auditStmt(db, user, 'release', curRelease.id, 'composition_changed', [{ field: 'features', old: `RF-${f.number}`, new: null }], b.reason ?? null, !!curRelease.approved_at));
        }
        if (targetRelease) {
          st.push(stmt(db, 'INSERT INTO release_features (release_id, feature_id, added_at, added_by) VALUES (?, ?, ?, ?)', targetRelease.id, f.id, now, user.id));
          st.push(auditStmt(db, user, 'release', targetRelease.id, 'composition_changed', [{ field: 'features', old: null, new: `RF-${f.number}` }], b.reason ?? null, !!targetRelease.approved_at));
        }
        changes.push({ field: 'release', old: curRelease?.name ?? null, new: targetRelease?.name ?? null });
      }
      // production date: explicit value, else the sprint deadline, else the release date
      const date = b.planned_production_date !== undefined ? b.planned_production_date : sprint ? sprint.production_due : targetRelease?.planned_date ?? null;
      patch.planned_production_date = date;
      // the first promise (baseline) is fixed only when the release plan is approved (owner decision 13.10), see phases.ts
    }

    if ((f.sprint_id ?? null) !== (b.sprint_id ?? null)) changes.push({ field: 'sprint', old: curSprint?.code ?? null, new: sprint?.code ?? null });
    if (patch.planned_production_date !== undefined && (f.planned_production_date ?? null) !== (patch.planned_production_date ?? null)) {
      changes.push({ field: 'planned_production_date', old: f.planned_production_date ?? null, new: patch.planned_production_date ?? null });
    }
    if (patch.baseline_production_date) changes.push({ field: 'baseline_production_date', old: null, new: patch.baseline_production_date });
    if (!changes.length) return json({ ok: true, unchanged: true, version: f.version });
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    st.push(stmt(db, `UPDATE features SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
      ...cols.map((c) => patch[c] ?? null), now, user.id, f.id));
    const moved = !!f.sprint_id && !!b.sprint_id && f.sprint_id !== b.sprint_id;
    if (overBudget.length) changes.push({ field: 'over_budget', old: null, new: overBudget });
    st.push(auditStmt(db, user, 'feature', f.id, moved ? 'rescheduled' : 'scheduled', changes, b.reason ?? null, overBudget.length > 0));
    // vNext §1.2: an accepted proposal becomes «Запланировано» when one of its tasks gets a sprint
    if (b.sprint_id && b.sprint_id !== f.sprint_id) st.push(...(await autoPlanStatements(db, user, f.id)));
    await tx(db, st, 'Карточку изменил другой пользователь. Обновите данные.');
    // entering an approved release (a confirmed change) makes the task agreed: capture its baseline once
    if (b.sprint_id && isPlannable(f)) {
      const rel = await first(db, 'SELECT r.id, r.approved_at FROM releases r JOIN release_features rf ON rf.release_id = r.id WHERE rf.feature_id = ?', f.id);
      if (rel?.approved_at && !(await first(db, 'SELECT 1 FROM feature_plan_baselines WHERE feature_id = ?', f.id))) {
        const fresh = await first(db, 'SELECT * FROM features WHERE id = ?', f.id);
        await tx(db, (await baselineStatements(db, user, fresh!, 'Включена в утверждённый релиз', rel.id)).statements);
      }
    }
    return json({ ok: true, version: f.version + 1 });
  });
}

// Roadmap (Now / Next / Later + timeline) and the overview dashboard.
import { z } from 'zod';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt, type Change } from '../lib/audit';
import { all, bool, first, guardVersion, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, json, notFound, readJson, type Router } from '../lib/http';
import { blockerDto, canSee, featureDto, hasFlag, indexWorld, isClosed, isPlannable, loadWorld, metaDto, openBlockerIds, viewerOf, visibleFeatures, type Indexes, type Viewer, type World } from '../lib/world';
import { resolveFeature } from './features';
import { sortFeatures } from './features';
import { activePeriods, currentLoad, currentPeriodId } from './planning';
import { releaseSummary } from './releases';

export function registerDashboardRoutes(r: Router) {
  r.get('/api/meta', async (ctx) => {
    const w = await loadWorld(ctx.env.DB, viewerOf(ctx.user));
    return json(metaDto(w, viewerOf(ctx.user)));
  });

  r.get('/api/roadmap', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const periods = activePeriods(w);
    const cur = currentPeriodId(w);
    const curIdx = periods.findIndex((p) => p.id === cur);
    const nextId = curIdx >= 0 ? periods[curIdx + 1]?.id ?? null : null;
    const rows = sortFeatures(
      visibleFeatures(w, viewer).filter((f) => idx.status.get(f.status_id)?.semantic !== 'cancelled'),
      w, idx, 'priority',
    );
    const lane = (f: (typeof rows)[number]): 'now' | 'next' | 'later' | 'done' => {
      const sem = idx.status.get(f.status_id)?.semantic;
      if (sem === 'done') return 'done';
      if (sem === 'in_progress' || (cur && f.period_id === cur)) return 'now';
      if (nextId && f.period_id === nextId) return 'next';
      if (f.period_id) {
        const pi = periods.findIndex((p) => p.id === f.period_id);
        if (pi >= 0 && curIdx >= 0 && pi < curIdx) return 'now'; // overdue placements stay visible in "now"
      }
      return 'later';
    };
    const features = rows.map((f) => ({ ...featureDto(f, viewer, w, idx), lane: lane(f) }));
    const showCapacity = viewer !== 'guest' || w.settings.public_show_capacity === '1';
    const alerts = viewer === 'guest' ? [] : await all(ctx.env.DB, 'SELECT * FROM plan_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50');
    return json({
      periods,
      current_period_id: cur,
      next_period_id: nextId,
      features,
      releases: w.releases.filter((x) => canSee(viewer, x.visibility)).map((x) => releaseSummary(x, viewer, w, idx)),
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      load: showCapacity ? currentLoad(w, idx) : null,
      dependencies: w.relations
        .filter((x) => x.type === 'blocks' && idx.feature.has(x.from_id) && idx.feature.has(x.to_id))
        .filter((x) => canSee(viewer, idx.feature.get(x.from_id)!.visibility) && canSee(viewer, idx.feature.get(x.to_id)!.visibility))
        .map((x) => ({ from: x.from_id, to: x.to_id })),
      alerts,
    });
  });

  r.get('/api/overview', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    // every aggregate is computed over what this viewer may see
    const rows = visibleFeatures(w, viewer);
    const bySemantic: Record<string, number> = {};
    for (const f of rows) {
      const sem = idx.status.get(f.status_id)?.semantic ?? 'new';
      bySemantic[sem] = (bySemantic[sem] ?? 0) + 1;
    }
    const open = rows.filter((f) => hasFlag('open', f, w, idx));
    const ranked = sortFeatures(open, w, idx, 'priority');
    const blocked = open.filter((f) => hasFlag('blocked', f, w, idx));
    const unvoted = open.filter((f) => hasFlag('unvoted', f, w, idx)).length;
    const unestimated = open.filter((f) => hasFlag('unestimated', f, w, idx)).length;
    const periods = activePeriods(w);
    const cur = currentPeriodId(w);
    const ci = periods.findIndex((p) => p.id === cur);
    const showCapacity = viewer !== 'guest' || w.settings.public_show_capacity === '1';
    const load = showCapacity ? currentLoad(w, idx).filter((l) => ci >= 0 && (l.periodId === periods[ci]?.id || l.periodId === periods[ci + 1]?.id)) : null;
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = w.releases
      .filter((x) => canSee(viewer, x.visibility) && idx.status.get(x.status_id)?.semantic !== 'done' && idx.status.get(x.status_id)?.semantic !== 'cancelled')
      .sort((a, b) => (a.planned_date ?? '9999') < (b.planned_date ?? '9999') ? -1 : 1)
      .slice(0, 4)
      .map((x) => releaseSummary(x, viewer, w, idx));
    const alerts = viewer === 'guest' ? 0 : ((await all(ctx.env.DB, 'SELECT COUNT(*) AS n FROM plan_alerts WHERE resolved_at IS NULL'))[0]?.n ?? 0);
    return json({
      kpi: {
        total: rows.length,
        open: open.length,
        in_progress: bySemantic.in_progress ?? 0,
        ready: bySemantic.ready ?? 0,
        planned: bySemantic.planned ?? 0,
        done: bySemantic.done ?? 0,
        blocked: blocked.length,
        unvoted,
        unestimated,
        epics: w.epics.filter((e) => canSee(viewer, e.visibility)).length,
      },
      by_status: w.statuses
        .filter((s) => s.entity === 'feature')
        .map((s) => ({ id: s.id, name: s.name, semantic: s.semantic, color: s.color, count: rows.filter((f) => f.status_id === s.id).length })),
      top: ranked.slice(0, 8).map((f) => featureDto(f, viewer, w, idx)),
      blocked: blocked.slice(0, 8).map((f) => featureDto(f, viewer, w, idx)),
      periods: ci >= 0 ? periods.slice(ci, ci + 2) : [],
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      load,
      releases: upcoming,
      alerts,
      today,
      gantt: ganttItems(w, idx, viewer, today),
      focus: focusBlock(w, idx, viewer, today),
      business_blockers: blockersBlock(w, idx, viewer, today),
    });
  });

  // ───── business blockers (FR-03) ─────
  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
  r.post('/api/features/:id/blockers', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({
      expectation: z.string().trim().min(1, 'Опишите, что ожидаем').max(1000),
      owner_department_id: z.string().nullable().optional(),
      owner_name: z.string().trim().max(200).nullable().optional(),
      started_at: isoDate.optional(),
      due_at: isoDate.nullable().optional(),
    }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const db = ctx.env.DB;
    if (b.owner_department_id && !(await first(db, 'SELECT 1 FROM departments WHERE id = ?', b.owner_department_id))) throw badRequest('Отдел не найден');
    if (!b.owner_department_id && !b.owner_name) throw badRequest('Укажите, от кого ждём ответ: отдел или человека');
    const id = newId('blk');
    const now = nowIso();
    await tx(db, [
      stmt(db, `INSERT INTO feature_blockers (id, feature_id, expectation, owner_department_id, owner_name, started_at, due_at, created_at, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, f.id, b.expectation, b.owner_department_id ?? null, b.owner_name ?? null, b.started_at ?? now.slice(0, 10), b.due_at ?? null, now, user.id, now),
      auditStmt(db, user, 'feature', f.id, 'blocker_added', [{ field: 'blocker', old: null, new: b.expectation }]),
    ]);
    return json({ id }, 201);
  });

  r.patch('/api/blockers/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({
      expectation: z.string().trim().min(1).max(1000).optional(),
      owner_department_id: z.string().nullable().optional(),
      owner_name: z.string().trim().max(200).nullable().optional(),
      started_at: isoDate.optional(),
      due_at: isoDate.nullable().optional(),
      resolved: z.boolean().optional(),
      resolution: z.string().trim().max(1000).nullable().optional(),
      version: z.number().int(),
    }));
    const db = ctx.env.DB;
    const cur = await first(db, 'SELECT * FROM feature_blockers WHERE id = ?', ctx.params.id);
    if (!cur) throw notFound('Блокер не найден');
    await resolveFeature(ctx, cur.feature_id); // hidden Product tasks: 404 for others
    if (b.owner_department_id && !(await first(db, 'SELECT 1 FROM departments WHERE id = ?', b.owner_department_id))) throw badRequest('Отдел не найден');
    const patch: Row = { expectation: b.expectation, owner_department_id: b.owner_department_id, owner_name: b.owner_name, started_at: b.started_at, due_at: b.due_at, resolution: b.resolution };
    if (b.resolved !== undefined) patch.resolved_at = b.resolved ? cur.resolved_at ?? nowIso().slice(0, 10) : null;
    const changes: Change[] = Object.entries(patch).filter(([k, v]) => v !== undefined && (cur[k] ?? null) !== (v ?? null)).map(([k, v]) => ({ field: `blocker.${k}`, old: cur[k] ?? null, new: v ?? null }));
    if (!changes.length) return json({ ok: true, unchanged: true });
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    await tx(db, [
      guardVersion(db, 'feature_blockers', cur.id, b.version),
      stmt(db, `UPDATE feature_blockers SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...cols.map((c) => patch[c] ?? null), nowIso(), cur.id),
      auditStmt(db, user, 'feature', cur.feature_id, b.resolved ? 'blocker_resolved' : 'blocker_updated', changes),
    ], 'Блокер изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });
}

const ACTIVE = new Set(['analysis', 'in_progress']);
const ref = (f: Row, idx: Indexes) => ({
  id: f.id, key: `RF-${f.number}`, title: f.title, task_kind: f.task_kind ?? 'planned',
  status: (() => { const s = idx.status.get(f.status_id); return s ? { id: s.id, name: s.name, semantic: s.semantic, color: s.color } : null; })(),
});

/**
 * Gantt: only work that is really going on (semantic analysis / in_progress) AND has an end date.
 * End = planned_end (end of the work, not the production date); for a planned task in a sprint without
 * planned_end — the sprint development end. Start = planned_start, else the sprint start; otherwise none
 * (a deadline milestone is drawn, the start is never invented). Hidden Product tasks are not in the world.
 */
export function ganttItems(w: World, idx: Indexes, viewer: Viewer, today: string) {
  const rows = visibleFeatures(w, viewer).filter((f) => ACTIVE.has(idx.status.get(f.status_id)?.semantic));
  const items = rows.flatMap((f) => {
    const sprint = f.sprint_id ? idx.sprint.get(f.sprint_id) : undefined;
    const inPlan = isPlannable(f) && sprint;
    const end = f.planned_end ?? (inPlan ? sprint.end_date : null);
    if (!end) return [];
    const start = f.planned_start ?? (inPlan ? sprint.start_date : null);
    const rel = idx.releaseOf.get(f.id) ? idx.release.get(idx.releaseOf.get(f.id)!) : undefined;
    return [{
      feature: { ...ref(f, idx), assignee_name: viewer === 'guest' ? undefined : f.assignee_name ?? null, urgency: f.urgency ?? null, is_focus: bool(f.is_focus) },
      stage: f.stage_id ? idx.stage.get(f.stage_id)?.name ?? null : null,
      start: start && start <= end ? start : null,
      end,
      end_source: f.planned_end ? 'planned_end' : 'sprint',
      production_date: isPlannable(f) ? f.planned_production_date ?? null : null,
      overdue: end < today,
      blocked: openBlockerIds(f, w, idx).length > 0 || (idx.openBlockersBy.get(f.id) ?? []).length > 0,
      release: rel && canSee(viewer, rel.visibility) ? { id: rel.id, name: rel.name } : null,
      sprint: sprint && isPlannable(f) ? { id: sprint.id, code: sprint.code } : sprint ? { id: sprint.id, code: sprint.code, reference: true } : null,
    }];
  });
  items.sort((a, b) => (a.start ?? a.end).localeCompare(b.start ?? b.end) || a.end.localeCompare(b.end));
  return items;
}

/** Release commitments ("фокус") of the nearest open release — independent of the Gantt and of the status. */
export function focusBlock(w: World, idx: Indexes, viewer: Viewer, today: string) {
  const open = w.releases
    .filter((r) => canSee(viewer, r.visibility) && !['done', 'cancelled'].includes(idx.status.get(r.status_id)?.semantic))
    .filter((r) => !r.planned_date || r.planned_date >= today || (idx.featuresByRelease.get(r.id) ?? []).some((id) => { const f = idx.feature.get(id); return f && bool(f.is_focus) && !isClosed(f, idx); }))
    .sort((a, b) => (a.planned_date ?? '9999').localeCompare(b.planned_date ?? '9999'));
  const visible = new Set(visibleFeatures(w, viewer).map((f) => f.id));
  const inRelease = (rid: string) => (idx.featuresByRelease.get(rid) ?? []).map((id) => idx.feature.get(id)!).filter((f) => f && visible.has(f.id) && isPlannable(f));
  const rel = open.find((r) => inRelease(r.id).some((f) => bool(f.is_focus))) ?? open[0];
  if (!rel) return null;
  const members = inRelease(rel.id);
  const sprints = w.sprints.filter((s) => s.release_id === rel.id).sort((a, b) => a.ordinal - b.ordinal);
  const items = members.filter((f) => bool(f.is_focus) && idx.status.get(f.status_id)?.semantic !== 'cancelled').map((f) => {
    const epic = f.epic_id ? idx.epic.get(f.epic_id) : undefined;
    // an epic goal shows its features of THIS release (both sprints), each counted once
    const parts = epic ? members.filter((x) => x.epic_id === epic.id && idx.status.get(x.status_id)?.semantic !== 'cancelled') : [];
    const sprint = f.sprint_id ? idx.sprint.get(f.sprint_id) : undefined;
    return {
      feature: { ...ref(f, idx), assignee_name: viewer === 'guest' ? undefined : f.assignee_name ?? null },
      sprint: sprint ? { id: sprint.id, code: sprint.code } : null,
      planned_production_date: f.planned_production_date ?? null,
      done: idx.status.get(f.status_id)?.semantic === 'done',
      overdue: !!f.planned_production_date && f.planned_production_date < today && idx.status.get(f.status_id)?.semantic !== 'done',
      epic: epic && canSee(viewer, epic.visibility) ? { id: epic.id, title: epic.title, total: parts.length, done: parts.filter((x) => idx.status.get(x.status_id)?.semantic === 'done').length } : null,
    };
  });
  return {
    release: { id: rel.id, name: rel.name, planned_date: rel.planned_date, sprints: sprints.map((s) => ({ id: s.id, code: s.code, production_due: s.production_due, end_date: s.end_date })) },
    items,
  };
}

/** Blockers with business context: what we wait for, from whom, since when, what it unblocks. */
export function blockersBlock(w: World, idx: Indexes, viewer: Viewer, today: string) {
  const days = (since: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000));
  const visible = visibleFeatures(w, viewer).filter((f) => !isClosed(f, idx));
  const unblocks = (f: Row) => w.relations.filter((r) => r.type === 'blocks' && r.from_id === f.id).map((r) => idx.feature.get(r.to_id)).filter((x): x is Row => !!x && visible.some((v) => v.id === x.id)).map((x) => `RF-${x.number}`);
  const out: unknown[] = [];
  for (const f of visible) {
    const business = idx.openBlockersBy.get(f.id) ?? [];
    for (const b of business) {
      out.push({
        feature: ref(f, idx), kind: 'business', ...(viewer === 'guest' ? {} : { blocker: blockerDto(b, w) }),
        waiting_for: viewer === 'guest' ? null : b.expectation,
        owner: viewer === 'guest' ? null : (b.owner_department_id ? w.departments.find((d) => d.id === b.owner_department_id)?.name : null) ?? b.owner_name ?? null,
        since: b.started_at, days: days(b.started_at), overdue: !!b.due_at && b.due_at < today, unblocks: [`RF-${f.number}`, ...unblocks(f)],
      });
    }
    if (!business.length && (idx.status.get(f.status_id)?.semantic === 'blocked' || openBlockerIds(f, w, idx).length)) {
      const tech = openBlockerIds(f, w, idx).map((id) => idx.feature.get(id)!).filter((x) => visible.some((v) => v.id === x.id));
      out.push({
        feature: ref(f, idx), kind: tech.length ? 'dependency' : 'status',
        waiting_for: tech.length ? `завершения ${tech.map((x) => `RF-${x.number}`).join(', ')}` : null,
        owner: null, since: null, days: null, overdue: false, unblocks: [`RF-${f.number}`, ...unblocks(f)],
      });
    }
  }
  // business blockers first, the longest waits on top
  return out.sort((a: any, b: any) => (a.kind === 'business' ? 0 : 1) - (b.kind === 'business' ? 0 : 1) || (b.days ?? -1) - (a.days ?? -1));
}

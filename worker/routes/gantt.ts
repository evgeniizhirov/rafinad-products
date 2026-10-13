// The Gantt (vNext ТЗ §2): one structure for everybody — releases → sprints → «Релизные задачи / Баги / Доработки» →
// tasks, and on every task its own phases (plan from the sprint, baseline, facts, forecast; domain/phases.ts).
//   scope=shared  (default, «Обзор»): general tasks by the ordinary publication rules (drafts excluded for everyone). Hidden Product tasks are never
//                 here — not for Product either (owner decision 13.10); they live in the Product planner.
//   scope=planner (Product planner): product / admin only, hidden Product tasks included and marked.
// Estimates, budgets and private notes are never part of a Gantt answer.
import { perms, requirePerm } from '../lib/auth';
import { badRequest, json, type Router } from '../lib/http';
import { bool, type Row } from '../lib/db';
import { canSee, indexWorld, isProductInternal, loadWorld, viewerOf, visibleFeatures, type Indexes, type Viewer } from '../lib/world';
import { loadPhaseData, timelineFor, type PhaseData } from './phases';

const GROUPS = [
  { kind: 'planned', label: 'Релизные задачи' },
  { kind: 'bug', label: 'Баги' },
  { kind: 'operational_improvement', label: 'Доработки' },
] as const;

const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function taskDto(f: Row, viewer: Viewer, idx: Indexes, data: PhaseData, today: string) {
  const st = idx.status.get(f.status_id);
  const kind = f.task_kind ?? 'planned';
  return {
    id: f.id, key: `RF-${f.number}`, title: f.title, kind,
    assignee: viewer === 'guest' ? undefined : f.assignee_name ?? null,
    status: st ? { name: st.name, semantic: st.semantic, color: st.color } : null,
    tags: idx.tagsBy.get(f.id) ?? [],
    is_focus: bool(f.is_focus),
    ...(isProductInternal(f) ? { is_product_internal: true } : {}),
    timeline: timelineFor(f, idx, data, today),
  };
}

export function registerGanttRoutes(r: Router) {
  r.get('/api/gantt', async (ctx) => {
    const scope = ctx.url.searchParams.get('scope') ?? 'shared';
    if (scope !== 'shared' && scope !== 'planner') throw badRequest('scope: shared или planner');
    if (scope === 'planner') requirePerm(ctx, perms.plan, 'Планировщик доступен продуктовой команде');
    const viewer = viewerOf(ctx.user);
    const db = ctx.env.DB;
    const w = await loadWorld(db, viewer, { includeInternal: scope === 'planner' });
    const idx = indexWorld(w);
    const data = await loadPhaseData(db);
    const today = new Date().toISOString().slice(0, 10);
    // shared: what is published for employees (never drafts — not even for Product), so business and Product see the same
    const tasks = scope === 'planner' ? visibleFeatures(w, viewer, 'all') : visibleFeatures(w, viewer, 'general').filter((f) => f.visibility !== 'draft');

    const releases = w.releases
      .filter((rel) => rel.cycle_number !== null && rel.cycle_number !== undefined && canSee(viewer, rel.visibility) && (scope === 'planner' || rel.visibility !== 'draft'))
      .sort((a, b) => a.cycle_number - b.cycle_number)
      .map((rel) => {
        const sprints = w.sprints.filter((s) => s.release_id === rel.id).sort((a, b) => a.ordinal - b.ordinal);
        const st = idx.status.get(rel.status_id);
        return { rel, sprints, st };
      })
      .filter((x) => x.sprints.length);

    const inSprint = new Map<string, Row[]>();
    const outside: Row[] = [];
    let undated = 0;
    for (const f of tasks) {
      const s = f.sprint_id ? idx.sprint.get(f.sprint_id) : undefined;
      if (s && releases.some((x) => x.rel.id === s.release_id)) {
        (inSprint.get(s.id) ?? inSprint.set(s.id, []).get(s.id)!).push(f);
        continue;
      }
      // no sprint: only with reliable own dates (or confirmed facts) — never an invented interval
      const tl = timelineFor(f, idx, data, today);
      const has = tl.phases.some((p) => p.plan || p.fact.start) || tl.release.plan || tl.release.fact;
      const closed = ['done', 'cancelled'].includes(idx.status.get(f.status_id)?.semantic);
      if (has && !(closed && !tl.release.fact && !f.closed_at)) outside.push(f);
      else if (!closed) undated++;
    }

    const byNumber = (a: Row, b: Row) => (bool(b.is_focus) ? 1 : 0) - (bool(a.is_focus) ? 1 : 0) || a.number - b.number;
    const out = releases.map(({ rel, sprints, st }) => {
      const sprintDtos = sprints.map((s) => {
        const list = (inSprint.get(s.id) ?? []).sort(byNumber);
        return {
          id: s.id, code: s.code, start_date: s.start_date, end_date: s.end_date, testing_start: s.testing_start, production_due: s.production_due, status: s.status,
          groups: GROUPS.map((g) => ({ kind: g.kind, label: g.label, tasks: list.filter((f) => (f.task_kind ?? 'planned') === g.kind).map((f) => taskDto(f, viewer, idx, data, today)) })).filter((g) => g.tasks.length),
        };
      });
      const all = sprintDtos.flatMap((s) => s.groups.flatMap((g) => g.tasks)).filter((t) => t.kind === 'planned');
      const done = all.filter((t) => t.status?.semantic === 'done').length;
      return {
        id: rel.id, name: rel.name, cycle: rel.cycle_number, planned_date: rel.planned_date, actual_date: rel.actual_date ?? null, approved: !!rel.approved_at,
        status: st ? { name: st.name, semantic: st.semantic, color: st.color } : null,
        start: sprints[0].start_date, end: sprints.at(-1)!.production_due,
        readiness: all.length ? Math.round((done / all.length) * 100) : null,
        sprints: sprintDtos,
      };
    });

    // default horizon: the current release (the one whose window contains today, else the next one) + two after it
    let cur = out.findIndex((x) => x.start <= today && x.end >= today);
    if (cur < 0) cur = out.findIndex((x) => x.start > today);
    if (cur < 0) cur = Math.max(0, out.length - 1);
    const win = out.slice(cur, cur + 3);
    const outsideDtos = outside.sort(byNumber).map((f) => taskDto(f, viewer, idx, data, today));
    const displayedTasks = [...outsideDtos, ...out.flatMap((rel) => rel.sprints.flatMap((s) => s.groups.flatMap((g) => g.tasks)))];
    const dates = [
      ...out.flatMap((x) => [x.start, x.end]),
      ...displayedTasks.flatMap((t) => [...t.timeline.phases.flatMap((p) => [p.plan?.start, p.plan?.end, p.fact.start, p.fact.end, p.forecast_end]), t.timeline.release.plan, t.timeline.release.fact, t.timeline.release.forecast]),
    ].filter((d): d is string => !!d).sort();
    return json({
      scope, today,
      window: win.length ? { from: shift(win[0].start, -3), to: shift(win.at(-1)!.end, 4), releases: win.map((x) => x.id) } : { from: shift(today, -7), to: shift(today, 42), releases: [] },
      range: { from: shift(dates[0] ?? today, -7), to: shift(dates.at(-1) ?? today, 14) },
      releases: out,
      outside: outsideDtos,
      /** open tasks without a sprint and without reliable dates: listed in the backlog / planner, not drawn */
      undated,
    });
  });
}

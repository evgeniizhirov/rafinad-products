// Product planner (vNext ТЗ §2, §6): the product team's own working view, separate from the shared «Обзор».
//   GET /api/planner — the sprint queue (open planned tasks without a live sprint, by priority), the next sprints with
//   their tasks, team hours against the team capacity and the monthly budget of the months those sprints touch, plus
//   the hidden Product tasks (they never go into sprints — managed here by their own dates).
// Everything here comes from the actual sprints; the old planning periods are not read (they are removed in v2-10).
// Moving tasks uses the ordinary PATCH /api/features/:id/schedule, so every rule (approved release, budget,
// capacity, baseline, proposals) applies exactly as in the task card.
import { budgetReport, sprintCapacityReport } from './budget';
import { sortFeatures } from './features';
import { perms, requirePerm } from '../lib/auth';
import { bool, type Row } from '../lib/db';
import { json, type Router } from '../lib/http';
import { indexWorld, isPlannable, isProductInternal, loadWorld, openBlockerIds, type Indexes, type World } from '../lib/world';

const CLOSED = ['done', 'cancelled'];

function taskDto(f: Row, w: World, idx: Indexes, rank: Map<string, number>) {
  const st = idx.status.get(f.status_id);
  const estimates: Record<string, number> = Object.fromEntries((idx.estimatesBy.get(f.id) ?? []).map((e) => [e.team_id, Number(e.hours)]));
  const hours = Math.round(Object.values(estimates).reduce((a, b) => a + b, 0) * 100) / 100;
  const pr = idx.priority.get(f.id);
  return {
    id: f.id, key: `RF-${f.number}`, title: f.title, kind: f.task_kind ?? 'planned', version: f.version,
    status: st ? { name: st.name, semantic: st.semantic, color: st.color } : null,
    assignee: f.assignee_name ?? null,
    tags: idx.tagsBy.get(f.id) ?? [],
    rank: rank.get(f.id) ?? null,
    score: pr?.score ?? null,
    voters: pr?.voters ?? 0,
    estimates, hours, unestimated: !(idx.estimatesBy.get(f.id) ?? []).length,
    blocked: openBlockerIds(f, w, idx).length > 0 || st?.semantic === 'blocked',
    is_focus: bool(f.is_focus),
    visibility: f.visibility,
    ...(isProductInternal(f) ? { is_product_internal: true, planned_start: f.planned_start ?? null, planned_end: f.planned_end ?? null } : {}),
  };
}

export function registerPlannerRoutes(r: Router) {
  r.get('/api/planner', async (ctx) => {
    requirePerm(ctx, perms.plan, 'Планировщик доступен продуктовой команде');
    const w = await loadWorld(ctx.env.DB, 'editor', { includeInternal: true });
    const idx = indexWorld(w);
    const today = new Date().toISOString().slice(0, 10);
    const count = Math.min(8, Math.max(1, Number(ctx.url.searchParams.get('sprints') || 4)));
    const open = (f: Row) => !f.merged_into_id && !CLOSED.includes(idx.status.get(f.status_id)?.semantic);

    // live sprints: not closed and their release date not passed — the planning horizon
    const live = w.sprints.filter((s) => s.status !== 'closed' && s.production_due >= today).sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
    const shown = live.slice(0, count);
    const liveIds = new Set(live.map((s) => s.id));

    const planned = w.features.filter((f) => open(f) && isPlannable(f));
    const rank = new Map(sortFeatures(planned, w, idx, 'priority').map((f, i) => [f.id, i + 1]));
    const dto = (f: Row) => taskDto(f, w, idx, rank);

    // queue: open planned tasks with no sprint, or still open in a sprint that is closed / already released (carry-over)
    const queue = sortFeatures(planned.filter((f) => !f.sprint_id || !liveIds.has(f.sprint_id)), w, idx, 'priority').map((f) => {
      const was = f.sprint_id ? idx.sprint.get(f.sprint_id) : undefined;
      return { ...dto(f), ...(was ? { carry_from: was.code } : {}) };
    });

    const caps = new Map((await sprintCapacityReport(ctx, w, idx, shown)).map((c) => [c.id, c]));
    const sprints = shown.map((s) => {
      const rel = w.releases.find((x) => x.id === s.release_id);
      const inSprint = w.features.filter((f) => !f.merged_into_id && f.sprint_id === s.id);
      const c = caps.get(s.id)!;
      return {
        id: s.id, code: s.code, status: s.status, start_date: s.start_date, end_date: s.end_date, testing_start: s.testing_start, production_due: s.production_due,
        current: s.start_date <= today && s.end_date >= today,
        release: rel ? { id: rel.id, name: rel.name, approved: !!rel.approved_at } : null,
        capacity: c.capacity, load: c.load, over_capacity: c.over_capacity,
        tasks: sortFeatures(inSprint.filter(isPlannable), w, idx, 'priority').map(dto),
        // bugs and improvements: the sprint is a reference only, they do not consume the plan
        reference: inSprint.filter((f) => !isPlannable(f) && !isProductInternal(f)).map((f) => ({ id: f.id, key: `RF-${f.number}`, title: f.title, kind: f.task_kind, status: idx.status.get(f.status_id)?.name ?? null })),
      };
    });
    const later = planned.filter((f) => f.sprint_id && liveIds.has(f.sprint_id) && !shown.some((s) => s.id === f.sprint_id)).length;

    // budget of the calendar months the shown sprints touch
    const months = [...new Set(shown.flatMap((s) => [s.start_date.slice(0, 7), s.end_date.slice(0, 7)]))].sort();
    const budget = (await budgetReport(ctx, w, idx, months)).map((m: any) => ({
      month: m.month, status: m.status, cost: m.cost ?? 0, budget_limit_rub: m.budget_limit_rub ?? null, over_budget: !!m.over_budget,
    }));

    const internal = sortFeatures(w.features.filter((f) => open(f) && isProductInternal(f)), w, idx, 'priority').map(dto);

    return json({
      today,
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, code: t.code, name: t.name, color: t.color })),
      sprints, queue, internal, budget, later,
      more_sprints: Math.max(0, live.length - shown.length),
    });
  });
}

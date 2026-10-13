// Monthly budget and availability (FR-05): rates by sprint, rouble limit per calendar month, forecast, month close;
// team availability is one number per team per sprint (owner decision 13.10).
import { z } from 'zod';
import { monthlyForecast, type Allocation, type BudgetTask, type RateRow } from '../domain/budget';
import { addMonths, monthDates } from '../domain/calendar';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { all, bool, first, guardVersion, newId, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { indexWorld, isPlannable, loadWorld, type Indexes, type World } from '../lib/world';

export const PAID_BY_DEFAULT = ['backend', 'frontend', 'qa', 'devops'];

/** rate history + an implicit initial version for teams that have none (2200 ₽/h for paid teams, 0 otherwise) */
export async function loadRates(ctx: Ctx, w: World): Promise<RateRow[]> {
  const rows = (await all(ctx.env.DB, 'SELECT * FROM team_rates')) as unknown as RateRow[];
  for (const t of w.teams) {
    if (!rows.some((r) => r.team_id === t.id)) {
      const paid = PAID_BY_DEFAULT.includes(String(t.code).toLowerCase());
      rows.push({ team_id: t.id, effective_from: '2000-01-01', rate_rub_per_hour: paid ? 2200 : 0, include_in_budget: paid ? 1 : 0 });
    }
  }
  return rows;
}

/** tasks that consume the plan budget: planned, not hidden, not cancelled, placed in a sprint */
export function budgetTasks(w: World, idx: Indexes): BudgetTask[] {
  return w.features
    .filter((f) => !f.merged_into_id && isPlannable(f) && f.sprint_id && idx.status.get(f.status_id)?.semantic !== 'cancelled')
    .flatMap((f) => {
      const s = idx.sprint.get(f.sprint_id);
      if (!s) return [];
      const known = f.planned_start && f.planned_end && f.planned_start <= f.planned_end;
      return [{
        id: f.id, key: `RF-${f.number}`, title: f.title,
        from: known ? f.planned_start : s.start_date, to: known ? f.planned_end : s.end_date, rateDate: s.start_date,
        estimates: Object.fromEntries((idx.estimatesBy.get(f.id) ?? []).map((e) => [e.team_id, Number(e.hours)])),
      }];
    });
}

export async function budgetReport(ctx: Ctx, w: World, idx: Indexes, months: string[], extra?: BudgetTask) {
  const rates = await loadRates(ctx, w);
  const method = (w.settings.budget_allocation as Allocation) || 'workdays';
  const teams = w.teams.map((t) => ({ id: t.id, active: bool(t.is_active) }));
  const tasks = budgetTasks(w, idx).filter((t) => t.id !== extra?.id);
  if (extra) tasks.push(extra);
  const forecast = monthlyForecast(tasks, rates, teams, method);
  const snaps = new Map((await all(ctx.env.DB, 'SELECT * FROM month_snapshots')).map((s) => [s.month_id, s]));
  return months.map((m) => {
    const row = w.months.find((x) => x.month === m);
    const snap = row ? snaps.get(row.id) : undefined;
    if (snap) return { ...parseJson<Row>(snap.data, {}), month: m, id: row!.id, status: 'closed', snapshot_at: snap.created_at, version: row!.version };
    const f = forecast.get(m) ?? { month: m, cost: 0, hours: {}, incomplete: 0, tasks: [] };
    const limit = row?.budget_limit_rub ?? null;
    return {
      month: m, id: row?.id ?? null, status: row?.status ?? 'missing', version: row?.version ?? null, forecast: true, method,
      budget_limit_rub: limit, cost: f.cost, over_budget: limit !== null && f.cost > limit,
      hours: f.hours,
      incomplete: f.incomplete, tasks: f.tasks,
    };
  });
}

/** planned hours per team in a sprint: full estimates of the plannable tasks placed in it (no month split) */
export function sprintLoad(w: World, idx: Indexes, sprintId: string, extra?: { id: string; estimates: Record<string, number> }) {
  const load: Record<string, number> = {};
  const add = (est: Record<string, number>) => { for (const [t, h] of Object.entries(est)) load[t] = Math.round(((load[t] ?? 0) + h) * 100) / 100; };
  for (const t of budgetTasks(w, idx)) {
    if (t.id === extra?.id || idx.feature.get(t.id)?.sprint_id !== sprintId) continue;
    add(t.estimates);
  }
  if (extra) add(extra.estimates);
  return load;
}

export async function sprintCapacityReport(ctx: Ctx, w: World, idx: Indexes, sprints: Row[]) {
  const caps = await all(ctx.env.DB, 'SELECT * FROM sprint_capacities');
  return sprints.map((s) => {
    const capacity = Object.fromEntries(caps.filter((c) => c.sprint_id === s.id).map((c) => [c.team_id, Number(c.hours)]));
    const load = sprintLoad(w, idx, s.id);
    return {
      id: s.id, code: s.code, start_date: s.start_date, end_date: s.end_date, status: s.status,
      load, capacity, over_capacity: Object.entries(load).filter(([t, h]) => capacity[t] !== undefined && h > capacity[t]).map(([t]) => t),
    };
  });
}

export function registerBudgetRoutes(r: Router) {
  r.get('/api/planning/budget', async (ctx) => {
    requirePerm(ctx, perms.plan);
    const w = await loadWorld(ctx.env.DB, 'editor');
    const idx = indexWorld(w);
    const from = ctx.url.searchParams.get('from') || new Date().toISOString().slice(0, 7);
    const count = Math.min(12, Math.max(1, Number(ctx.url.searchParams.get('months') || 4)));
    if (!/^\d{4}-\d{2}$/.test(from)) throw badRequest('Месяц в формате ГГГГ-ММ');
    const months = Array.from({ length: count }, (_, i) => addMonths(from, i));
    const rates = await loadRates(ctx, w);
    const first = `${months[0]}-01`;
    const last = monthDates(months[months.length - 1]).end_date;
    const sprints = w.sprints.filter((s) => s.end_date >= first && s.start_date <= last).sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    return json({
      months: await budgetReport(ctx, w, idx, months),
      sprints: await sprintCapacityReport(ctx, w, idx, sprints),
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, code: t.code, name: t.name, color: t.color })),
      rates: w.teams.map((t) => {
        const cur = rates.filter((x) => x.team_id === t.id).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
        return { team_id: t.id, history: cur };
      }),
      allocation: w.settings.budget_allocation || 'workdays',
    });
  });

  r.put('/api/planning/monthly-budget', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), budget_limit_rub: z.number().min(0).max(1e10).nullable(), version: z.number().int() }));
    const m = await first(ctx.env.DB, 'SELECT * FROM accounting_months WHERE month = ?', b.month);
    if (!m) throw notFound('Месяц не создан — сгенерируйте календарь');
    if (m.status === 'closed') throw conflict('closed', 'Месяц закрыт: его расчёт зафиксирован');
    await tx(ctx.env.DB, [
      guardVersion(ctx.env.DB, 'accounting_months', m.id, b.version),
      stmt(ctx.env.DB, 'UPDATE accounting_months SET budget_limit_rub = ?, updated_at = ?, version = version + 1 WHERE id = ?', b.budget_limit_rub, nowIso(), m.id),
      auditStmt(ctx.env.DB, user, 'budget', m.id, 'limit_changed', [{ field: 'budget_limit_rub', old: m.budget_limit_rub, new: b.budget_limit_rub }]),
    ]);
    return json({ ok: true });
  });

  /** guaranteed hours of a team for one sprint (team aggregate, not per employee) */
  r.put('/api/planning/sprint-capacity', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ sprint_id: z.string(), team_id: z.string(), hours: z.number().min(0).max(100000).nullable() }));
    const db = ctx.env.DB;
    const sp = await first(db, 'SELECT * FROM sprints WHERE id = ?', b.sprint_id);
    if (!sp) throw notFound('Спринт не найден');
    if (sp.status === 'closed') throw conflict('closed', 'Спринт закрыт: его доступность не меняется');
    if (!(await first(db, 'SELECT 1 FROM resource_teams WHERE id = ?', b.team_id))) throw badRequest('Команда не найдена');
    const cur = await first(db, 'SELECT * FROM sprint_capacities WHERE sprint_id = ? AND team_id = ?', sp.id, b.team_id);
    const now = nowIso();
    await tx(db, [
      b.hours === null
        ? stmt(db, 'DELETE FROM sprint_capacities WHERE sprint_id = ? AND team_id = ?', sp.id, b.team_id)
        : stmt(db, `INSERT INTO sprint_capacities (sprint_id, team_id, hours, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(sprint_id, team_id) DO UPDATE SET hours = excluded.hours, updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = version + 1`, sp.id, b.team_id, b.hours, now, user.id),
      auditStmt(db, user, 'sprint', sp.id, 'capacity_changed', [{ field: `hours:${b.team_id}`, old: cur?.hours ?? null, new: b.hours }]),
    ]);
    return json({ ok: true });
  });

  /** close a month: its calculation is frozen; later rate or plan changes never rewrite it */
  r.post('/api/planning/months/:month/close', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ reason: z.string().trim().max(500).optional(), version: z.number().int() }));
    const db = ctx.env.DB;
    const m = await first(db, 'SELECT * FROM accounting_months WHERE month = ?', ctx.params.month);
    if (!m) throw notFound('Месяц не найден');
    if (m.status === 'closed') return json({ ok: true, unchanged: true });
    const w = await loadWorld(db, 'editor');
    const [report] = await budgetReport(ctx, w, indexWorld(w), [m.month]);
    await tx(db, [
      guardVersion(db, 'accounting_months', m.id, b.version),
      stmt(db, "UPDATE accounting_months SET status = 'closed', updated_at = ?, version = version + 1 WHERE id = ?", nowIso(), m.id),
      stmt(db, 'INSERT INTO month_snapshots (month_id, data, created_at, created_by) VALUES (?, ?, ?, ?)', m.id, JSON.stringify({ ...report, forecast: false, status: 'closed' }), nowIso(), user.id),
      auditStmt(db, user, 'budget', m.id, 'month_closed', [{ field: 'cost', old: null, new: report.cost }], b.reason ?? null),
    ]);
    return json({ ok: true });
  });

  // ───── team rates (admin) ─────
  r.get('/api/admin/team-rates', async (ctx) => {
    requirePerm(ctx, perms.admin);
    const w = await loadWorld(ctx.env.DB, 'editor');
    const rates = await loadRates(ctx, w);
    return json({ teams: w.teams.map((t) => ({ id: t.id, name: t.name, code: t.code, history: rates.filter((x) => x.team_id === t.id).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)) })) });
  });

  r.post('/api/admin/team-rates', async (ctx) => {
    const user = requirePerm(ctx, perms.admin);
    const b = await readJson(ctx, z.object({
      team_id: z.string(),
      rate_rub_per_hour: z.number().min(0).max(1_000_000),
      include_in_budget: z.boolean(),
      effective_sprint_id: z.string(),
      note: z.string().trim().max(300).optional(),
    }));
    const db = ctx.env.DB;
    if (!(await first(db, 'SELECT 1 FROM resource_teams WHERE id = ?', b.team_id))) throw badRequest('Команда не найдена');
    const s = await first(db, 'SELECT * FROM sprints WHERE id = ?', b.effective_sprint_id);
    if (!s) throw badRequest('Спринт не найден');
    if (s.status === 'closed') throw badRequest('Ставка не может начинаться с закрытого спринта');
    // a month already closed after this date keeps its snapshot anyway; warn but allow from an open sprint
    const exists = await first(db, 'SELECT 1 FROM team_rates WHERE team_id = ? AND effective_from = ?', b.team_id, s.start_date);
    if (exists) throw conflict('exists', `Ставка с начала спринта ${s.code} уже задана — история не редактируется, выберите следующий спринт`);
    const id = newId('rate');
    await tx(db, [
      stmt(db, 'INSERT INTO team_rates (id, team_id, effective_sprint_id, effective_from, rate_rub_per_hour, include_in_budget, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, b.team_id, s.id, s.start_date, b.rate_rub_per_hour, b.include_in_budget ? 1 : 0, b.note ?? null, nowIso(), user.id),
      auditStmt(db, user, 'team_rate', b.team_id, 'rate_added', [{ field: 'rate', old: null, new: b.rate_rub_per_hour }, { field: 'from_sprint', old: null, new: s.code }, { field: 'include_in_budget', old: null, new: b.include_in_budget }]),
    ]);
    return json({ id }, 201);
  });
}

/** monthly rouble limit + sprint team availability check when a task enters a sprint (manual mode: explicit confirmation with a reason) */
export async function budgetImpact(ctx: Ctx, featureId: string, sprintId: string) {
  const w = await loadWorld(ctx.env.DB, 'editor');
  const idx = indexWorld(w);
  const f = idx.feature.get(featureId);
  const s = idx.sprint.get(sprintId);
  if (!f || !s || !isPlannable(f)) return [];
  const known = f.planned_start && f.planned_end && f.planned_start <= f.planned_end;
  const task: BudgetTask = {
    id: f.id, key: `RF-${f.number}`, title: f.title, from: known ? f.planned_start : s.start_date, to: known ? f.planned_end : s.end_date, rateDate: s.start_date,
    estimates: Object.fromEntries((idx.estimatesBy.get(f.id) ?? []).map((e) => [e.team_id, Number(e.hours)])),
  };
  const months = [...new Set([task.from.slice(0, 7), task.to.slice(0, 7), s.start_date.slice(0, 7), s.end_date.slice(0, 7)])].sort();
  const report = await budgetReport(ctx, w, idx, months, task);
  const names = new Map(w.teams.map((t) => [t.id, t.name]));
  const caps = await all(ctx.env.DB, 'SELECT * FROM sprint_capacities WHERE sprint_id = ?', s.id);
  const load = sprintLoad(w, idx, s.id, task);
  // only what THIS task adds can need a confirmation: a task without hours (or without cost in a month) never does,
  // even when the sprint / month is already over its limit
  const adds = (team: string) => (task.estimates[team] ?? 0) > 0;
  return [
    ...report.flatMap((m: any) => (m.over_budget && (m.tasks ?? []).some((t: any) => t.id === task.id && t.cost > 0) ? [{ month: m.month, kind: 'budget', limit: m.budget_limit_rub, value: m.cost }] : [])),
    ...caps.filter((c) => adds(c.team_id) && (load[c.team_id] ?? 0) > Number(c.hours))
      .map((c) => ({ sprint: s.code, kind: 'capacity', team: names.get(c.team_id) ?? c.team_id, limit: Number(c.hours), value: load[c.team_id] })),
  ];
}

export { monthDates };

import { z } from 'zod';
import { capacityKey, computeLoad } from '../domain/capacity';
import { buildPlan, sortPeriods, type PlannerFeature, type PlannerInput } from '../domain/planner';
import { LOCKED_IN_PERIOD_SQL, planAlertIfStmt } from '../lib/alerts';
import { perms, requirePerm, requireUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { all, bool, first, newId, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { indexWorld, loadWorld, viewerOf, type Indexes, type World } from '../lib/world';

export function activePeriods(w: World) {
  return sortPeriods(w.periods.filter((p) => bool(p.is_active)).map((p) => ({ id: p.id, name: p.name, startDate: p.start_date, endDate: p.end_date })));
}

export function currentPeriodId(w: World, today = new Date().toISOString().slice(0, 10)): string | null {
  const ps = activePeriods(w);
  return (ps.find((p) => p.startDate <= today && p.endDate >= today) ?? ps.find((p) => p.startDate > today) ?? ps[ps.length - 1])?.id ?? null;
}

export function capacityMap(w: World) {
  return new Map(w.capacities.map((c) => [capacityKey(c.period_id, c.team_id), Number(c.hours)]));
}

export function estimatesOf(idx: Indexes, featureId: string): Record<string, number> {
  return Object.fromEntries((idx.estimatesBy.get(featureId) ?? []).map((e) => [e.team_id, Number(e.hours)]));
}

export function currentLoad(w: World, idx: Indexes) {
  const periods = activePeriods(w);
  const teams = w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name }));
  const features = w.features
    .filter((f) => !f.merged_into_id && f.period_id && idx.status.get(f.status_id)?.semantic !== 'cancelled')
    .map((f) => ({ id: f.id, periodId: f.period_id, estimates: estimatesOf(idx, f.id) }));
  return computeLoad(periods, teams, capacityMap(w), features);
}

function plannerInput(w: World, idx: Indexes, params: { startPeriodId: string; horizon: number }): PlannerInput {
  const approvedRelease = (fid: string) => {
    const rid = idx.releaseOf.get(fid);
    return !!(rid && idx.release.get(rid)?.approved_at);
  };
  const features: PlannerFeature[] = w.features
    .filter((f) => !f.merged_into_id)
    .map((f) => {
      const pr = idx.priority.get(f.id)!;
      const st = idx.status.get(f.status_id);
      return {
        id: f.id, number: f.number, title: f.title, semantic: st?.semantic ?? 'new', statusName: st?.name ?? '',
        estimates: estimatesOf(idx, f.id), periodId: f.period_id ?? null, fixed: bool(f.placement_locked) || approvedRelease(f.id),
        score: pr.score, productScore: pr.productScore, createdAt: f.created_at,
      };
    });
  const blocks = w.relations
    .filter((r) => r.type === 'blocks' && !idx.feature.get(r.from_id)?.merged_into_id && !idx.feature.get(r.to_id)?.merged_into_id)
    .map((r) => [r.from_id, r.to_id] as [string, string]);
  return {
    periods: activePeriods(w),
    teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name })),
    capacities: capacityMap(w),
    features,
    blocks,
    params,
  };
}

/** Canonical hash of everything the planner depends on (TZ §15.7). */
async function inputHash(input: PlannerInput) {
  const canon = {
    periods: input.periods,
    teams: input.teams,
    capacities: [...input.capacities.entries()].sort(),
    features: input.features.slice().sort((a, b) => a.number - b.number),
    blocks: input.blocks.slice().sort(),
    params: input.params,
  };
  return sha256Hex(JSON.stringify(canon));
}

function runDto(run: Row, w: World, idx: Indexes) {
  const result = parseJson<Row>(run.result, {});
  const label = (id: string) => {
    const f = idx.feature.get(id);
    return f ? { id, key: `RF-${f.number}`, title: f.title, visibility: f.visibility, score: idx.priority.get(id)?.score ?? null } : { id, key: '—', title: '' };
  };
  return {
    id: run.id,
    status: run.status,
    created_at: run.created_at,
    approved_at: run.approved_at,
    params: parseJson(run.params, {}),
    input_hash: run.input_hash,
    horizon_period_ids: result.horizonPeriodIds ?? [],
    placements: (result.placements ?? []).map((p: Row) => ({ ...p, feature: label(p.featureId) })),
    unplaced: (result.unplaced ?? []).map((u: Row) => ({ ...u, feature: label(u.featureId) })),
    load: result.load ?? [],
  };
}

export function registerPlanningRoutes(r: Router) {
  r.get('/api/planning', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB);
    if (viewer === 'guest' && w.settings.public_show_capacity !== '1') throw forbidden('Ресурсный план доступен сотрудникам');
    const idx = indexWorld(w);
    const alerts = viewer === 'guest' ? [] : await all(ctx.env.DB, 'SELECT * FROM plan_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100');
    const lastRun = viewer === 'editor' ? await first(ctx.env.DB, `SELECT * FROM plan_runs WHERE status IN ('proposed','approved') ORDER BY created_at DESC LIMIT 1`) : null;
    return json({
      periods: activePeriods(w),
      current_period_id: currentPeriodId(w),
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      capacities: w.capacities.map((c) => ({ period_id: c.period_id, team_id: c.team_id, hours: c.hours, version: viewer === 'guest' ? undefined : c.version })),
      load: currentLoad(w, idx),
      alerts,
      last_run: lastRun ? runDto(lastRun, w, idx) : null,
      horizon: Number(w.settings.planning_horizon || 3),
    });
  });

  r.put('/api/planning/capacity', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ period_id: z.string(), team_id: z.string(), hours: z.number().min(0).max(100000), version: z.number().int().nullable() }));
    const db = ctx.env.DB;
    const period = await first(db, 'SELECT * FROM capacity_periods WHERE id = ?', b.period_id);
    const team = await first(db, 'SELECT * FROM resource_teams WHERE id = ?', b.team_id);
    if (!period || !team) throw badRequest('Период или команда не найдены');
    const cur = await first(db, 'SELECT * FROM team_capacities WHERE period_id = ? AND team_id = ?', b.period_id, b.team_id);
    if ((cur?.version ?? null) !== b.version) throw conflict('version_conflict', 'Ёмкость уже изменил другой пользователь. Обновите данные.', { current: cur?.hours ?? null });
    if (cur && cur.hours === b.hours) return json({ ok: true, unchanged: true });
    const now = nowIso();
    await tx(db, [
      cur
        ? stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'cap' WHERE NOT EXISTS (SELECT 1 FROM team_capacities WHERE period_id = ? AND team_id = ? AND version = ?)`, b.period_id, b.team_id, cur.version)
        : stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'cap' WHERE EXISTS (SELECT 1 FROM team_capacities WHERE period_id = ? AND team_id = ?)`, b.period_id, b.team_id),
      cur
        ? stmt(db, 'UPDATE team_capacities SET hours = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE period_id = ? AND team_id = ?', b.hours, now, user.id, b.period_id, b.team_id)
        : stmt(db, 'INSERT INTO team_capacities (period_id, team_id, hours, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)', b.period_id, b.team_id, b.hours, now, user.id),
      auditStmt(db, user, 'capacity', `${b.period_id}:${b.team_id}`, 'capacity_changed', [{ field: `${team.name}, ${period.name}`, old: cur?.hours ?? null, new: b.hours }]),
      planAlertIfStmt(db, 'capacity_changed', `Изменена ёмкость «${team.name}» в периоде «${period.name}» (${cur?.hours ?? 0} → ${b.hours} ч) — проверьте утверждённый план`, 'period', period.id, LOCKED_IN_PERIOD_SQL, period.id),
    ], 'Ёмкость уже изменил другой пользователь. Обновите данные.');
    return json({ ok: true });
  });

  r.post('/api/planning/propose', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ start_period_id: z.string().optional(), horizon: z.number().int().min(1).max(24).optional() }));
    const w = await loadWorld(ctx.env.DB);
    const idx = indexWorld(w);
    const start = b.start_period_id ?? currentPeriodId(w);
    if (!start) throw badRequest('Нет активных плановых периодов — добавьте их в администрировании');
    if (!w.periods.some((p) => p.id === start)) throw badRequest('Период не найден');
    const params = { startPeriodId: start, horizon: b.horizon ?? Number(w.settings.planning_horizon || 3) };
    const input = plannerInput(w, idx, params);
    const result = buildPlan(input);
    const hash = await inputHash(input);
    const versions = Object.fromEntries(w.features.filter((f) => !f.merged_into_id).map((f) => [f.id, f.version]));
    const id = newId('plan');
    const db = ctx.env.DB;
    await tx(db, [
      stmt(db, `UPDATE plan_runs SET status = 'discarded' WHERE status = 'proposed'`),
      stmt(db, 'INSERT INTO plan_runs (id, created_at, created_by, params, input_hash, result, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, nowIso(), user.id, JSON.stringify({ ...params, versions }), hash, JSON.stringify(result), 'proposed'),
      auditStmt(db, user, 'plan', id, 'proposed', [{ field: 'params', old: null, new: params }]),
    ]);
    const run = await first(db, 'SELECT * FROM plan_runs WHERE id = ?', id);
    return json({ run: runDto(run!, w, idx) }, 201);
  });

  r.get('/api/planning/runs/:id', async (ctx) => {
    requirePerm(ctx, perms.plan);
    const w = await loadWorld(ctx.env.DB);
    const run = await first(ctx.env.DB, 'SELECT * FROM plan_runs WHERE id = ?', ctx.params.id);
    if (!run) throw notFound('Расчёт не найден');
    return json({ run: runDto(run, w, indexWorld(w)) });
  });

  r.post('/api/planning/runs/:id/discard', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const db = ctx.env.DB;
    await tx(db, [
      stmt(db, `UPDATE plan_runs SET status = 'discarded' WHERE id = ? AND status = 'proposed'`, ctx.params.id),
      auditStmt(db, user, 'plan', ctx.params.id, 'discarded'),
    ]);
    return json({ ok: true });
  });

  /** Product team confirms the suggested plan (all placements or a subset). Nothing is applied automatically. */
  r.post('/api/planning/runs/:id/approve', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const b = await readJson(ctx, z.object({ feature_ids: z.array(z.string()).optional() }));
    const db = ctx.env.DB;
    const run = await first(db, 'SELECT * FROM plan_runs WHERE id = ?', ctx.params.id);
    if (!run) throw notFound('Расчёт не найден');
    if (run.status !== 'proposed') throw conflict('not_proposed', 'Этот расчёт уже утверждён или отменён');
    const w = await loadWorld(db);
    const idx = indexWorld(w);
    const params = parseJson<Row>(run.params, {});
    const input = plannerInput(w, idx, { startPeriodId: params.startPeriodId, horizon: params.horizon });
    if ((await inputHash(input)) !== run.input_hash) {
      throw conflict('stale', 'После расчёта изменились приоритеты, оценки, ёмкость или статусы. Сформируйте предлагаемый план заново.');
    }
    const result = parseJson<Row>(run.result, {});
    const selected = new Set(b.feature_ids ?? (result.placements ?? []).map((p: Row) => p.featureId));
    const plannedStatus = w.statuses.filter((s) => s.entity === 'feature' && s.semantic === 'planned' && bool(s.is_active)).sort((a, b2) => a.sort_order - b2.sort_order)[0];
    const now = nowIso();
    const st = [stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'plan' WHERE NOT EXISTS (SELECT 1 FROM plan_runs WHERE id = ? AND status = 'proposed')`, run.id)];
    let applied = 0;
    for (const p of result.placements ?? []) {
      if (p.kind !== 'proposed' || !selected.has(p.featureId)) continue;
      const f = idx.feature.get(p.featureId);
      if (!f) continue;
      const sem = idx.status.get(f.status_id)?.semantic;
      const newStatus = sem === 'ready' && plannedStatus ? plannedStatus.id : f.status_id;
      st.push(stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'plan' WHERE NOT EXISTS (SELECT 1 FROM features WHERE id = ? AND version = ?)`, f.id, params.versions?.[f.id] ?? f.version));
      st.push(stmt(db, 'UPDATE features SET period_id = ?, placement_locked = 1, status_id = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', p.periodId, newStatus, now, user.id, f.id));
      const changes = [{ field: 'period_id', old: f.period_id, new: p.periodId }, { field: 'placement_locked', old: f.placement_locked, new: 1 }];
      if (newStatus !== f.status_id) changes.push({ field: 'status_id', old: f.status_id, new: newStatus });
      st.push(auditStmt(db, user, 'placement', f.id, 'plan_approved', changes, `План ${run.id}`));
      applied++;
    }
    st.push(stmt(db, `UPDATE plan_runs SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?`, now, user.id, run.id));
    st.push(stmt(db, `UPDATE plan_alerts SET resolved_at = ?, resolved_by = ? WHERE resolved_at IS NULL`, now, user.id));
    st.push(auditStmt(db, user, 'plan', run.id, 'approved', [{ field: 'placements', old: null, new: applied }]));
    await tx(db, st, 'Карточки изменились после расчёта. Сформируйте план заново.');
    return json({ ok: true, applied });
  });

  r.get('/api/planning/alerts', async (ctx) => {
    requireUser(ctx);
    return json({ alerts: await all(ctx.env.DB, 'SELECT * FROM plan_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100') });
  });

  r.post('/api/planning/alerts/:id/resolve', async (ctx) => {
    const user = requirePerm(ctx, perms.plan);
    const db = ctx.env.DB;
    const target = ctx.params.id;
    await tx(db, [
      target === 'all'
        ? stmt(db, 'UPDATE plan_alerts SET resolved_at = ?, resolved_by = ? WHERE resolved_at IS NULL', nowIso(), user.id)
        : stmt(db, 'UPDATE plan_alerts SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL', nowIso(), user.id, target),
      auditStmt(db, user, 'plan_alert', target, 'resolved'),
    ]);
    return json({ ok: true });
  });
}

export type { Ctx };

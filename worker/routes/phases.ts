// Task phases (vNext ТЗ §2.2–2.3): timeline, confirmed transitions, fact corrections, forecasts, baseline revisions.
// Who confirms a transition: any employee of the product department (owner decision 13.10) — role product/admin or a
// member of a department marked «продуктовый». Every write is audited on the task.
import { z } from 'zod';
import { computeTimeline, PHASE_LABEL, PHASES, planOf, type Baseline, type Forecast, type Phase, type PhaseEvent, type Timeline } from '../domain/phases';
import { perms, requirePerm, requireUser, type SessionUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { all, first, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, forbidden, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { canSeeFeature, indexWorld, loadWorld, viewerOf, type Indexes } from '../lib/world';
import { resolveFeature } from './features';
import type { D1Database } from '../env';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);

export interface PhaseData {
  baselines: Map<string, Baseline & { id: string }>; // latest revision per task
  events: Map<string, (PhaseEvent & Row)[]>;
  forecasts: Map<string, Forecast[]>;
  stagePhase: Map<string, Phase>;
}

/** everything the timelines need, for all tasks at once (the Gantt) or for one task */
export async function loadPhaseData(db: D1Database, featureId?: string): Promise<PhaseData> {
  const where = featureId ? ' WHERE feature_id = ?' : '';
  const args = featureId ? [featureId] : [];
  const [bl, ev, fc, st] = await Promise.all([
    all(db, `SELECT * FROM feature_plan_baselines${where} ORDER BY feature_id, revision`, ...args),
    all(db, `SELECT * FROM feature_phase_events${where} ORDER BY at, created_at, rowid`, ...args),
    all(db, `SELECT * FROM feature_phase_forecasts${where}`, ...args),
    all(db, 'SELECT id, phase FROM stages WHERE phase IS NOT NULL'),
  ]);
  const baselines = new Map<string, any>();
  for (const b of bl) baselines.set(b.feature_id, b); // ordered by revision: the latest wins
  const group = <T extends Row>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.feature_id) ?? m.set(r.feature_id, []).get(r.feature_id)!).push(r);
    return m;
  };
  return { baselines, events: group(ev) as any, forecasts: group(fc) as any, stagePhase: new Map(st.map((s) => [s.id, s.phase as Phase])) };
}

export function timelineFor(f: Row, idx: Indexes, data: PhaseData, on = today()): Timeline {
  const sprint = f.sprint_id ? idx.sprint.get(f.sprint_id) ?? null : null;
  return computeTimeline(
    {
      task_kind: f.task_kind, done: idx.status.get(f.status_id)?.semantic === 'done', closed_at: f.closed_at,
      planned_start: f.planned_start, planned_end: f.planned_end, planned_production_date: f.planned_production_date,
      stage_phase: f.stage_id ? data.stagePhase.get(f.stage_id) ?? null : null,
    },
    sprint as any, data.baselines.get(f.id) ?? null, data.events.get(f.id) ?? [], data.forecasts.get(f.id) ?? [], on,
  );
}

/** «любой сотрудник продуктового отдела»: product / admin role or membership in a product department */
export async function canConfirmPhase(db: D1Database, user: SessionUser | null): Promise<boolean> {
  if (!user) return false;
  if (user.apiKey && !user.apiKey.scopes.includes('tasks:update')) return false;
  if (perms.editCatalog(user)) return true;
  if (!user.departmentIds.length) return false;
  const prod = await all(db, `SELECT id FROM departments WHERE is_product = 1 AND is_active = 1`);
  return prod.some((d) => user.departmentIds.includes(d.id));
}

async function requirePhaseRight(ctx: Ctx): Promise<SessionUser> {
  const user = requireUser(ctx);
  if (!(await canConfirmPhase(ctx.env.DB, user))) throw forbidden('Этапы задачи подтверждают сотрудники продуктового отдела');
  return user;
}

/**
 * Baseline revision statements for a planned task (approval of the release plan, or an explicit re-baseline).
 * The very first revision also fixes features.baseline_production_date (the «first promise» used by analytics).
 */
export async function baselineStatements(db: D1Database, user: SessionUser, f: Row, reason: string | null, releaseId: string | null) {
  const sprint = f.sprint_id ? await first(db, 'SELECT * FROM sprints WHERE id = ?', f.sprint_id) : null;
  const p = planOf({ task_kind: f.task_kind, done: false, planned_start: f.planned_start, planned_end: f.planned_end, planned_production_date: f.planned_production_date }, sprint as any);
  const prev = await first<{ n: number }>(db, 'SELECT COALESCE(MAX(revision), 0) AS n FROM feature_plan_baselines WHERE feature_id = ?', f.id);
  const revision = (prev?.n ?? 0) + 1;
  const now = nowIso();
  const st = [
    stmt(db, `INSERT INTO feature_plan_baselines (id, feature_id, revision, release_id, sprint_id, dev_start, dev_end, qa_start, qa_end, release_date, reason, captured_at, captured_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('bl'), f.id, revision, releaseId, f.sprint_id ?? null, p.dev?.start ?? null, p.dev?.end ?? null, p.qa?.start ?? null, p.qa?.end ?? null, p.release, reason, now, user.id),
    auditStmt(db, user, 'feature', f.id, revision === 1 ? 'baseline_captured' : 'baseline_revised', [
      { field: 'baseline', old: revision === 1 ? null : `ревизия ${revision - 1}`, new: `ревизия ${revision}: разработка ${p.dev ? `${p.dev.start}…${p.dev.end}` : '—'}, выкладка ${p.release ?? '—'}` },
    ], reason),
  ];
  if (revision === 1 && p.release && !f.baseline_production_date) {
    st.push(stmt(db, 'UPDATE features SET baseline_production_date = ? WHERE id = ? AND baseline_production_date IS NULL', p.release, f.id));
  }
  return { statements: st, revision };
}

/** baselines for the planned tasks of an approved release that have none yet */
export async function releaseBaselineStatements(db: D1Database, user: SessionUser, releaseId: string) {
  const rows = await all(db, `SELECT f.* FROM features f JOIN release_features rf ON rf.feature_id = f.id
    WHERE rf.release_id = ? AND COALESCE(f.task_kind, 'planned') = 'planned' AND f.is_product_internal = 0 AND f.merged_into_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM feature_plan_baselines b WHERE b.feature_id = f.id)`, releaseId);
  const out = [];
  for (const f of rows) out.push(...(await baselineStatements(db, user, f, 'Утверждён план релиза', releaseId)).statements);
  return out;
}

export function registerPhaseRoutes(r: Router) {
  r.get('/api/features/:id/phases', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const f = await resolveFeature(ctx, ctx.params.id);
    const w = await loadWorld(ctx.env.DB, viewer, { includeInternal: viewer === 'editor' });
    const idx = indexWorld(w);
    const row = idx.feature.get(f.id);
    if (!row || !canSeeFeature(viewer, row)) throw notFound('Задача не найдена');
    const data = await loadPhaseData(ctx.env.DB, f.id);
    const revisions = await all(ctx.env.DB, 'SELECT b.*, u.name AS captured_by_name FROM feature_plan_baselines b LEFT JOIN users u ON u.id = b.captured_by WHERE b.feature_id = ? ORDER BY revision', f.id);
    const events = viewer === 'guest' ? [] : await all(ctx.env.DB, `SELECT e.id, e.phase, e.kind, e.at, e.original_at, e.reason, e.created_at, u.name AS created_by_name, c.name AS corrected_by_name
      FROM feature_phase_events e LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users c ON c.id = e.corrected_by WHERE e.feature_id = ? ORDER BY e.at, e.created_at, e.rowid`, f.id);
    return json({
      timeline: timelineFor(row, idx, data),
      phases: PHASES.map((p) => ({ code: p, name: PHASE_LABEL[p] })),
      baselines: viewer === 'guest' ? [] : revisions.map((b) => ({ revision: b.revision, dev_start: b.dev_start, dev_end: b.dev_end, qa_start: b.qa_start, qa_end: b.qa_end, release_date: b.release_date, reason: b.reason, captured_at: b.captured_at, captured_by: b.captured_by_name })),
      events,
      can_confirm: await canConfirmPhase(ctx.env.DB, ctx.user),
      can_rebaseline: perms.plan(ctx.user),
    });
  });

  /**
   * Move the task to a phase (or finish the current one with `phase: 'complete'`). The date defaults to today; an
   * earlier date is a fact entered later (audited). The previous active phase is completed on the same date.
   */
  r.post('/api/features/:id/phase', async (ctx) => {
    const user = await requirePhaseRight(ctx);
    const b = await readJson(ctx, z.object({ phase: z.enum([...PHASES, 'complete'] as [string, ...string[]]), at: isoDate.optional(), reason: z.string().trim().max(500).optional() }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const db = ctx.env.DB;
    const at = b.at ?? today();
    if (at > today()) throw badRequest('Факт не может быть в будущем — для будущего срока задайте прогноз');
    const data = await loadPhaseData(db, f.id);
    const w = await loadWorld(db, 'editor', { includeInternal: true });
    const idx = indexWorld(w);
    const tl = timelineFor(f, idx, data, at);
    const active = tl.phases.filter((p) => p.state === 'active').map((p) => p.phase as Phase).concat(tl.release.state === 'active' ? ['release'] : []);
    const now = nowIso();
    const st = [];
    const ev = (phase: string, kind: 'start' | 'done') => stmt(db, 'INSERT INTO feature_phase_events (id, feature_id, phase, kind, at, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('pe'), f.id, phase, kind, at, b.reason ?? null, now, user.id);
    for (const p of active) if (p !== b.phase) st.push(ev(p, 'done'));
    if (b.phase !== 'complete' && !active.includes(b.phase as Phase)) st.push(ev(b.phase, 'start'));
    if (!st.length) return json({ ok: true, unchanged: true });
    // the card's stage follows the phase (keep Backend / Frontend when it is already a development stage)
    if (b.phase !== 'complete') {
      const cur = f.stage_id ? data.stagePhase.get(f.stage_id) : null;
      if (cur !== b.phase) {
        const stage = await first(db, 'SELECT id FROM stages WHERE phase = ? AND is_active = 1 ORDER BY sort_order LIMIT 1', b.phase);
        if (stage) st.push(stmt(db, 'UPDATE features SET stage_id = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', stage.id, now, user.id, f.id));
      }
    }
    const label = (p: string) => (p === 'complete' ? 'завершение' : PHASE_LABEL[p as Phase]);
    st.push(auditStmt(db, user, 'feature', f.id, 'phase_changed', [{ field: 'phase', old: active.map((p) => PHASE_LABEL[p]).join(', ') || null, new: `${label(b.phase)} (${at})` }], b.reason ?? (at !== today() ? 'Факт внесён задним числом' : null)));
    await tx(db, st);
    return json({ ok: true });
  });

  /** correct the date of a confirmed fact (the original date is kept) */
  r.patch('/api/phase-events/:id', async (ctx) => {
    const user = await requirePhaseRight(ctx);
    const b = await readJson(ctx, z.object({ at: isoDate, reason: z.string().trim().min(1, 'Укажите причину исправления').max(500) }));
    const db = ctx.env.DB;
    const e = await first(db, 'SELECT * FROM feature_phase_events WHERE id = ?', ctx.params.id);
    if (!e) throw notFound('Событие этапа не найдено');
    await resolveFeature(ctx, e.feature_id); // hidden tasks stay hidden
    if (b.at > today()) throw badRequest('Факт не может быть в будущем');
    if (b.at === e.at) return json({ ok: true, unchanged: true });
    await tx(db, [
      stmt(db, 'UPDATE feature_phase_events SET at = ?, original_at = COALESCE(original_at, ?), reason = ?, corrected_at = ?, corrected_by = ? WHERE id = ?', b.at, e.at, b.reason, nowIso(), user.id, e.id),
      auditStmt(db, user, 'feature', e.feature_id, 'phase_fact_corrected', [{ field: `${PHASE_LABEL[e.phase as Phase]}: ${e.kind === 'start' ? 'начало' : 'завершение'}`, old: e.at, new: b.at }], b.reason, true),
    ]);
    return json({ ok: true });
  });

  /** Product forecast of an unfinished phase (delay or early finish) — never a baseline change */
  r.put('/api/features/:id/phase-forecast', async (ctx) => {
    const user = await requirePhaseRight(ctx);
    const b = await readJson(ctx, z.object({ phase: z.enum(PHASES), end_date: isoDate.nullable(), reason: z.string().trim().max(500).optional() }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const db = ctx.env.DB;
    const cur = await first(db, 'SELECT * FROM feature_phase_forecasts WHERE feature_id = ? AND phase = ?', f.id, b.phase);
    if (b.end_date && !b.reason) throw badRequest('Укажите причину прогноза — её увидят в подсказке Ганта');
    if ((cur?.end_date ?? null) === b.end_date && (!b.end_date || cur?.reason === b.reason)) return json({ ok: true, unchanged: true });
    await tx(db, [
      b.end_date
        ? stmt(db, `INSERT INTO feature_phase_forecasts (feature_id, phase, end_date, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(feature_id, phase) DO UPDATE SET end_date = excluded.end_date, reason = excluded.reason, created_at = excluded.created_at, created_by = excluded.created_by`,
          f.id, b.phase, b.end_date, b.reason, nowIso(), user.id)
        : stmt(db, 'DELETE FROM feature_phase_forecasts WHERE feature_id = ? AND phase = ?', f.id, b.phase),
      auditStmt(db, user, 'feature', f.id, 'phase_forecast', [{ field: `прогноз: ${PHASE_LABEL[b.phase]}`, old: cur?.end_date ?? null, new: b.end_date }], b.reason ?? null),
    ]);
    return json({ ok: true });
  });

  /** a revised agreement: new baseline revision from the current plan, with a reason (history keeps every revision) */
  r.post('/api/features/:id/baseline', async (ctx) => {
    const user = requirePerm(ctx, perms.plan, 'Пересматривать согласованный план может продуктовая команда');
    const b = await readJson(ctx, z.object({ reason: z.string().trim().min(1, 'Укажите причину пересмотра плана').max(500) }));
    const f = await resolveFeature(ctx, ctx.params.id);
    if ((f.task_kind ?? 'planned') !== 'planned') throw badRequest('Баги и оперативные доработки не согласовываются — у них нет исходного плана');
    if (!f.sprint_id) throw badRequest('Задача не в спринте: план не из чего зафиксировать');
    const rel = await first(ctx.env.DB, 'SELECT release_id FROM release_features WHERE feature_id = ?', f.id);
    const { statements, revision } = await baselineStatements(ctx.env.DB, user, f, b.reason, rel?.release_id ?? null);
    await tx(ctx.env.DB, statements);
    return json({ ok: true, revision });
  });
}

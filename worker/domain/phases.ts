// Phases of a task on the Gantt (vNext ТЗ §2.2–2.3). Pure — no I/O; used by the task card, the shared Gantt
// and the Product planner, so all of them show the same thing.
//
// Plan (computed, never typed in by hand):
//   Разработка  — the task's own dates when both planned_start and planned_end are set (an explicit individual
//                 constraint), otherwise sprint.start_date → sprint.end_date;
//   QA          — sprint.testing_start → sprint.production_due (only when that is a valid sequence);
//   Релиз       — a milestone: planned_production_date of the task, else sprint.production_due
//                 (bugs / improvements without a sprint: their fix date planned_end);
//   Продукт, Дизайн — no plan: shown only from confirmed facts (no reliable dates otherwise).
// Baseline: the plan captured when the release plan was approved (latest revision); never rewritten by moves.
// Facts: confirmed transitions only. A date passing never completes a phase — it becomes a risk instead.
// Forecast of an unfinished phase: Product's explicit forecast, else the plan end, else (overdue) today.

export const PHASES = ['product', 'design', 'dev', 'qa', 'release'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<Phase, string> = { product: 'Продукт', design: 'Дизайн', dev: 'Разработка', qa: 'QA', release: 'Релиз' };

export interface Range { start: string; end: string }
export interface PhaseEvent { id?: string; phase: Phase; kind: 'start' | 'done'; at: string }
export interface Baseline { revision: number; dev_start: string | null; dev_end: string | null; qa_start: string | null; qa_end: string | null; release_date: string | null; captured_at?: string; reason?: string | null }
export interface Forecast { phase: Phase; end_date: string; reason: string }
export interface SprintDates { start_date: string; end_date: string; testing_start: string; production_due: string }

export interface PhaseTask {
  task_kind?: string | null;
  done: boolean; // status semantic «done»
  closed_at?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  planned_production_date?: string | null;
  /** phase of the current stage (stage_id), if any */
  stage_phase?: Phase | null;
}

export type PhaseState = 'done' | 'active' | 'not_started' | 'unconfirmed' | 'skipped';

export interface PhaseView {
  phase: Phase;
  label: string;
  plan: Range | null;
  baseline: Range | null;
  fact: { start: string | null; end: string | null };
  /** end of the unfinished part (forecast); null for finished / not planned phases */
  forecast_end: string | null;
  forecast_reason: string | null;
  state: PhaseState;
  /** fact or forecast end − baseline end, calendar days (+ late, − early); null without a baseline */
  deviation_days: number | null;
  risk: string | null;
}

export interface Timeline {
  phases: PhaseView[]; // product, design, dev, qa
  release: { plan: string | null; baseline: string | null; fact: string | null; forecast: string | null; deviation_days: number | null; state: PhaseState; risk: string | null };
  current: Phase | null;
  /** a baseline exists (the release plan was approved); planned tasks without one are «не согласовано» */
  agreed: boolean;
  plan_source: 'task' | 'sprint' | 'none';
}

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
const valid = (r: Partial<Range> | null | undefined): r is Range => !!r?.start && !!r?.end && r.start <= r.end;

/** the plan of a task from its sprint and its own dates (also used to capture a baseline) */
export function planOf(task: PhaseTask, sprint: SprintDates | null): { dev: Range | null; qa: Range | null; release: string | null; source: Timeline['plan_source'] } {
  const own = { start: task.planned_start ?? '', end: task.planned_end ?? '' };
  const dev = valid(own) ? own : sprint ? { start: sprint.start_date, end: sprint.end_date } : null;
  const qaRange = sprint ? { start: sprint.testing_start, end: sprint.production_due } : null;
  const qa = qaRange && valid(qaRange) && (!dev || qaRange.end >= dev.end) ? qaRange : null;
  const kind = task.task_kind ?? 'planned';
  const release = task.planned_production_date ?? sprint?.production_due ?? (kind !== 'planned' ? task.planned_end ?? null : null);
  return { dev, qa, release, source: valid(own) ? 'task' : sprint ? 'sprint' : 'none' };
}

export function computeTimeline(task: PhaseTask, sprint: SprintDates | null, baseline: Baseline | null, events: PhaseEvent[], forecasts: Forecast[], today: string): Timeline {
  const plan = planOf(task, sprint);
  // Keep persisted insertion order on the same day: a later start reopens a phase.
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const first = (p: Phase, k: 'start' | 'done') => sorted.find((e) => e.phase === p && e.kind === k)?.at ?? null;
  const last = (p: Phase, k: 'start' | 'done') => [...sorted].reverse().find((e) => e.phase === p && e.kind === k)?.at ?? null;
  const latest = (p: Phase) => [...sorted].reverse().find((e) => e.phase === p);
  const fc = new Map(forecasts.map((f) => [f.phase, f]));
  const touched = (p: Phase) => sorted.some((e) => e.phase === p);
  const laterTouched = (p: Phase) => PHASES.slice(PHASES.indexOf(p) + 1).some((x) => touched(x)) || task.done;

  const planFor = (p: Phase): Range | null => (p === 'dev' ? plan.dev : p === 'qa' ? plan.qa : null);
  const baseFor = (p: Phase): Range | null => {
    if (!baseline) return null;
    const r = p === 'dev' ? { start: baseline.dev_start ?? '', end: baseline.dev_end ?? '' } : p === 'qa' ? { start: baseline.qa_start ?? '', end: baseline.qa_end ?? '' } : null;
    return valid(r) ? r : null;
  };

  const phases: PhaseView[] = (['product', 'design', 'dev', 'qa'] as const).map((p) => {
    const pl = planFor(p);
    const base = baseFor(p);
    const start = first(p, 'start');
    // a phase reopened after «done» counts as active again: the latest «done» must come after the latest «start»
    const lastDone = last(p, 'done');
    const isDone = latest(p)?.kind === 'done';
    const f = fc.get(p);
    let state: PhaseState;
    let forecast: string | null = null;
    let risk: string | null = null;
    if (isDone) state = 'done';
    else if (task.done) state = touched(p) || pl ? 'done' : 'skipped';
    else if (start) state = 'active';
    else if (laterTouched(p)) state = 'skipped';
    else if (pl && pl.start <= today) state = 'unconfirmed';
    else state = 'not_started';
    if (state === 'active') {
      forecast = f?.end_date ?? (pl && pl.end >= today ? pl.end : today);
      if (!f && pl && pl.end < today) risk = `Срок этапа прошёл ${fmt(pl.end)}, завершение не подтверждено`;
    } else if (state === 'unconfirmed') {
      forecast = f?.end_date ?? pl!.end;
      risk = `Начало этапа (${fmt(pl!.start)}) не подтверждено`;
      if (pl!.end < today && !f) risk = `Этап по плану закончился ${fmt(pl!.end)}, но не подтверждён`;
    } else if (state === 'not_started' && pl) {
      forecast = f?.end_date ?? null;
    }
    const factEnd = state === 'done' ? lastDone ?? null : null;
    const endForDeviation = factEnd ?? forecast;
    return {
      phase: p, label: PHASE_LABEL[p], plan: pl, baseline: base,
      fact: { start, end: factEnd },
      forecast_end: state === 'done' || state === 'skipped' ? null : forecast,
      forecast_reason: f && state !== 'done' ? f.reason : null,
      state,
      deviation_days: base && endForDeviation ? daysBetween(base.end, endForDeviation) : null,
      risk,
    };
  });

  // release milestone
  const relDone = (latest('release')?.kind === 'done' ? last('release', 'done') : null) ?? (task.done ? task.closed_at ?? null : null);
  const relFc = fc.get('release');
  const relBase = baseline?.release_date ?? null;
  let relState: PhaseState = relDone ? 'done' : touched('release') ? 'active' : plan.release && plan.release < today ? 'unconfirmed' : 'not_started';
  if (!plan.release && !relDone && !touched('release')) relState = 'not_started';
  // the release cannot happen before the phases before it end: their forecasts push it (Product's own forecast wins)
  const before = phases.map((x) => (x.state === 'done' ? null : x.forecast_end)).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const auto = plan.release ? (plan.release >= today ? plan.release : today) : null;
  const pushed = auto && before && before > auto ? before : auto;
  const relForecast = relDone ? null : relFc?.end_date ?? pushed;
  const release = {
    plan: plan.release, baseline: relBase, fact: relDone, forecast: relForecast, state: relState,
    deviation_days: relBase && (relDone ?? relForecast) ? daysBetween(relBase, (relDone ?? relForecast)!) : null,
    risk: relState === 'unconfirmed' && !relFc ? `Плановая выкладка ${fmt(plan.release!)} прошла, выкладка не подтверждена`
      : !relDone && !relFc && pushed && auto && pushed > auto ? `Выкладка сдвигается: предыдущий этап закончится ${fmt(pushed)}` : null,
  };

  const active = [...PHASES].reverse().find((p) => {
    if (p === 'release') return touched('release') && !relDone;
    return phases.find((x) => x.phase === p)?.state === 'active';
  }) ?? null;
  return {
    phases, release,
    current: task.done ? null : active ?? task.stage_phase ?? null,
    agreed: !!baseline,
    plan_source: plan.source,
  };
}

const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

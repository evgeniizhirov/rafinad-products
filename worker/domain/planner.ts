// Deterministic "suggested plan" (TZ §7.1, §15.7).
// Same input → same output: every ordering is explicit and stable.

import { capacityKey, computeLoad, round1, type PeriodIn, type TeamIn, type TeamLoad } from './capacity';
import type { Edge } from './graph';
import { compareByPriority } from './priority';

export interface PlannerFeature {
  id: string;
  number: number;
  title: string;
  semantic: string; // status semantic
  statusName: string;
  estimates: Record<string, number>; // teamId → hours (only estimated teams)
  periodId: string | null;
  /** placement confirmed by the product team or the feature is part of an approved release */
  fixed: boolean;
  score: number | null;
  productScore: number | null;
  createdAt: string;
}

export interface PlannerParams {
  startPeriodId: string;
  horizon: number;
}

export interface PlannerInput {
  periods: PeriodIn[]; // all active periods
  teams: TeamIn[];
  capacities: Map<string, number>;
  features: PlannerFeature[];
  blocks: Edge[];
  params: PlannerParams;
}

export type ReasonCode =
  | 'status'
  | 'not_estimated'
  | 'dependency'
  | 'capacity'
  | 'too_big'
  | 'horizon';

export interface Placement {
  featureId: string;
  periodId: string;
  previousPeriodId: string | null;
  kind: 'fixed' | 'kept' | 'proposed';
}

export interface Unplaced {
  featureId: string;
  code: ReasonCode;
  reasons: string[];
}

export interface PlannerResult {
  horizonPeriodIds: string[];
  placements: Placement[];
  unplaced: Unplaced[];
  load: TeamLoad[];
}

const ELIGIBLE = new Set(['ready', 'planned', 'in_progress']);
const STATUS_REASON: Record<string, string> = {
  done: 'Задача завершена',
  cancelled: 'Задача отменена',
  postponed: 'Задача отложена',
  blocked: 'Задача в статусе «Заблокирована»',
  new: 'Задача не готова к планированию (статус «Новая»)',
  analysis: 'Задача не готова к планированию (на проработке)',
};

const fmtH = (h: number) => `${round1(h)} ч`;

export function sortPeriods(periods: PeriodIn[]): PeriodIn[] {
  return periods.slice().sort((a, b) => (a.startDate === b.startDate ? (a.id < b.id ? -1 : 1) : a.startDate < b.startDate ? -1 : 1));
}

export function buildPlan(input: PlannerInput): PlannerResult {
  const periods = sortPeriods(input.periods);
  const periodIndex = new Map(periods.map((p, i) => [p.id, i]));
  const startIdx = Math.max(0, periodIndex.get(input.params.startPeriodId) ?? 0);
  const horizon = periods.slice(startIdx, startIdx + Math.max(1, input.params.horizon));
  const horizonIdx = new Map(horizon.map((p, i) => [p.id, i]));
  const teamName = new Map(input.teams.map((t) => [t.id, t.name]));
  const periodName = new Map(periods.map((p) => [p.id, p.name]));
  const byId = new Map(input.features.map((f) => [f.id, f]));
  const label = (id: string) => {
    const f = byId.get(id);
    return f ? `RF-${f.number}` : 'внутренняя задача';
  };

  // remaining capacity per period/team in horizon
  const remaining = new Map<string, number>();
  for (const p of horizon) for (const t of input.teams) remaining.set(capacityKey(p.id, t.id), input.capacities.get(capacityKey(p.id, t.id)) ?? 0);
  const consume = (periodId: string, est: Record<string, number>) => {
    for (const [teamId, h] of Object.entries(est)) {
      const k = capacityKey(periodId, teamId);
      if (remaining.has(k)) remaining.set(k, remaining.get(k)! - h);
    }
  };

  const placements: Placement[] = [];
  const loadFeatures: { id: string; periodId: string; estimates: Record<string, number> }[] = [];
  const placedAt = new Map<string, number>(); // featureId → absolute period index
  const unplaced: Unplaced[] = [];

  // 1. Fixed placements and work that already started keep their period and consume capacity.
  const sortedAll = input.features.slice().sort((a, b) => a.number - b.number);
  for (const f of sortedAll) {
    if (!f.periodId || !periodIndex.has(f.periodId)) continue;
    const keep = f.fixed || f.semantic === 'in_progress' || f.semantic === 'done';
    if (!keep) continue;
    placedAt.set(f.id, periodIndex.get(f.periodId)!);
    if (horizonIdx.has(f.periodId)) {
      consume(f.periodId, f.estimates);
      loadFeatures.push({ id: f.id, periodId: f.periodId, estimates: f.estimates });
      if (f.semantic !== 'done') placements.push({ featureId: f.id, periodId: f.periodId, previousPeriodId: f.periodId, kind: f.fixed ? 'fixed' : 'kept' });
    }
  }

  // 2. Candidates.
  const candidates: PlannerFeature[] = [];
  for (const f of input.features) {
    if (placedAt.has(f.id)) continue;
    if (!ELIGIBLE.has(f.semantic)) {
      unplaced.push({ featureId: f.id, code: 'status', reasons: [STATUS_REASON[f.semantic] ?? `Статус «${f.statusName}» исключён из планирования`] });
      continue;
    }
    const positive = Object.values(f.estimates).some((h) => h > 0);
    if (!positive) {
      unplaced.push({ featureId: f.id, code: 'not_estimated', reasons: ['Нет оценки трудозатрат — задача не оценена'] });
      continue;
    }
    candidates.push(f);
  }
  candidates.sort(compareByPriority);

  const blockersOf = new Map<string, string[]>();
  for (const [from, to] of input.blocks) {
    if (!blockersOf.has(to)) blockersOf.set(to, []);
    blockersOf.get(to)!.push(from);
  }
  for (const list of blockersOf.values()) list.sort();

  const failed = new Set<string>(unplaced.map((u) => u.featureId));
  const pending = new Set(candidates.map((c) => c.id));

  /** earliest absolute period index allowed by dependencies, or a reason why none */
  const dependencyState = (f: PlannerFeature): { ok: true; minIdx: number } | { ok: false; wait: boolean; reasons: string[] } => {
    let minIdx = -1;
    const reasons: string[] = [];
    let wait = false;
    for (const b of blockersOf.get(f.id) ?? []) {
      const bf = byId.get(b);
      if (bf && bf.semantic === 'done') continue;
      if (placedAt.has(b)) {
        minIdx = Math.max(minIdx, placedAt.get(b)!);
        continue;
      }
      if (pending.has(b)) {
        wait = true;
        reasons.push(`Не запланирована блокирующая задача ${label(b)}`);
        continue;
      }
      if (bf?.semantic === 'cancelled') reasons.push(`Блокирующая задача ${label(b)} отменена — пересмотрите связь`);
      else reasons.push(`Не завершена зависимость ${label(b)}${bf ? ` (${bf.statusName})` : ''}`);
    }
    if (reasons.length) return { ok: false, wait, reasons };
    return { ok: true, minIdx: minIdx + 1 };
  };

  const fits = (periodId: string, est: Record<string, number>) =>
    Object.entries(est).every(([teamId, h]) => h <= 0 || (remaining.get(capacityKey(periodId, teamId)) ?? 0) >= h - 1e-9);

  // 3. Multi-pass placement: a blocker placed later in the pass unlocks its dependants on the next pass.
  let progress = true;
  while (progress) {
    progress = false;
    for (const f of candidates) {
      if (!pending.has(f.id)) continue;
      const dep = dependencyState(f);
      if (!dep.ok) {
        if (!dep.wait) {
          pending.delete(f.id);
          failed.add(f.id);
          unplaced.push({ featureId: f.id, code: 'dependency', reasons: dep.reasons });
          progress = true;
        }
        continue;
      }
      const target = horizon.find((p) => periodIndex.get(p.id)! >= dep.minIdx && fits(p.id, f.estimates));
      if (target) {
        consume(target.id, f.estimates);
        loadFeatures.push({ id: f.id, periodId: target.id, estimates: f.estimates });
        placedAt.set(f.id, periodIndex.get(target.id)!);
        pending.delete(f.id);
        placements.push({ featureId: f.id, periodId: target.id, previousPeriodId: f.periodId, kind: 'proposed' });
        progress = true;
      }
    }
    // candidates that are not waiting on anything and still unplaced cannot fit — stop when nothing moved
  }

  // 4. Explain everything that is still pending.
  for (const f of candidates) {
    if (!pending.has(f.id)) continue;
    const dep = dependencyState(f);
    if (!dep.ok) {
      unplaced.push({ featureId: f.id, code: 'dependency', reasons: dep.reasons });
      continue;
    }
    const allowed = horizon.filter((p) => periodIndex.get(p.id)! >= dep.minIdx);
    if (!allowed.length) {
      unplaced.push({ featureId: f.id, code: 'horizon', reasons: ['Зависимости выполняются только в конце горизонта планирования — нет следующего периода'] });
      continue;
    }
    const tooBig: string[] = [];
    for (const [teamId, h] of Object.entries(f.estimates)) {
      if (h <= 0) continue;
      const maxCap = Math.max(0, ...allowed.map((p) => input.capacities.get(capacityKey(p.id, teamId)) ?? 0));
      if (h > maxCap) tooBig.push(`${teamName.get(teamId) ?? teamId}: нужно ${fmtH(h)}, максимум за период ${fmtH(maxCap)}`);
    }
    if (tooBig.length) {
      unplaced.push({ featureId: f.id, code: 'too_big', reasons: [`Объём больше ёмкости команды в любом периоде горизонта — разбейте задачу на этапы (${tooBig.join('; ')})`] });
      continue;
    }
    // find the period with the smallest total deficit and explain it
    let best: { periodId: string; deficits: [string, number][]; total: number } | null = null;
    for (const p of allowed) {
      const deficits: [string, number][] = [];
      for (const [teamId, h] of Object.entries(f.estimates)) {
        if (h <= 0) continue;
        const rem = remaining.get(capacityKey(p.id, teamId)) ?? 0;
        if (rem < h) deficits.push([teamId, h - Math.max(0, rem)]);
      }
      const total = deficits.reduce((s, [, d]) => s + d, 0);
      if (!best || total < best.total) best = { periodId: p.id, deficits, total };
    }
    const parts = best!.deficits
      .sort((a, b) => (teamName.get(a[0]) ?? a[0]).localeCompare(teamName.get(b[0]) ?? b[0], 'ru'))
      .map(([teamId, d]) => `${fmtH(d)} ${teamName.get(teamId) ?? teamId}`);
    unplaced.push({ featureId: f.id, code: 'capacity', reasons: [`Не хватает ${parts.join(', ')} (ближайший период: ${periodName.get(best!.periodId)})`] });
  }

  // stable output ordering
  const order = new Map(input.features.map((f) => [f.id, f.number]));
  placements.sort((a, b) => (periodIndex.get(a.periodId)! - periodIndex.get(b.periodId)!) || order.get(a.featureId)! - order.get(b.featureId)!);
  unplaced.sort((a, b) => order.get(a.featureId)! - order.get(b.featureId)!);

  const load = computeLoad(horizon, input.teams, input.capacities, loadFeatures);
  return { horizonPeriodIds: horizon.map((p) => p.id), placements, unplaced, load };
}

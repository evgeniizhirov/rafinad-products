// Analytics (FR-11). Every figure is computed over tasks the viewer may see (hidden Product tasks are not in the world),
// by status SEMANTIC (renaming a status changes nothing), and returns the ids behind it for the drill-down.
import { bool, type Row } from '../lib/db';
import { initiatorDto, type Indexes, type World } from '../lib/world';

export interface HistoryEvent {
  entity_id: string;
  at: string;
  action: string;
  changes: { field: string; old: unknown; new: unknown }[] | null;
  api_key_id?: string | null;
}

export interface Metric {
  value: number | null;
  ids: string[];
  /** reason when the value cannot be computed honestly */
  insufficient?: string;
  extra?: Record<string, unknown>;
}

const m = (ids: string[], extra?: Record<string, unknown>): Metric => ({ value: ids.length, ids, ...(extra ? { extra } : {}) });
const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / DAY);

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (i - lo)) * 10) / 10;
}

/** status history per task, from audit; null = history not reliable (no creation record) */
export function statusHistory(events: HistoryEvent[], w: World, idx: Indexes) {
  const sem = (id: unknown) => (typeof id === 'string' ? idx.status.get(id)?.semantic ?? null : null);
  const byTask = new Map<string, { born: boolean; transitions: { at: string; from: string | null; to: string | null }[] }>();
  for (const e of [...events].sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (!byTask.has(e.entity_id)) byTask.set(e.entity_id, { born: false, transitions: [] });
    const h = byTask.get(e.entity_id)!;
    if (e.action === 'created' || e.action === 'import_created') h.born = true;
    for (const c of e.changes ?? []) if (c.field === 'status_id') h.transitions.push({ at: e.at, from: sem(c.old), to: sem(c.new) });
  }
  return (f: Row) => {
    const h = byTask.get(f.id);
    if (!h?.born) return null;
    // the state at creation = "from" of the first transition (or the current status when it never changed)
    const initial = h.transitions[0]?.from ?? idx.status.get(f.status_id)?.semantic ?? null;
    return [{ at: f.created_at, from: null, to: initial }, ...h.transitions];
  };
}

export interface AnalyticsInput {
  rows: Row[]; // tasks after filters (already ACL-checked)
  w: World;
  idx: Indexes;
  events: HistoryEvent[];
  from: string; // YYYY-MM-DD
  to: string;
  today: string;
  highThreshold: number;
}

export function analytics({ rows, w, idx, events, from, to, today, highThreshold }: AnalyticsInput) {
  const semOf = (f: Row) => idx.status.get(f.status_id)?.semantic ?? 'new';
  const inPeriod = (d: string | null | undefined) => !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const ids = (xs: Row[]) => xs.map((f) => f.id);
  const kind = (f: Row) => f.task_kind ?? 'planned';
  const open = rows.filter((f) => !['done', 'cancelled'].includes(semOf(f)));
  const history = statusHistory(events, w, idx);

  // ── A. volume & operations ──
  const received = rows.filter((f) => inPeriod(f.requested_at ?? f.created_at));
  const closedInPeriod = rows.filter((f) => semOf(f) === 'done' && inPeriod(f.closed_at));
  const deadline = (f: Row) => (kind(f) === 'planned' ? f.planned_production_date ?? f.planned_end : f.planned_end);
  const overdue = open.filter((f) => deadline(f) && deadline(f) < today);
  const blocked = open.filter((f) => semOf(f) === 'blocked' || (idx.openBlockersBy.get(f.id) ?? []).length > 0);
  const volume = {
    received: m(ids(received)),
    open: m(ids(open)),
    in_progress: m(ids(rows.filter((f) => ['in_progress', 'analysis'].includes(semOf(f))))),
    done_in_period: m(ids(closedInPeriod)),
    cancelled: m(ids(rows.filter((f) => semOf(f) === 'cancelled'))),
    postponed: m(ids(rows.filter((f) => semOf(f) === 'postponed'))),
    overdue: m(ids(overdue)),
    blocked: m(ids(blocked)),
    bugs_new: m(ids(received.filter((f) => kind(f) === 'bug'))),
    bugs_active: m(ids(open.filter((f) => kind(f) === 'bug'))),
    bugs_resolved: m(ids(closedInPeriod.filter((f) => kind(f) === 'bug'))),
    improvements: m(ids(received.filter((f) => kind(f) === 'operational_improvement'))),
  };

  // timeliness: done in period, actual closed_at vs the FIRST promised date (never the last moved one)
  const baselineOf = (f: Row) => f.baseline_production_date ?? null;
  const withBaseline = closedInPeriod.filter((f) => baselineOf(f));
  const onTime = withBaseline.filter((f) => f.closed_at.slice(0, 10) <= baselineOf(f));
  const timeliness: Metric = withBaseline.length
    ? { value: Math.round((onTime.length / withBaseline.length) * 100), ids: ids(onTime), extra: { on_time: onTime.length, with_baseline: withBaseline.length, without_baseline: ids(closedInPeriod.filter((f) => !baselineOf(f))) } }
    : { value: null, ids: [], insufficient: 'нет завершённых задач с зафиксированным первоначальным сроком', extra: { without_baseline: ids(closedInPeriod) } };

  // cycle time: first entry into analysis/in_progress → done, only where both timestamps are in the history
  const cycle = (k: 'bug' | 'planned') => {
    const xs: number[] = [];
    const used: string[] = [];
    for (const f of closedInPeriod.filter((x) => (k === 'bug' ? kind(x) !== 'planned' : kind(x) === 'planned'))) {
      const h = history(f);
      if (!h) continue;
      const start = h.find((t) => t.to === 'in_progress' || t.to === 'analysis');
      const end = [...h].reverse().find((t) => t.to === 'done');
      if (start && end && end.at >= start.at) {
        xs.push(days(start.at, end.at));
        used.push(f.id);
      }
    }
    return xs.length >= 3
      ? { value: percentile(xs, 0.5), ids: used, extra: { p75: percentile(xs, 0.75), p90: percentile(xs, 0.9), n: xs.length } }
      : { value: null, ids: used, insufficient: `недостаточно данных: ${xs.length} задач с датами начала и завершения в истории (нужно ≥ 3)` };
  };

  // blockers by business owner
  const owners = new Map<string, { owner: string; count: number; days: number; overdue: number; ids: string[] }>();
  for (const f of open) {
    for (const b of idx.openBlockersBy.get(f.id) ?? []) {
      const owner = (b.owner_department_id ? w.departments.find((d) => d.id === b.owner_department_id)?.name : null) ?? b.owner_name ?? 'не указан';
      const o = owners.get(owner) ?? { owner, count: 0, days: 0, overdue: 0, ids: [] as string[] };
      o.count++;
      o.days += Math.max(0, days(b.started_at, today));
      if (b.due_at && b.due_at < today) o.overdue++;
      o.ids.push(f.id);
      owners.set(owner, o);
    }
  }

  // release discipline: focus commitments of releases whose final date has passed
  const pastReleases = w.releases.filter((r) => r.planned_date && r.planned_date < today && inPeriod(r.planned_date));
  const commitments = rows.filter((f) => bool(f.is_focus) && pastReleases.some((r) => idx.releaseOf.get(f.id) === r.id));
  const delivered = commitments.filter((f) => {
    const r = idx.release.get(idx.releaseOf.get(f.id)!);
    return semOf(f) === 'done' && f.closed_at && f.closed_at.slice(0, 10) <= r!.planned_date;
  });
  const discipline: Metric = commitments.length
    ? { value: Math.round((delivered.length / commitments.length) * 100), ids: ids(delivered), extra: { delivered: delivered.length, committed: commitments.length, missed: ids(commitments.filter((f) => !delivered.includes(f))) } }
    : { value: null, ids: [], insufficient: 'в периоде нет релизов с прошедшей датой и фокусными задачами' };

  // ── B. who creates tasks: author (created_by) ≠ initiator ──
  const userName = (id: string | null) => (id ? w.users.find((u) => u.id === id)?.name ?? 'удалённый пользователь' : 'не указан');
  const viaKey = new Set(events.filter((e) => (e.action === 'created') && e.api_key_id).map((e) => e.entity_id));
  const group = (key: (f: Row) => string) => {
    const g = new Map<string, Row[]>();
    for (const f of received) {
      const k = key(f);
      g.set(k, [...(g.get(k) ?? []), f]);
    }
    return [...g.entries()].map(([name, xs]) => ({
      name, count: xs.length, ids: ids(xs),
      by_kind: Object.fromEntries(['planned', 'bug', 'operational_improvement'].map((k) => [k, xs.filter((x) => kind(x) === k).length])),
      done: xs.filter((x) => semOf(x) === 'done').length,
      via_api_key: xs.filter((x) => viaKey.has(x.id)).length,
    })).sort((a, b) => b.count - a.count);
  };
  const creators = {
    by_author: group((f) => userName(f.created_by ?? null)),
    by_initiator: group((f) => { const i = initiatorDto(f, w); return i ? `${i.name}${i.type === 'department' ? ' (отдел)' : ''}` : 'не указан'; }),
  };

  // ── C. demand: high weighted priority, conversion, "demanded and delivered" (needs reliable history) ──
  const planned = rows.filter((f) => kind(f) === 'planned');
  const score = (f: Row) => idx.priority.get(f.id)?.score ?? null;
  const voted = planned.filter((f) => score(f) !== null);
  const high = voted.filter((f) => (score(f) as number) >= highThreshold);
  const top = voted.filter((f) => (score(f) as number) >= 5);
  const bySem = (xs: Row[]) => Object.fromEntries(['new', 'analysis', 'ready', 'planned', 'in_progress', 'blocked', 'postponed', 'done', 'cancelled'].map((s) => [s, xs.filter((f) => semOf(f) === s).length]));
  const highDone = high.filter((f) => semOf(f) === 'done');
  let noHistory = 0;
  const clean: string[] = [];
  for (const f of highDone) {
    const h = history(f);
    if (!h) { noHistory++; continue; }
    if (!h.some((t) => t.to === 'postponed' || t.to === 'cancelled')) clean.push(f.id);
  }
  const demand = {
    threshold: highThreshold,
    voted: m(ids(voted)),
    high: m(ids(high), { share: voted.length ? Math.round((high.length / voted.length) * 100) : null, by_semantic: bySem(high) }),
    strictly_5: m(ids(top)),
    high_unresolved: m(ids(high.filter((f) => !['done', 'cancelled', 'postponed'].includes(semOf(f))))),
    demanded_delivered: highDone.length - noHistory > 0
      ? { value: clean.length, ids: clean, extra: { checked: highDone.length - noHistory, no_history: noHistory } }
      : { value: null, ids: [], insufficient: noHistory ? `нет истории статусов у ${noHistory} завершённых задач` : 'нет завершённых задач с высоким приоритетом' },
    conversion: { received: received.length, ...bySem(received) },
  };

  return {
    period: { from, to },
    volume,
    timeliness,
    cycle_time: { bugs: cycle('bug'), planned: cycle('planned') },
    blockers: [...owners.values()].sort((a, b) => b.days - a.days),
    release_discipline: discipline,
    creators,
    demand,
  };
}

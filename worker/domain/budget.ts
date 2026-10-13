// Monthly budget model (FR-05). Pure functions.
//
//   cost(task) = Σ over paid teams (include_in_budget) of estimate_hours × rate effective at the start of the task's sprint
//   Product / Design: hours count in availability, never in roubles.
//   A team without an estimate is "not estimated" (cost incomplete), an explicit 0 means "no work".
//   Only planned, non-hidden tasks with a sprint take part; bugs / operational fixes never do.
//
// Months vs sprints: a sprint may cross a month border. Forecast hours of a task are spread over the
// work interval (task planned_start..planned_end when both are known, otherwise the sprint dates):
//   'workdays'      — proportionally to Mon–Fri days in each month (default, open decision №2)
//   'calendar_days' — proportionally to calendar days
// Never "everything into the month of the production date". The result is always marked as a forecast.

export type Allocation = 'workdays' | 'calendar_days';

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** month (YYYY-MM) → share of the interval [from, to] (inclusive) */
export function splitByMonth(from: string, to: string, method: Allocation = 'workdays'): Map<string, number> {
  const counts = new Map<string, number>();
  let total = 0;
  for (let t = ms(from); t <= ms(to); t += DAY) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    if (method === 'workdays' && (wd === 0 || wd === 6)) continue;
    const m = d.toISOString().slice(0, 7);
    counts.set(m, (counts.get(m) ?? 0) + 1);
    total++;
  }
  if (!total) {
    // interval without working days (weekend only) — fall back to calendar days
    return method === 'workdays' ? splitByMonth(from, to, 'calendar_days') : new Map([[from.slice(0, 7), 1]]);
  }
  return new Map([...counts].map(([m, n]) => [m, n / total]));
}

export interface RateRow {
  team_id: string;
  effective_from: string;
  rate_rub_per_hour: number;
  include_in_budget: number | boolean;
}

/** the rate version in force on `date` (latest effective_from ≤ date) */
export function rateOn(rates: RateRow[], teamId: string, date: string): { rate: number; inBudget: boolean } | null {
  let best: RateRow | null = null;
  for (const r of rates) if (r.team_id === teamId && r.effective_from <= date && (!best || r.effective_from > best.effective_from)) best = r;
  return best ? { rate: Number(best.rate_rub_per_hour), inBudget: !!best.include_in_budget } : null;
}

export interface BudgetTask {
  id: string;
  key: string;
  title: string;
  from: string; // work interval
  to: string;
  rateDate: string; // sprint start: rates of this date apply
  estimates: Record<string, number>; // team → hours (explicit 0 allowed)
}

export interface MonthResult {
  month: string;
  cost: number;
  hours: Record<string, number>;
  incomplete: number; // tasks with a paid team not estimated
  tasks: { id: string; key: string; title: string; share: number; cost: number; incomplete: boolean }[];
}

export function monthlyForecast(tasks: BudgetTask[], rates: RateRow[], teams: { id: string; active: boolean }[], method: Allocation): Map<string, MonthResult> {
  const out = new Map<string, MonthResult>();
  const at = (m: string) => {
    if (!out.has(m)) out.set(m, { month: m, cost: 0, hours: {}, incomplete: 0, tasks: [] });
    return out.get(m)!;
  };
  for (const t of tasks) {
    let cost = 0;
    let incomplete = false;
    for (const team of teams.filter((x) => x.active)) {
      const r = rateOn(rates, team.id, t.rateDate);
      const h = t.estimates[team.id];
      if (h === undefined) {
        if (r?.inBudget) incomplete = true; // a paid team without an estimate: unknown, not zero
        continue;
      }
      if (r?.inBudget) cost += h * r.rate;
    }
    for (const [m, share] of splitByMonth(t.from, t.to, method)) {
      const res = at(m);
      const c = Math.round(cost * share * 100) / 100;
      res.cost = Math.round((res.cost + c) * 100) / 100;
      for (const [team, h] of Object.entries(t.estimates)) res.hours[team] = Math.round(((res.hours[team] ?? 0) + h * share) * 100) / 100;
      if (incomplete) res.incomplete++;
      res.tasks.push({ id: t.id, key: t.key, title: t.title, share: Math.round(share * 1000) / 1000, cost: c, incomplete });
    }
  }
  return out;
}

// Release / sprint / month calendar (FR-06). Pure date arithmetic, UTC ISO dates (YYYY-MM-DD).
//
// Rules (confirmed by the owner):
//   sprint      = 14 calendar days, Wednesday .. Tuesday inclusive
//   release     = two consecutive sprints (N.1, N.2)
//   testing     = starts the day after the sprint end
//   production  = deadline 9 calendar days after the sprint end (the Thursday of the following week)
//   reference   = release 8, sprint 8.1 starts 2026-10-07
// Calendar months (budget / availability) are independent of sprints.

export const SPRINT_DAYS = 14;
export const RELEASE_DAYS = 2 * SPRINT_DAYS;
export const PROD_OFFSET_DAYS = 9;

const DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso: string, n: number) => toIso(toMs(iso) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY);
/** 0 = Sunday … 3 = Wednesday */
export const weekday = (iso: string) => new Date(toMs(iso)).getUTCDay();

export interface CalendarAnchor {
  date: string; // start of sprint <release>.1
  release: number;
}

export interface SprintDates {
  ordinal: 1 | 2;
  code: string;
  start_date: string;
  end_date: string;
  testing_start: string;
  production_due: string;
}

export interface ReleaseCycle {
  cycle: number;
  start_date: string;
  /** final commitment deadline = production deadline of sprint 2 */
  production_due: string;
  sprints: [SprintDates, SprintDates];
}

export function validateAnchor(a: CalendarAnchor): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || Number.isNaN(toMs(a.date))) return 'Опорная дата должна быть в формате ГГГГ-ММ-ДД';
  if (weekday(a.date) !== 3) return 'Опорная дата спринта должна быть средой';
  if (!Number.isInteger(a.release) || a.release < 1) return 'Номер опорного релиза — целое число больше нуля';
  return null;
}

export function sprintDates(cycle: number, ordinal: 1 | 2, start: string): SprintDates {
  const end = addDays(start, SPRINT_DAYS - 1);
  return { ordinal, code: `${cycle}.${ordinal}`, start_date: start, end_date: end, testing_start: addDays(end, 1), production_due: addDays(end, PROD_OFFSET_DAYS) };
}

export function releaseCycle(anchor: CalendarAnchor, cycle: number): ReleaseCycle {
  const start = addDays(anchor.date, (cycle - anchor.release) * RELEASE_DAYS);
  const s1 = sprintDates(cycle, 1, start);
  const s2 = sprintDates(cycle, 2, addDays(start, SPRINT_DAYS));
  return { cycle, start_date: start, production_due: s2.production_due, sprints: [s1, s2] };
}

/** release cycle whose development window (both sprints) contains `date` */
export function cycleOn(anchor: CalendarAnchor, date: string): number {
  return anchor.release + Math.floor(daysBetween(anchor.date, date) / RELEASE_DAYS);
}

export interface MonthDates {
  month: string; // YYYY-MM
  start_date: string;
  end_date: string;
}

export function monthDates(month: string): MonthDates {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = toIso(Date.UTC(y, m, 0)); // day 0 of the next month = last day of this one
  return { month, start_date: start, end_date: end };
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export interface ExistingCalendar {
  releases: { id: string; cycle_number: number | null; name: string }[];
  sprints: { id: string; code: string; release_id: string; start_date: string; end_date: string }[];
  months: { month: string }[];
}

export interface GenerationPlan {
  window: { first_cycle: number; last_cycle: number; first_month: string; last_month: string };
  releases: { cycle: number; name: string; planned_date: string; existing_id: string | null }[];
  sprints: (SprintDates & { cycle: number })[];
  months: MonthDates[];
  skipped: { kind: 'sprint' | 'month' | 'release'; code: string; reason: string }[];
  conflicts: { code: string; reason: string }[];
}

/**
 * What a generation run would create. Idempotent by construction: the window depends only on the anchor,
 * the settings and `today`; everything that already exists (by cycle number / sprint code / month) is skipped.
 * Existing rows are never moved — a sprint edited by hand stays as it is and is only reported.
 */
export function planGeneration(
  anchor: CalendarAnchor,
  existing: ExistingCalendar,
  opts: { today: string; releasesAhead: number; monthsAhead: number },
): GenerationPlan {
  const current = Math.max(anchor.release, cycleOn(anchor, opts.today));
  const firstCycle = anchor.release;
  const lastCycle = current + Math.max(1, opts.releasesAhead) - 1;
  const firstMonth = anchor.date.slice(0, 7) < opts.today.slice(0, 7) ? anchor.date.slice(0, 7) : opts.today.slice(0, 7);
  const lastMonth = addMonths(opts.today.slice(0, 7), Math.max(1, opts.monthsAhead) - 1);

  const plan: GenerationPlan = {
    window: { first_cycle: firstCycle, last_cycle: lastCycle, first_month: firstMonth, last_month: lastMonth },
    releases: [], sprints: [], months: [], skipped: [], conflicts: [],
  };
  const byCode = new Map(existing.sprints.map((s) => [s.code, s]));
  const relByCycle = new Map(existing.releases.filter((r) => r.cycle_number !== null).map((r) => [r.cycle_number as number, r]));

  for (let c = firstCycle; c <= lastCycle; c++) {
    const cyc = releaseCycle(anchor, c);
    const rel = relByCycle.get(c);
    const newSprints = cyc.sprints.filter((s) => {
      const ex = byCode.get(s.code);
      if (!ex) return true;
      plan.skipped.push({ kind: 'sprint', code: s.code, reason: ex.start_date === s.start_date && ex.end_date === s.end_date ? 'уже существует' : 'существует с изменёнными вручную датами — не трогаем' });
      return false;
    });
    const accepted: SprintDates[] = [];
    for (const s of newSprints) {
      const overlap = existing.sprints.find((x) => x.start_date <= s.end_date && x.end_date >= s.start_date);
      if (overlap) plan.conflicts.push({ code: s.code, reason: `пересекается со спринтом ${overlap.code} (${overlap.start_date} — ${overlap.end_date})` });
      else accepted.push(s);
    }
    plan.sprints.push(...accepted.map((s) => ({ ...s, cycle: c })));
    if (rel) plan.skipped.push({ kind: 'release', code: String(c), reason: `релиз «${rel.name}» уже существует` });
    if (accepted.length) plan.releases.push({ cycle: c, name: rel?.name ?? `Релиз ${c}`, planned_date: cyc.production_due, existing_id: rel?.id ?? null });
  }

  const haveMonths = new Set(existing.months.map((m) => m.month));
  for (let m = firstMonth; m <= lastMonth; m = addMonths(m, 1)) {
    if (haveMonths.has(m)) plan.skipped.push({ kind: 'month', code: m, reason: 'уже существует' });
    else plan.months.push(monthDates(m));
  }
  return plan;
}

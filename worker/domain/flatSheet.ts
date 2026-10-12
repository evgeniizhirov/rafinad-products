// "One sheet of tasks" import format (e.g. the TaskFlow tab of the department workload report).
// Turns a free-form task list into the canonical Features rows understood by the importer.
//
// The sheet has no ID column, so a stable ID is derived from the task text + assignee:
//   - re-ordering rows never changes matching;
//   - editing other columns (deadline, comment, hours, done…) updates the same card;
//   - renaming a task or reassigning it produces a new ID → the preview shows the old card as
//     a "possible duplicate" (same/similar title) and the user links it explicitly.
// If the sheet gets a real ID column later, map it in `columns.id` and it is used instead.

import { normalizeTitle, parseHours, sanitizeCell } from './text';

export interface FlatConfig {
  sheet: string;
  columns: {
    id?: string;
    title: string;
    description?: string;
    category?: string;
    assignee?: string;
    /** first non-empty column wins (e.g. «Новый срок», then «Изначальный срок») */
    deadline?: string[];
    closed_at?: string;
    /** yes/no column: «Да» → status «Завершена» */
    done?: string;
    /** sheet priority → tag «P1», «P2»… (department votes are never written by a sync) */
    priority?: string;
    /** actual hours → a line in the description */
    fact_hours?: string;
  };
  /** yes/no column → tag added when the cell says yes */
  flags: Record<string, string>;
  /** hours column → resource team code */
  hours: Record<string, string>;
}

export const TASKFLOW_CONFIG: FlatConfig = {
  sheet: 'TaskFlow',
  columns: {
    title: 'Задача',
    description: 'Комментарий',
    category: 'Категория',
    assignee: 'Сотрудник',
    deadline: ['Новый срок', 'Изначальный срок'],
    closed_at: 'Дата выполнения',
    done: 'Сделано',
    priority: 'Приоритет',
    fact_hours: 'Факт в часах',
  },
  flags: { 'Влетевшая': 'влетевшая' },
  hours: { 'Оценка в часах': 'product' },
};

/** canonical columns produced for the importer */
export const FLAT_CANONICAL = ['external_id', 'title', 'description', 'category', 'status', 'assignee', 'planned_end', 'closed_at', 'tags'] as const;

const YES = new Set(['да', 'yes', 'y', 'true', '1', '+', 'x', 'v', '✓', '✔', 'готово', 'сделано']);
export const isYes = (v: string) => YES.has(v.trim().toLowerCase());

const URL_RE = /https?:\/\/[^\s<>"]+/g;

/** FNV-1a based, deterministic and synchronous (ids must not depend on crypto availability) */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

export function derivedId(rawTitle: string, assignee: string): string {
  return `tf-${stableHash(`${normalizeTitle(rawTitle)}|${normalizeTitle(assignee)}`)}`;
}

/**
 * Cleans a task cell: URLs move to the description, the first remaining line becomes the title.
 * "https://portal/…/377550/\n- Контроль запуска…\n- поменять дату…" → title «Контроль запуска…».
 */
export function splitTaskCell(raw: string): { title: string; extraLines: string[]; links: string[] } {
  const links = [...new Set((raw.match(URL_RE) ?? []).map((u) => u.replace(/[).,;]+$/, '')))];
  const lines = raw
    .split('\n')
    .map((l) => l.replace(URL_RE, '').replace(/^[\s\-–—•*]+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let title = lines[0] ?? '';
  const extraLines = lines.slice(1);
  if (!title && links.length) {
    const num = /\/(\d{3,})\/?$/.exec(links[0])?.[1];
    title = num ? `Задача портала № ${num}` : `Задача по ссылке ${links[0].replace(/^https?:\/\//, '').slice(0, 80)}`;
  }
  if (title) title = title[0].toUpperCase() + title.slice(1);
  if (title.length > 300) {
    extraLines.unshift(title);
    title = `${title.slice(0, 297).trimEnd()}…`;
  }
  return { title, extraLines, links };
}

/** «19.10», «19.10.26», «19.10.2026», «2026-10-19» → ISO date; a missing year is the nearest one to `today` */
export function parseLooseDate(raw: string, today: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(s);
  if (!m) return null;
  const d = +m[1];
  const mo = +m[2];
  if (m[3]) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], mo, d);
  const ty = +today.slice(0, 4);
  const candidates = [ty - 1, ty, ty + 1].map((y) => iso(y, mo, d)).filter((x): x is string => !!x);
  const t = Date.parse(`${today}T00:00:00Z`);
  candidates.sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - t) - Math.abs(Date.parse(`${b}T00:00:00Z`) - t));
  return candidates[0] ?? null;
}

function iso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export interface FlatResult {
  /** canonical rows (index = sheet row index, so row numbers in messages match the sheet) */
  rows: string[][];
  /** mapped columns that are missing in the sheet header */
  missing: string[];
  /** sheet row index → derived (true) or explicit (false) id */
  derived: Map<number, boolean>;
  /** sheet row index → problems found while converting */
  problems: Map<number, string[]>;
}

const lc = (s: string) => s.trim().toLowerCase();

export function flatToCanonical(sheetRows: string[][], cfg: FlatConfig, teamCodes: string[], today: string): FlatResult {
  const header = (sheetRows[0] ?? []).map((h) => lc(sanitizeCell(h, 200)));
  const col = (name?: string) => (name ? header.indexOf(lc(name)) : -1);
  const c = cfg.columns;
  const mapped: [string, string | undefined][] = [
    ['title', c.title], ['id', c.id], ['description', c.description], ['category', c.category], ['assignee', c.assignee],
    ['closed_at', c.closed_at], ['done', c.done], ['priority', c.priority], ['fact_hours', c.fact_hours],
    ...(c.deadline ?? []).map((d) => ['deadline', d] as [string, string]),
    ...Object.keys(cfg.flags ?? {}).map((f) => ['flag', f] as [string, string]),
    ...Object.keys(cfg.hours ?? {}).map((h) => ['hours', h] as [string, string]),
  ];
  const missing = mapped.filter(([, name]) => name && col(name) < 0).map(([, name]) => name!);

  const hoursCols = Object.entries(cfg.hours ?? {})
    .map(([name, code]) => ({ i: col(name), code: lc(code), name }))
    .filter((h) => h.i >= 0 && teamCodes.includes(h.code));
  const teamOrder = [...new Set(hoursCols.map((h) => h.code))];
  const out: string[][] = [[...FLAT_CANONICAL, ...teamOrder.map((t) => `${t}_hours`)]];
  const derived = new Map<number, boolean>();
  const problems = new Map<number, string[]>();

  const get = (row: string[], name: string | undefined, max = 20000) => {
    const i = col(name);
    return i < 0 ? '' : sanitizeCell(row[i], max);
  };

  for (let r = 1; r < sheetRows.length; r++) {
    const row = sheetRows[r] ?? [];
    const rawTitle = get(row, c.title, 5000);
    const comment = get(row, c.description);
    const assignee = get(row, c.assignee, 200);
    if (!rawTitle && !comment && !assignee) {
      out.push([]); // blank / technical row: skipped silently, numbering preserved
      continue;
    }
    const issues: string[] = [];
    const { title, extraLines, links } = splitTaskCell(rawTitle);
    const explicitId = get(row, c.id, 200);
    const externalId = explicitId || (rawTitle ? derivedId(rawTitle, assignee) : '');
    derived.set(r, !explicitId);

    const fact = get(row, c.fact_hours, 50);
    const factHours = fact ? parseHours(fact) : { value: null };
    const parts: string[] = [];
    if (extraLines.length) parts.push(extraLines.map((l) => `- ${l}`).join('\n'));
    if (comment) parts.push(comment);
    if (links.length) parts.push(`Ссылки:\n${links.map((l) => `- ${l}`).join('\n')}`);
    if (factHours.value !== null) parts.push(`Факт: ${factHours.value} ч`);
    const description = parts.join('\n\n');

    let planned = '';
    for (const d of c.deadline ?? []) {
      const raw = get(row, d, 50);
      if (!raw) continue;
      const p = parseLooseDate(raw, today);
      if (p) {
        planned = p;
        break;
      }
      issues.push(`Срок «${raw}» не распознан (ожидается ДД.ММ или ДД.ММ.ГГГГ)`);
    }
    const closedRaw = get(row, c.closed_at, 50);
    const closed = closedRaw ? parseLooseDate(closedRaw, today) : null;
    if (closedRaw && !closed) issues.push(`Дата выполнения «${closedRaw}» не распознана`);

    const done = c.done ? isYes(get(row, c.done, 20)) || (!!closed && !get(row, c.done, 20)) : !!closed;
    const status = done ? 'done' : assignee ? 'in_progress' : 'new';

    const tags: string[] = [];
    const prio = get(row, c.priority, 20).replace(/\s/g, '');
    if (prio) tags.push(/^\d+$/.test(prio) ? `P${prio}` : prio);
    for (const [flagCol, tag] of Object.entries(cfg.flags ?? {})) if (isYes(get(row, flagCol, 20))) tags.push(tag);

    const hourCells = teamOrder.map((t) => {
      const h = hoursCols.find((x) => x.code === t)!;
      return get(row, h.name, 50);
    });

    if (issues.length) problems.set(r, issues);
    out.push([externalId, title, description, get(row, c.category, 200), status, assignee, planned, closed ?? '', tags.join(', '), ...hourCells]);
  }
  return { rows: out, missing, derived, problems };
}

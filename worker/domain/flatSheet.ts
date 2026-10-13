// "One sheet of tasks" import format (e.g. the TaskFlow tab of the department workload report).
// Turns a free-form task list into the canonical Features rows understood by the importer.
//
// The sheet has no ID column, so a stable ID is derived from the task text + assignee:
//   - re-ordering rows never changes matching;
//   - editing other columns (deadline, comment, hours, done…) updates the same card;
//   - renaming a task or reassigning it produces a new ID → the preview shows the old card as
//     a "possible duplicate" (same/similar title) and the user links it explicitly.
// If the sheet gets a real ID column later, map it in `columns.id` and it is used instead.

import { encodeLinks, readLinkCell, type SourceLink } from './linkImport';
import type { LinkKind } from './links';
import { normalizeTitle, parseHours, sanitizeCell } from './text';

export type FlatKind = 'planned' | 'bug' | 'operational_improvement';

export interface FlatConfig {
  sheet: string;
  /** work type of every task of this sheet (default: planned) */
  kind?: FlatKind;
  columns: {
    id?: string;
    /** regular expression that extracts the stable id from the id cell (e.g. a Jira key from a link) */
    id_pattern?: string;
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
    /** actual hours → a line in the description, or the fact_hours field (see fact_hours_as) */
    fact_hours?: string;
    /** text status column, translated with status_map («Новый», «В работе»…) */
    status?: string;
    /** urgency column (bugs), translated with urgency_map — never a department vote */
    urgency?: string;
    /** date the request came in */
    requested_at?: string;
    /** who asked: matched to a department / user by exact name on import, otherwise free text */
    initiator?: string;
    /** who registered the task (author_name) */
    author?: string;
    /** more columns appended to the description as «Колонка: значение» */
    extra?: string[];
  };
  /** lower-case cell → status code (new, analysis, in_progress, blocked, done, cancelled…) */
  status_map?: Record<string, string>;
  /** lower-case cell → low | medium | high | critical */
  urgency_map?: Record<string, string>;
  fact_hours_as?: 'description' | 'field';
  /** yes/no column → tag added when the cell says yes */
  flags: Record<string, string>;
  /** hours column → resource team code */
  hours: Record<string, string>;
  /** link column → kind of external link (vNext §3); a cell may hold several URLs */
  links?: Record<string, LinkKind>;
  /** also import URLs found in the task text and comment cells (kind guessed from the address) */
  links_from_text?: boolean;
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
  // URLs in the task cell (Bitrix24 / Jira links) become external links; the task text keeps them as before
  links_from_text: true,
};

export const DEFAULT_STATUS_MAP: Record<string, string> = {
  'новый': 'new', 'новая': 'new', 'открыт': 'new', 'не решено': 'new', 'бэклог': 'new',
  'в работе': 'in_progress', 'контроль': 'in_progress', 'тестирование': 'in_progress', 'на проверке': 'in_progress', 'ревью': 'in_progress',
  'блок': 'blocked', 'заблокирован': 'blocked', 'заблокирована': 'blocked', 'ожидание': 'blocked',
  'готово': 'done', 'решено': 'done', 'выполнено': 'done', 'сделано': 'done', 'закрыт': 'done', 'закрыта': 'done', 'выпущено': 'done', 'на проде': 'done',
  'отменен': 'cancelled', 'отменён': 'cancelled', 'отменена': 'cancelled', 'не актуально': 'cancelled', 'неактуально': 'cancelled',
  'отложено': 'postponed', 'отложен': 'postponed',
};

export const DEFAULT_URGENCY_MAP: Record<string, string> = {
  'низкий': 'low', 'низкая': 'low', 'low': 'low',
  'средний': 'medium', 'средняя': 'medium', 'medium': 'medium', 'обычный': 'medium',
  'высокий': 'high', 'высокая': 'high', 'high': 'high',
  'критический': 'critical', 'критичный': 'critical', 'блокер': 'critical', 'critical': 'critical',
};

const JIRA_KEY = '[A-Z][A-Z0-9]+-\\d+';

/** «Прием обращений по багам/доработкам», tab «Баги» (gid 0). Headers read from the real sheet on 2026-10-13. */
export const BUGS_CONFIG: FlatConfig = {
  sheet: 'Баги',
  kind: 'bug',
  columns: {
    id: 'задача в jira',
    id_pattern: JIRA_KEY,
    title: 'Название',
    description: 'На что влияет',
    status: 'Статус (блокируются задачи только по внешним причинам)',
    urgency: 'Приоритет',
    requested_at: 'Дата обращения в продуктовый отдел',
    deadline: ['Сроки релиза плановый'],
    closed_at: 'Сроки релиза фактический',
    initiator: 'Запрос от',
    author: 'Постановщик',
    fact_hours: 'фактическое кол-во часов',
    extra: ['Постановщик задачи', 'Комментарий', 'Комментарий 2', 'Проект'],
  },
  fact_hours_as: 'field',
  flags: { hotfix: 'hotfix' },
  hours: {},
  links: { 'задача в jira': 'jira' },
  links_from_text: true,
};

/** same spreadsheet, tab «Доработки» (gid 1405337906) */
export const IMPROVEMENTS_CONFIG: FlatConfig = {
  sheet: 'Доработки',
  kind: 'operational_improvement',
  columns: {
    id: 'задача в jira',
    id_pattern: JIRA_KEY,
    title: 'Название',
    description: 'Какую проблему решает',
    status: 'Статус',
    urgency: 'Приоритет',
    requested_at: 'Дата обращения в продуктовый отдел',
    deadline: ['Сроки релиза план'],
    closed_at: 'Сроки релиза факт',
    initiator: 'Запрос от',
    author: 'Постановщик задачи',
    fact_hours: 'факт. кол-во часов',
    extra: ['Комментарий', 'Проект', 'Отклонение от сроков'],
  },
  fact_hours_as: 'field',
  flags: { hotfix: 'hotfix' },
  hours: {},
  links: { 'задача в jira': 'jira' },
  links_from_text: true,
};

export const BUGS_SPREADSHEET_ID = '1woBVsLqhRY67EYh8BJYGSqGSEeYPyWfmpUDN9bZ4T-E';

/** canonical columns always produced for the importer (TaskFlow output is exactly these + hours) */
export const FLAT_CANONICAL = ['external_id', 'title', 'description', 'category', 'status', 'assignee', 'planned_end', 'closed_at', 'tags'] as const;
/** produced only when the sheet config maps them, so an existing source never gets new diffs */
const FLAT_OPTIONAL = ['requested_at', 'task_kind', 'urgency', 'fact_hours', 'initiator', 'author', 'links'] as const;

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

/** header / config names: case-insensitive, whitespace (incl. line breaks) collapsed */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * `hyperlinks` — the same grid as `sheetRows`, each cell holding the URLs hidden behind its text (Google Sheets
 * metadata, newline-separated). Absent for CSV: only the visible text can be read there.
 */
export function flatToCanonical(sheetRows: string[][], cfg: FlatConfig, teamCodes: string[], today: string, hyperlinks?: string[][]): FlatResult {
  const header = (sheetRows[0] ?? []).map((h) => norm(sanitizeCell(h, 300)));
  /** every column with this header (sheets often repeat a header, e.g. two «Комментарий») */
  const cols = (name?: string) => (name ? header.flatMap((h, i) => (h === norm(name) ? [i] : [])) : []);
  const col = (name?: string) => cols(name)[0] ?? -1;
  const c = cfg.columns;
  const mapped: [string, string | undefined][] = [
    ['title', c.title], ['id', c.id], ['description', c.description], ['category', c.category], ['assignee', c.assignee],
    ['closed_at', c.closed_at], ['done', c.done], ['priority', c.priority], ['fact_hours', c.fact_hours],
    ['status', c.status], ['urgency', c.urgency], ['requested_at', c.requested_at], ['initiator', c.initiator], ['author', c.author],
    ...(c.deadline ?? []).map((d) => ['deadline', d] as [string, string]),
    ...(c.extra ?? []).map((d) => ['extra', d] as [string, string]),
    ...Object.keys(cfg.flags ?? {}).map((f) => ['flag', f] as [string, string]),
    ...Object.keys(cfg.hours ?? {}).map((h) => ['hours', h] as [string, string]),
    ...Object.keys(cfg.links ?? {}).map((l) => ['link', l] as [string, string]),
  ];
  const missing = [...new Set(mapped.filter(([, name]) => name && col(name) < 0).map(([, name]) => name!))];

  const hoursCols = Object.entries(cfg.hours ?? {})
    .map(([name, code]) => ({ i: col(name), code: code.trim().toLowerCase(), name }))
    .filter((h) => h.i >= 0 && teamCodes.includes(h.code));
  const teamOrder = [...new Set(hoursCols.map((h) => h.code))];
  const factField = cfg.fact_hours_as === 'field';
  const linkCols = Object.entries(cfg.links ?? {}).map(([name, kind]) => ({ name, kind, idx: cols(name) })).filter((l) => l.idx.length);
  const hasLinks = linkCols.length > 0 || !!cfg.links_from_text;
  const optional = FLAT_OPTIONAL.filter((k) =>
    k === 'links' ? hasLinks
    : k === 'task_kind' ? !!cfg.kind && cfg.kind !== 'planned'
      : k === 'fact_hours' ? factField && col(c.fact_hours) >= 0
        : col(c[k]) >= 0);
  const out: string[][] = [[...FLAT_CANONICAL, ...optional, ...teamOrder.map((t) => `${t}_hours`)]];
  const derived = new Map<number, boolean>();
  const problems = new Map<number, string[]>();
  const statusMap: Record<string, string> = { ...DEFAULT_STATUS_MAP, ...lowerKeys(cfg.status_map) };
  const urgencyMap: Record<string, string> = { ...DEFAULT_URGENCY_MAP, ...lowerKeys(cfg.urgency_map) };
  const idRe = c.id_pattern ? new RegExp(c.id_pattern) : null;

  /** first non-empty value among the columns with this header */
  const get = (row: string[], name: string | undefined, max = 20000) => {
    for (const i of cols(name)) {
      const v = sanitizeCell(row[i], max);
      if (v) return v;
    }
    return '';
  };
  const date = (raw: string, label: string, issues: string[]) => {
    if (!raw) return '';
    const d = parseLooseDate(raw, today);
    if (!d) issues.push(`${label} «${raw}» не распознана (ожидается ДД.ММ или ДД.ММ.ГГГГ)`);
    return d ?? '';
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
    const idCell = get(row, c.id, 300);
    const idMatch = idCell && idRe ? idRe.exec(idCell) : null;
    const explicitId = idCell ? (idRe ? idMatch?.[1] ?? idMatch?.[0] ?? '' : idCell) : '';
    const externalId = explicitId || (rawTitle ? derivedId(rawTitle, assignee) : '');
    derived.set(r, !explicitId);

    const fact = get(row, c.fact_hours, 50);
    const factHours = fact ? parseHours(fact) : { value: null };
    if (fact && factHours.value === null) issues.push(`Факт часов «${fact}» не распознан`);
    const parts: string[] = [];
    if (extraLines.length) parts.push(extraLines.map((l) => `- ${l}`).join('\n'));
    if (comment) parts.push(comment);
    if (links.length) parts.push(`Ссылки:\n${links.map((l) => `- ${l}`).join('\n')}`);
    const extras = (c.extra ?? []).map((name) => [name, get(row, name, 5000)] as const).filter(([, v]) => v);
    if (extras.length) parts.push(extras.map(([name, v]) => `${name.trim()}: ${v}`).join('\n'));
    if (!factField && factHours.value !== null) parts.push(`Факт: ${factHours.value} ч`);
    const description = parts.join('\n\n');

    let planned = '';
    for (const d of c.deadline ?? []) {
      const raw = get(row, d, 50);
      if (!raw) continue;
      planned = date(raw, 'Срок', issues);
      if (planned) break;
    }
    const closed = date(get(row, c.closed_at, 50), 'Дата выполнения', issues);

    let status: string;
    if (c.status) {
      const raw = get(row, c.status, 100);
      const mappedStatus = raw ? statusMap[norm(raw)] ?? '' : '';
      if (raw && !mappedStatus) issues.push(`Статус «${raw}» не сопоставлен — статус карточки не меняется`);
      status = closed ? 'done' : mappedStatus || (raw ? '' : 'new');
    } else {
      const done = c.done ? isYes(get(row, c.done, 20)) || (!!closed && !get(row, c.done, 20)) : !!closed;
      status = done ? 'done' : assignee ? 'in_progress' : 'new';
    }

    const tags: string[] = [];
    const prio = get(row, c.priority, 20).replace(/\s/g, '');
    if (prio) tags.push(/^\d+$/.test(prio) ? `P${prio}` : prio);
    for (const [flagCol, tag] of Object.entries(cfg.flags ?? {})) if (isYes(get(row, flagCol, 20))) tags.push(tag);

    const opt: Record<string, string> = {};
    if (optional.includes('requested_at')) opt.requested_at = date(get(row, c.requested_at, 50), 'Дата обращения', issues);
    if (optional.includes('task_kind')) opt.task_kind = cfg.kind!;
    if (optional.includes('urgency')) {
      const raw = get(row, c.urgency, 50);
      opt.urgency = raw ? urgencyMap[norm(raw)] ?? '' : '';
      if (raw && !opt.urgency) issues.push(`Срочность «${raw}» не сопоставлена`);
    }
    if (optional.includes('fact_hours')) opt.fact_hours = factHours.value === null ? '' : String(factHours.value);
    if (optional.includes('initiator')) opt.initiator = get(row, c.initiator, 200);
    if (optional.includes('author')) opt.author = get(row, c.author, 200);
    if (optional.includes('links')) {
      // mapped link columns first (their kind wins), then URLs found in the task text / comment
      const found: SourceLink[] = [];
      const hyper = (i: number) => (hyperlinks?.[r]?.[i] ?? '').split('\n').map((u) => u.trim()).filter(Boolean);
      for (const lc of linkCols) {
        for (const i of lc.idx) {
          const res = readLinkCell(sanitizeCell(row[i], 5000), hyper(i), lc.name, lc.kind, true);
          found.push(...res.links);
          issues.push(...res.problems);
        }
      }
      if (cfg.links_from_text) {
        for (const name of [c.title, c.description]) {
          for (const i of cols(name)) found.push(...readLinkCell(sanitizeCell(row[i], 20000), hyper(i), name!, undefined, false).links);
        }
      }
      const seen = new Set<string>();
      opt.links = encodeLinks(found.filter((l) => !seen.has(l.url) && !!seen.add(l.url)));
    }

    const hourCells = teamOrder.map((t) => {
      const h = hoursCols.find((x) => x.code === t)!;
      return get(row, h.name, 50);
    });

    if (issues.length) problems.set(r, issues);
    out.push([externalId, title, description, get(row, c.category, 200), status, assignee, planned, closed, tags.join(', '), ...optional.map((k) => opt[k] ?? ''), ...hourCells]);
  }
  return { rows: out, missing, derived, problems };
}

function lowerKeys(m?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [norm(k), v]));
}

// Field catalog of the export builder (vNext ТЗ §3 «Экспорт ссылок», §4; owner decision 13.10 №15).
// Every field knows its group, label, type and how to read it from a task. The catalog is built per viewer:
// a field the viewer may not see is simply not in it, so it never reaches the client nor the file.
// The built-in «TaskFlow — 12 колонок» template is expressed with the same fields and gives exactly the old output.
import type { Row } from '../lib/db';
import { bool } from '../lib/db';
import { initiatorDto, isProductInternal, showEstimates, type Indexes, type Viewer, type World } from '../lib/world';
import { LINK_KIND_LABEL, LINK_KINDS } from './links';
import type { Timeline } from './phases';
import type { Cell } from './xlsx';

export type FieldType = 'text' | 'number' | 'date' | 'bool' | 'list' | 'lines';

export interface FieldDef {
  id: string;
  group: string;
  label: string;
  type: FieldType;
  /** numbers that make sense to add up in group subtotals */
  sum?: boolean;
  /** available for grouping (short categorical values) */
  groupable?: boolean;
  /** only product / admin may export it (it is never shown to other viewers) */
  editorOnly?: boolean;
  get: (f: Row) => unknown;
}

export interface FieldCtx {
  viewer: Viewer;
  w: World;
  idx: Indexes;
  /** proposals linked to each task: key + title */
  proposalsBy: Map<string, { key: string; title: string }[]>;
  timeline: (f: Row) => Timeline | null;
  rank: Map<string, number>;
}

export const FIELD_GROUPS = ['Основное', 'Люди', 'Сроки', 'Спринт и релиз', 'Приоритет', 'Часы', 'Внешние ссылки', 'TaskFlow'] as const;

const KIND_LABEL: Record<string, string> = { planned: 'Плановая', bug: 'Баг', operational_improvement: 'Оперативная доработка' };
const URGENCY_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая', critical: 'критическая' };
const VIS_LABEL: Record<string, string> = { draft: 'Черновик', internal: 'Для сотрудников', public: 'Публичная' };
const PHASE_LABEL: Record<string, string> = { product: 'Продукт', design: 'Дизайн', dev: 'Разработка', qa: 'QA', release: 'Выкладка' };

/** YYYY-MM-DD → DD.MM.YYYY (the sheet's date format; the importer reads it back) */
export const ruDate = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const FACT_LINE = /^Факт: ([\d.,]+) ч$/m;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** fact hours: the field (bugs, P05) or the «Факт: N ч» line the TaskFlow import writes into the description */
export function factHours(f: Row): number | null {
  if (f.fact_hours !== null && f.fact_hours !== undefined) return Number(f.fact_hours);
  const m = FACT_LINE.exec(f.description ?? '');
  return m ? Number(m[1].replace(',', '.')) : null;
}

/** a value as it goes into a cell */
export function formatCell(type: FieldType, v: unknown): Cell {
  if (v === null || v === undefined) return type === 'number' ? null : '';
  switch (type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? v : null;
    case 'date': return ruDate(v);
    case 'bool': return v ? 'Да' : 'Нет';
    case 'list': return (v as unknown[]).join(', ');
    case 'lines': return (v as unknown[]).join('\n'); // several links of one type: one cell, one per line (owner decision №15)
    default: return String(v);
  }
}

export function fieldCatalog(c: FieldCtx): FieldDef[] {
  const { w, idx, viewer } = c;
  const editor = viewer === 'editor';
  const tags = (f: Row) => idx.tagsBy.get(f.id) ?? [];
  const est = (f: Row) => idx.estimatesBy.get(f.id) ?? [];
  const deadline = (f: Row) => f.planned_production_date ?? f.planned_end ?? null;
  const release = (f: Row) => (idx.releaseOf.has(f.id) ? idx.release.get(idx.releaseOf.get(f.id)!) : undefined);
  const sprint = (f: Row) => (f.sprint_id ? idx.sprint.get(f.sprint_id) : undefined);
  const links = (f: Row, kind?: string) => (idx.linksBy.get(f.id) ?? []).filter((l) => !kind || l.kind === kind).map((l) => l.url);
  const fields: FieldDef[] = [
    // ── Основное
    { id: 'key', group: 'Основное', label: 'ID', type: 'text', get: (f) => `RF-${f.number}` },
    { id: 'title', group: 'Основное', label: 'Название', type: 'text', get: (f) => f.title },
    { id: 'description', group: 'Основное', label: 'Описание', type: 'text', get: (f) => f.description ?? '' },
    { id: 'kind', group: 'Основное', label: 'Тип работ', type: 'text', groupable: true, get: (f) => KIND_LABEL[f.task_kind ?? 'planned'] },
    { id: 'status', group: 'Основное', label: 'Статус', type: 'text', groupable: true, get: (f) => idx.status.get(f.status_id)?.name ?? '' },
    { id: 'stage', group: 'Основное', label: 'Этап', type: 'text', groupable: true, get: (f) => (f.stage_id ? idx.stage.get(f.stage_id)?.name ?? '' : '') },
    { id: 'phase', group: 'Основное', label: 'Текущий этап на Ганте', type: 'text', groupable: true, get: (f) => { const t = c.timeline(f); return t?.current ? PHASE_LABEL[t.current] : ''; } },
    { id: 'category', group: 'Основное', label: 'Категория', type: 'text', groupable: true, get: (f) => idx.category.get(f.category_id)?.name ?? '' },
    { id: 'tags', group: 'Основное', label: 'Теги', type: 'list', groupable: true, get: (f) => tags(f) },
    { id: 'epic', group: 'Основное', label: 'Эпик', type: 'text', groupable: true, get: (f) => { const e = f.epic_id ? idx.epic.get(f.epic_id) : undefined; return e ? `EP-${e.number} ${e.title}` : ''; } },
    { id: 'urgency', group: 'Основное', label: 'Срочность', type: 'text', groupable: true, get: (f) => (f.urgency ? URGENCY_LABEL[f.urgency] ?? f.urgency : '') },
    { id: 'proposals', group: 'Основное', label: 'Предложения', type: 'lines', get: (f) => (c.proposalsBy.get(f.id) ?? []).map((p) => `${p.key} ${p.title}`) },
    { id: 'focus', group: 'Основное', label: 'Фокус релиза', type: 'bool', groupable: true, get: (f) => bool(f.is_focus) },
    { id: 'visibility', group: 'Основное', label: 'Видимость', type: 'text', groupable: true, editorOnly: true, get: (f) => VIS_LABEL[f.visibility] ?? f.visibility },
    { id: 'internal', group: 'Основное', label: 'Внутренняя задача продукта', type: 'bool', groupable: true, editorOnly: true, get: (f) => isProductInternal(f) },
    // ── Люди
    { id: 'initiator', group: 'Люди', label: 'Инициатор', type: 'text', groupable: true, get: (f) => initiatorDto(f, w)?.name ?? '' },
    { id: 'author', group: 'Люди', label: 'Автор', type: 'text', groupable: true, get: (f) => f.author_name ?? '' },
    { id: 'assignee', group: 'Люди', label: 'Ответственный', type: 'text', groupable: true, get: (f) => f.assignee_name ?? '' },
    // ── Сроки
    { id: 'requested_at', group: 'Сроки', label: 'Дата обращения', type: 'date', groupable: true, get: (f) => f.requested_at ?? f.created_at?.slice(0, 10) },
    { id: 'planned_start', group: 'Сроки', label: 'Начало работ (план)', type: 'date', get: (f) => f.planned_start },
    { id: 'planned_end', group: 'Сроки', label: 'Окончание работ (план)', type: 'date', groupable: true, get: (f) => f.planned_end },
    { id: 'baseline_production_date', group: 'Сроки', label: 'Выкладка по исходному плану', type: 'date', groupable: true, get: (f) => f.baseline_production_date },
    { id: 'planned_production_date', group: 'Сроки', label: 'Выкладка по текущему плану', type: 'date', groupable: true, get: (f) => f.planned_production_date },
    { id: 'release_forecast', group: 'Сроки', label: 'Прогноз выкладки', type: 'date', get: (f) => c.timeline(f)?.release.forecast ?? null },
    { id: 'deviation_days', group: 'Сроки', label: 'Отклонение от исходного плана, дн.', type: 'number', get: (f) => c.timeline(f)?.release.deviation_days ?? null },
    { id: 'closed_at', group: 'Сроки', label: 'Дата выполнения', type: 'date', groupable: true, get: (f) => f.closed_at },
    // ── Спринт и релиз
    { id: 'sprint', group: 'Спринт и релиз', label: 'Спринт', type: 'text', groupable: true, get: (f) => sprint(f)?.code ?? '' },
    { id: 'sprint_dates', group: 'Спринт и релиз', label: 'Даты спринта', type: 'text', get: (f) => { const s = sprint(f); return s ? `${ruDate(s.start_date)} – ${ruDate(s.end_date)}` : ''; } },
    { id: 'release', group: 'Спринт и релиз', label: 'Релиз', type: 'text', groupable: true, get: (f) => release(f)?.name ?? '' },
    { id: 'release_approved', group: 'Спринт и релиз', label: 'План релиза утверждён', type: 'bool', groupable: true, get: (f) => (release(f) ? !!release(f)!.approved_at : null) },
    // ── Приоритет
    { id: 'rank', group: 'Приоритет', label: 'Место в рейтинге', type: 'number', get: (f) => c.rank.get(f.id) ?? null },
    { id: 'priority_score', group: 'Приоритет', label: 'Приоритет отделов', type: 'number', get: (f) => idx.priority.get(f.id)?.score ?? null },
    { id: 'voters', group: 'Приоритет', label: 'Оценили отделов', type: 'number', get: (f) => idx.priority.get(f.id)?.voters ?? 0 },
    ...w.departments.filter((d) => bool(d.is_active)).map((d): FieldDef => ({
      id: `vote:${d.id}`, group: 'Приоритет', label: `Оценка: ${d.name}`, type: 'number',
      get: (f) => (idx.votesBy.get(f.id) ?? []).find((v) => v.department_id === d.id)?.score ?? null,
    })),
    // ── Внешние ссылки
    { id: 'links', group: 'Внешние ссылки', label: 'Все ссылки', type: 'lines', get: (f) => links(f) },
    ...LINK_KINDS.map((k): FieldDef => ({ id: `links:${k}`, group: 'Внешние ссылки', label: `Ссылки: ${LINK_KIND_LABEL[k]}`, type: 'lines', get: (f) => links(f, k) })),
    // ── TaskFlow (the built-in exchange template, same semantics as before)
    // sheet priority is kept as a tag «P1», «P2»… by the import; department votes are a different thing
    { id: 'tf_priority', group: 'TaskFlow', label: 'Приоритет (тег P1…P3)', type: 'number', groupable: true, get: (f) => { const p = tags(f).find((t) => /^P\d+$/i.test(t)); return p ? Number(p.slice(1)) : null; } },
    // the first promised date; when it was never fixed separately, the current deadline is the only one known
    { id: 'tf_initial_deadline', group: 'TaskFlow', label: 'Изначальный срок', type: 'date', get: (f) => f.baseline_production_date ?? deadline(f) },
    { id: 'tf_new_deadline', group: 'TaskFlow', label: 'Новый срок', type: 'date', get: (f) => deadline(f) },
    { id: 'tf_comment', group: 'TaskFlow', label: 'Комментарий (описание без строки факта)', type: 'text', get: (f) => (f.description ?? '').replace(FACT_LINE, '').replace(/\n{3,}/g, '\n\n').trim() },
    { id: 'tf_done', group: 'TaskFlow', label: 'Сделано', type: 'bool', groupable: true, get: (f) => idx.status.get(f.status_id)?.semantic === 'done' },
    { id: 'tf_hot', group: 'TaskFlow', label: 'Влетевшая', type: 'bool', groupable: true, get: (f) => tags(f).some((t) => t.toLowerCase() === 'влетевшая') },
  ];
  if (showEstimates(viewer, w)) {
    const teams = w.teams.filter((t) => bool(t.is_active));
    fields.push(
      ...teams.map((t): FieldDef => ({
        id: `est:${t.id}`, group: 'Часы', label: `Оценка: ${t.name}, ч`, type: 'number', sum: true,
        get: (f) => { const e = est(f).find((x) => x.team_id === t.id); return e ? Number(e.hours) : null; },
      })),
      { id: 'estimate_total', group: 'Часы', label: 'Оценка, всего ч', type: 'number', sum: true, get: (f) => (est(f).length ? round1(est(f).reduce((s, e) => s + Number(e.hours), 0)) : null) },
    );
  }
  fields.push({ id: 'fact_hours', group: 'Часы', label: 'Факт, ч', type: 'number', sum: true, get: (f) => factHours(f) });
  return fields.filter((x) => editor || !x.editorOnly);
}

export interface ColumnSpec { field: string; title?: string }
export interface ExportSpec {
  columns: ColumnSpec[];
  /** the backlog filters, as its query string (the same server query as the backlog) */
  query: string;
  sort: { field: string; dir: 'asc' | 'desc' }[];
  /** up to two groupings: first → second */
  groups: string[];
  subtotals: boolean;
}

/** «TaskFlow — 12 колонок»: the exchange format of the first connected sheet, unchanged (FR-08, owner decision 13.10) */
export const TASKFLOW_TEMPLATE_ID = 'builtin:taskflow';
export const TASKFLOW_SPEC: ExportSpec = {
  columns: [
    { field: 'tf_priority', title: 'Приоритет' },
    { field: 'title', title: 'Задача' },
    { field: 'category', title: 'Категория' },
    { field: 'assignee', title: 'Сотрудник' },
    { field: 'tf_initial_deadline', title: 'Изначальный срок' },
    { field: 'tf_new_deadline', title: 'Новый срок' },
    { field: 'closed_at', title: 'Дата выполнения' },
    { field: 'estimate_total', title: 'Оценка в часах' },
    { field: 'fact_hours', title: 'Факт в часах' },
    { field: 'tf_comment', title: 'Комментарий' },
    { field: 'tf_done', title: 'Сделано' },
    { field: 'tf_hot', title: 'Влетевшая' },
  ],
  query: '',
  sort: [],
  groups: [],
  subtotals: true, // no groups in TaskFlow; on for copies that add groupings
};

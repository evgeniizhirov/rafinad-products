// One schema of columns for the XLSX file and the Google «Import» tab (FR-08). One row = one task.
// Owner decision 13.10: the columns are those of the first connected sheet (TaskFlow), in its order.
// A value the system does not have leaves the cell empty — nothing is invented.
import type { Row } from '../lib/db';
import type { Indexes, Viewer, World } from '../lib/world';
import type { Cell } from './xlsx';

interface Column {
  title: string;
  value: (f: Row) => Cell;
}

/** YYYY-MM-DD → DD.MM.YYYY (the sheet's date format; the importer reads it back) */
const ruDate = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const yesNo = (v: boolean) => (v ? 'Да' : 'Нет');
const FACT_LINE = /^Факт: ([\d.,]+) ч$/m;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** fact hours: the field (bugs, P05) or the «Факт: N ч» line the TaskFlow import writes into the description */
function factHours(f: Row): number | null {
  if (f.fact_hours !== null && f.fact_hours !== undefined) return Number(f.fact_hours);
  const m = FACT_LINE.exec(f.description ?? '');
  return m ? Number(m[1].replace(',', '.')) : null;
}

export const EXPORT_COLUMNS = ['Приоритет', 'Задача', 'Категория', 'Сотрудник', 'Изначальный срок', 'Новый срок', 'Дата выполнения', 'Оценка в часах', 'Факт в часах', 'Комментарий', 'Сделано', 'Влетевшая'] as const;

export function exportColumns(_viewer: Viewer, _w: World, idx: Indexes): Column[] {
  const tags = (f: Row) => idx.tagsBy.get(f.id) ?? [];
  const deadline = (f: Row) => f.planned_production_date ?? f.planned_end ?? null;
  const hours = (f: Row) => {
    const est = idx.estimatesBy.get(f.id) ?? [];
    return est.length ? Math.round(est.reduce((s, e) => s + Number(e.hours), 0) * 10) / 10 : null;
  };
  const cols: Column[] = [
    // sheet priority is kept as a tag «P1», «P2»… by the import; department votes are a different thing
    { title: 'Приоритет', value: (f) => { const p = tags(f).find((t) => /^P\d+$/i.test(t)); return p ? Number(p.slice(1)) : null; } },
    { title: 'Задача', value: (f) => f.title },
    { title: 'Категория', value: (f) => idx.category.get(f.category_id)?.name ?? '' },
    { title: 'Сотрудник', value: (f) => f.assignee_name ?? '' },
    // the first promised date; when it was never fixed separately, the current deadline is the only one known
    { title: 'Изначальный срок', value: (f) => ruDate(f.baseline_production_date ?? deadline(f)) },
    { title: 'Новый срок', value: (f) => ruDate(deadline(f)) },
    { title: 'Дата выполнения', value: (f) => ruDate(f.closed_at) },
    { title: 'Оценка в часах', value: (f) => hours(f) },
    { title: 'Факт в часах', value: (f) => num(factHours(f)) },
    { title: 'Комментарий', value: (f) => (f.description ?? '').replace(FACT_LINE, '').replace(/\n{3,}/g, '\n\n').trim() },
    { title: 'Сделано', value: (f) => yesNo(idx.status.get(f.status_id)?.semantic === 'done') },
    { title: 'Влетевшая', value: (f) => yesNo(tags(f).some((t) => t.toLowerCase() === 'влетевшая')) },
  ];
  return cols;
}

export function exportTable(rows: Row[], viewer: Viewer, w: World, idx: Indexes): Cell[][] {
  const cols = exportColumns(viewer, w, idx);
  return [cols.map((c) => c.title), ...rows.map((f) => cols.map((c) => c.value(f)))];
}

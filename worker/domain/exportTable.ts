// One schema of columns for the XLSX file and the Google «Import» tab (FR-08). One row = one task.
import { bool, type Row } from '../lib/db';
import { canSee, initiatorDto, isProductInternal, type Indexes, type Viewer, type World } from '../lib/world';
import type { Cell } from './xlsx';

const KIND = { planned: 'Плановая', bug: 'Баг', operational_improvement: 'Оперативная доработка' } as Record<string, string>;
const URGENCY = { low: 'низкая', medium: 'средняя', high: 'высокая', critical: 'критическая' } as Record<string, string>;
const VIS = { draft: 'черновик', internal: 'для сотрудников', public: 'опубликована' } as Record<string, string>;
const INI = { free_text: 'человек', user: 'пользователь', department: 'отдел' } as Record<string, string>;

interface Column {
  title: string;
  value: (f: Row) => Cell;
  /** shown only to these viewers (default: everybody who may export) */
  only?: Viewer[];
}

export function exportColumns(viewer: Viewer, w: World, idx: Indexes): Column[] {
  const rel = (f: Row) => (idx.releaseOf.has(f.id) ? idx.release.get(idx.releaseOf.get(f.id)!) : undefined);
  const est = (f: Row) => (idx.estimatesBy.get(f.id) ?? []).reduce((s, e) => s + Number(e.hours), 0);
  const cols: Column[] = [
    { title: 'ID', value: (f) => `RF-${f.number}` },
    { title: 'Тип', value: (f) => KIND[f.task_kind ?? 'planned'] },
    { title: 'Название', value: (f) => f.title },
    { title: 'Описание', value: (f) => f.description ?? '' },
    { title: 'Статус', value: (f) => idx.status.get(f.status_id)?.name ?? '' },
    { title: 'Семантика статуса', value: (f) => idx.status.get(f.status_id)?.semantic ?? '' },
    { title: 'Срочность', value: (f) => (f.urgency ? URGENCY[f.urgency] : '') },
    { title: 'Инициатор', value: (f) => initiatorDto(f, w)?.name ?? '', only: ['employee', 'editor'] },
    { title: 'Вид инициатора', value: (f) => (f.initiator_type ? INI[f.initiator_type] : ''), only: ['employee', 'editor'] },
    { title: 'Автор запроса', value: (f) => f.author_name ?? '', only: ['employee', 'editor'] },
    { title: 'Ответственный', value: (f) => f.assignee_name ?? '', only: ['employee', 'editor'] },
    { title: 'Дата постановки', value: (f) => f.requested_at ?? f.created_at?.slice(0, 10) ?? '' },
    { title: 'Категория', value: (f) => idx.category.get(f.category_id)?.name ?? '' },
    { title: 'Эпик', value: (f) => { const e = f.epic_id ? idx.epic.get(f.epic_id) : undefined; return e && canSee(viewer, e.visibility) ? e.title : ''; } },
    { title: 'Релиз', value: (f) => { const r = rel(f); return r && canSee(viewer, r.visibility) ? r.name : ''; } },
    { title: 'Спринт', value: (f) => (f.sprint_id ? idx.sprint.get(f.sprint_id)?.code ?? '' : '') },
    { title: 'Фокус релиза', value: (f) => (bool(f.is_focus) ? 'да' : '') },
    { title: 'Плановое начало', value: (f) => f.planned_start ?? '' },
    { title: 'Плановое завершение', value: (f) => f.planned_end ?? '' },
    { title: 'Плановая выкладка', value: (f) => f.planned_production_date ?? '' },
    { title: 'Первоначально обещано', value: (f) => f.baseline_production_date ?? '', only: ['employee', 'editor'] },
    { title: 'Завершена', value: (f) => f.closed_at ?? '' },
    { title: 'Приоритет (балл)', value: (f) => idx.priority.get(f.id)?.score ?? null },
    { title: 'Оценили отделов', value: (f) => (idx.votesBy.get(f.id) ?? []).length },
    { title: 'Часы (оценка)', value: (f) => { const h = est(f); return h ? Math.round(h * 10) / 10 : null; } },
    { title: 'Факт часов', value: (f) => f.fact_hours ?? null, only: ['employee', 'editor'] },
    { title: 'Теги', value: (f) => (idx.tagsBy.get(f.id) ?? []).join(', ') },
    { title: 'Внешний ID', value: (f) => f.external_ref ?? '', only: ['employee', 'editor'] },
    { title: 'Публикация', value: (f) => VIS[f.visibility] ?? f.visibility, only: ['employee', 'editor'] },
    { title: 'Внутренняя задача продукта', value: (f) => (isProductInternal(f) ? 'да' : ''), only: ['editor'] },
  ];
  return cols.filter((c) => !c.only || c.only.includes(viewer));
}

export function exportTable(rows: Row[], viewer: Viewer, w: World, idx: Indexes): Cell[][] {
  const cols = exportColumns(viewer, w, idx);
  return [cols.map((c) => c.title), ...rows.map((f) => cols.map((c) => c.value(f)))];
}

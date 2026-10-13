// Builds the export table from a spec (vNext ТЗ §4; owner decision 13.10 №15): chosen columns in their order and
// with their titles, sort, up to two groupings with group header rows (subtotals of hour columns) and outline levels
// for Excel. Pure: rows in, table out — the same result for the preview, the .xlsx and the Google tab.
import type { Row } from '../lib/db';
import { formatCell, type ExportSpec, type FieldDef } from './exportFields';
import type { Cell } from './xlsx';

export interface OutRow {
  kind: 'group' | 'task';
  /** outline level: 0 for the first grouping, 1 for the second, tasks one level deeper than their last group */
  level: number;
  cells: Cell[];
  /** group rows: number of tasks inside */
  count?: number;
  /** task rows: values of the grouping fields (for flat outputs, where group header rows do not exist) */
  groupCells?: Cell[];
}

export interface BuiltTable {
  columns: { field: string; title: string; type: string; sum: boolean }[];
  header: string[];
  rows: OutRow[];
  groups: { field: string; label: string }[];
  /** fields of the spec the viewer may not export (or that do not exist any more) — dropped, not exported */
  skipped: string[];
  taskCount: number;
}

const EMPTY = '— не указано —';

function rawKey(f: FieldDef, task: Row): string | number | null {
  const v = f.get(task);
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as string | number;
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // empty values last
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ru', { numeric: true });
}

export function buildTable(tasks: Row[], spec: ExportSpec, catalog: FieldDef[]): BuiltTable {
  const byId = new Map(catalog.map((f) => [f.id, f]));
  const skipped: string[] = [];
  const cols = spec.columns.flatMap((c) => {
    const f = byId.get(c.field);
    if (!f) { skipped.push(c.field); return []; }
    return [{ def: f, title: (c.title ?? '').trim() || f.label }];
  });
  const groups = spec.groups.slice(0, 2).flatMap((g) => {
    const f = byId.get(g);
    if (!f) { skipped.push(g); return []; }
    return [f];
  });
  const sorts = spec.sort.slice(0, 3).flatMap((s) => {
    const f = byId.get(s.field);
    if (!f) { skipped.push(s.field); return []; }
    return [{ def: f, dir: s.dir === 'desc' ? -1 : 1 }];
  });
  // A numeric-only grouped report still needs a text cell for group labels;
  // otherwise the first subtotal overwrites the label and groups become anonymous.
  if (groups.length && cols.length && cols.every((c) => c.def.sum && c.def.type === 'number')) {
    cols.unshift({ def: { id: '__group_label', group: '', label: 'Группа', type: 'text', get: () => null }, title: 'Группа' });
  }

  // stable: groups first, then the chosen sort, then the incoming order (priority from the backlog query)
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  const keyed = tasks.map((t) => ({ t, g: groups.map((g) => rawKey(g, t)), s: sorts.map((s) => rawKey(s.def, t)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < groups.length; i++) { const c = compare(a.g[i], b.g[i]); if (c) return c; }
    for (let i = 0; i < sorts.length; i++) { const c = compare(a.s[i], b.s[i]); if (c) return c * sorts[i].dir; }
    return order.get(a.t.id)! - order.get(b.t.id)!;
  });

  const taskCells = (t: Row) => cols.map((c) => formatCell(c.def.type, c.def.get(t)));
  const task = (level: number, t: Row): OutRow => ({ kind: 'task', level, cells: taskCells(t), ...(groups.length ? { groupCells: groups.map((g) => formatCell(g.type, g.get(t))) } : {}) });
  const sumCols = cols.map((c) => !!c.def.sum && c.def.type === 'number');
  const labelCol = Math.max(0, sumCols.findIndex((s) => !s));
  const groupRow = (level: number, def: FieldDef, value: string | number | null, members: Row[]): OutRow => {
    const shown = value === null ? EMPTY : def.type === 'date' ? String(formatCell('date', value)) : def.type === 'bool' ? (value ? 'Да' : 'Нет') : String(value);
    const cells: Cell[] = cols.map(() => null);
    cells[labelCol] = `${def.label}: ${shown} · ${members.length}`;
    if (spec.subtotals) {
      cols.forEach((c, i) => {
        if (!sumCols[i]) return;
        const vals = members.map((m) => c.def.get(m)).filter((v): v is number => typeof v === 'number');
        cells[i] = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) * 10) / 10 : null;
      });
    }
    return { kind: 'group', level, cells, count: members.length };
  };

  const rows: OutRow[] = [];
  if (!groups.length) {
    for (const k of keyed) rows.push(task(0, k.t));
  } else {
    let i = 0;
    while (i < keyed.length) {
      let j = i;
      while (j < keyed.length && compare(keyed[j].g[0], keyed[i].g[0]) === 0) j++;
      const block = keyed.slice(i, j);
      rows.push(groupRow(0, groups[0], keyed[i].g[0], block.map((x) => x.t)));
      if (groups[1]) {
        let a = 0;
        while (a < block.length) {
          let b = a;
          while (b < block.length && compare(block[b].g[1], block[a].g[1]) === 0) b++;
          const sub = block.slice(a, b);
          rows.push(groupRow(1, groups[1], block[a].g[1], sub.map((x) => x.t)));
          for (const k of sub) rows.push(task(2, k.t));
          a = b;
        }
      } else {
        for (const k of block) rows.push(task(1, k.t));
      }
      i = j;
    }
  }
  return {
    columns: cols.map((c, i) => ({ field: c.def.id, title: c.title, type: c.def.type, sum: sumCols[i] })),
    header: cols.map((c) => c.title),
    rows,
    groups: groups.map((g) => ({ field: g.id, label: g.label })),
    skipped,
    taskCount: tasks.length,
  };
}

/**
 * The table as plain rows (Google tab, legacy callers): header + tasks only, no group rows. A grouping field that is
 * not among the chosen columns comes first as its own column, so the grouping is not lost in a flat sheet.
 */
export function flatRows(t: BuiltTable): Cell[][] {
  const extra = t.groups.map((g, i) => ({ g, i })).filter(({ g }) => !t.columns.some((c) => c.field === g.field));
  return [
    [...extra.map(({ g }) => g.label), ...t.header],
    ...t.rows.filter((r) => r.kind === 'task').map((r) => [...extra.map(({ i }) => r.groupCells?.[i] ?? null), ...r.cells]),
  ];
}

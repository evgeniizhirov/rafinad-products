// The built-in «TaskFlow — 12 колонок» export (FR-08): XLSX file and the Google «Import» tab. One row = one task.
// Owner decision 13.10: the columns are those of the first connected sheet (TaskFlow), in its order.
// A value the system does not have leaves the cell empty — nothing is invented.
// Since vNext PR 9 it is one template of the export builder (exportFields.ts, TASKFLOW_SPEC) — same order, titles
// and semantics as before; the builder and this exchange can never drift apart.
import type { Row } from '../lib/db';
import type { Indexes, Viewer, World } from '../lib/world';
import { buildTable, flatRows } from './exportBuild';
import { fieldCatalog, TASKFLOW_SPEC } from './exportFields';
import type { Cell } from './xlsx';

export const EXPORT_COLUMNS = TASKFLOW_SPEC.columns.map((c) => c.title!) as readonly string[];

export function exportTable(rows: Row[], viewer: Viewer, w: World, idx: Indexes): Cell[][] {
  // TaskFlow fields need neither proposals, nor phases, nor the rating
  const catalog = fieldCatalog({ viewer, w, idx, proposalsBy: new Map(), timeline: () => null, rank: new Map() });
  return flatRows(buildTable(rows, TASKFLOW_SPEC, catalog));
}

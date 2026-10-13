// Record numbers (RF-n, EP-n, P-n) are never reused after a permanent deletion (vNext ТЗ §5): the delete raises a
// floor in app_settings, and every new number is above both the current maximum and that floor.
import type { D1Database } from '../env';
import { first, stmt } from './db';

export type Numbered = 'features' | 'epics' | 'proposals';
export const floorKey = (table: Numbered) => `number_floor.${table}`;

export async function nextNumber(db: D1Database, table: Numbered): Promise<number> {
  const r = await first<{ n: number }>(db,
    `SELECT MAX(COALESCE((SELECT MAX(number) FROM ${table}), 0), COALESCE((SELECT CAST(value AS INTEGER) FROM app_settings WHERE key = ?), 0)) + 1 AS n`,
    floorKey(table));
  return r?.n ?? 1;
}

export async function numberFloor(db: D1Database, table: Numbered): Promise<number> {
  const r = await first<{ v: string }>(db, 'SELECT value AS v FROM app_settings WHERE key = ?', floorKey(table));
  return Number(r?.v ?? 0) || 0;
}

/** keep the highest deleted number as the floor */
export function raiseFloorStmt(db: D1Database, table: Numbered, n: number) {
  return stmt(db, `INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`, floorKey(table), String(n));
}

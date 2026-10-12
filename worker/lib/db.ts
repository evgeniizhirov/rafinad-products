import type { D1Database, D1PreparedStatement } from '../env';
import { conflict } from './http';

export type Row = Record<string, any>;

export const nowIso = () => new Date().toISOString();

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return prefix ? `${prefix}_${s}` : s;
}

/** D1 rejects `undefined` bindings; normalise to null and booleans to 0/1. */
function norm(values: unknown[]): unknown[] {
  return values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

export function stmt(db: D1Database, sql: string, ...values: unknown[]): D1PreparedStatement {
  const s = db.prepare(sql);
  return values.length ? s.bind(...norm(values)) : s;
}

export async function all<T = Row>(db: D1Database, sql: string, ...values: unknown[]): Promise<T[]> {
  const r = await stmt(db, sql, ...values).all<T>();
  return r.results ?? [];
}

export async function first<T = Row>(db: D1Database, sql: string, ...values: unknown[]): Promise<T | null> {
  return (await stmt(db, sql, ...values).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...values: unknown[]) {
  return stmt(db, sql, ...values).run();
}

/**
 * A statement that aborts the surrounding batch (transaction) when `conditionSql` is TRUE.
 * Relies on the CHECK (v = 0) constraint of the `_guard` table.
 */
export function abortIf(db: D1Database, tag: string, conditionSql: string, ...values: unknown[]): D1PreparedStatement {
  return stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, ? WHERE (${conditionSql})`, tag, ...values);
}

/** Abort the batch unless the row still has the expected version (optimistic locking). */
export function guardVersion(db: D1Database, table: string, id: string, version: number): D1PreparedStatement {
  if (!/^[a-z_]+$/.test(table)) throw new Error('bad table');
  return abortIf(db, `version:${table}:${id}`, `NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND version = ?)`, id, version);
}

export function isGuardFailure(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /CHECK constraint failed/i.test(msg) && /(_guard|\bv = 0\b|\bv=0\b)/i.test(msg);
}

/**
 * Executes statements atomically (D1 batch = single transaction).
 * Guard failures are converted to HTTP 409 with the supplied message.
 */
export async function tx(db: D1Database, statements: D1PreparedStatement[], conflictMessage = 'Данные изменились: обновите страницу и повторите действие') {
  if (statements.length === 0) return [];
  try {
    return await db.batch(statements);
  } catch (err) {
    if (isGuardFailure(err)) {
      throw conflict('version_conflict', conflictMessage);
    }
    const msg = String((err as Error)?.message ?? err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      throw conflict('unique_violation', 'Запись с такими данными уже существует', { db: msg.replace(/^.*UNIQUE constraint failed: /i, '') });
    }
    throw err;
  }
}

export const bool = (v: unknown) => v === 1 || v === true || v === '1';

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Builds "?, ?, ?" for IN lists. D1 limits bound parameters to 100 per statement. */
export function placeholders(n: number) {
  return Array.from({ length: n }, () => '?').join(', ');
}

export function chunk<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function allIn<T = Row>(db: D1Database, sqlWithIn: string, ids: string[], ...extra: unknown[]): Promise<T[]> {
  if (!ids.length) return [];
  const out: T[] = [];
  for (const part of chunk(ids)) {
    const sql = sqlWithIn.replace('(:ids)', `(${placeholders(part.length)})`);
    out.push(...(await all<T>(db, sql, ...part, ...extra)));
  }
  return out;
}

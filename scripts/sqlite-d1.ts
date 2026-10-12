// A small D1-compatible adapter over Node's built-in SQLite (node:sqlite, Node ≥ 22.5).
// D1 *is* SQLite, so this runs the real schema and SQL for tests and the local Node dev server.
// batch() is transactional exactly like D1.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/env';

const isQuery = (sql: string) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

function plain(row: unknown): Record<string, unknown> {
  return row ? { ...(row as Record<string, unknown>) } : (row as Record<string, unknown>);
}

export function createD1(path = ':memory:'): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');

  class Stmt implements D1PreparedStatement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...values: unknown[]): D1PreparedStatement {
      for (const v of values) if (v === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
      return new Stmt(this.sql, values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
    }
    exec(): D1Result {
      const s = db.prepare(this.sql);
      if (isQuery(this.sql)) {
        const rows = s.all(...(this.params as never[])).map(plain);
        return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
      }
      const info = s.run(...(this.params as never[]));
      return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async first<T>(column?: string): Promise<T | null> {
      const row = db.prepare(this.sql).get(...(this.params as never[]));
      if (!row) return null;
      return (column ? (row as Record<string, unknown>)[column] : plain(row)) as T;
    }
    async all<T>(): Promise<D1Result<T>> {
      return this.exec() as D1Result<T>;
    }
    async run(): Promise<D1Result> {
      return this.exec();
    }
    async raw<T>(): Promise<T[]> {
      return db.prepare(this.sql).all(...(this.params as never[])).map((r) => Object.values(r as object)) as T[];
    }
  }

  return {
    raw: db,
    prepare: (sql: string) => new Stmt(sql),
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as Stmt).exec());
        db.exec('COMMIT');
        return out as D1Result<T>[];
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return {};
    },
  };
}

export function migrate(d1: { raw: DatabaseSync }, dir = join(import.meta.dirname, '..', 'migrations')) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    d1.raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
}

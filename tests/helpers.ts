import worker from '../worker/index';
import type { Env } from '../worker/env';
import { hashPassword } from '../worker/lib/crypto';
import { createD1, migrate } from '../scripts/sqlite-d1';
import { seedSql } from '../scripts/gen-seed';

export interface Res {
  status: number;
  body: any;
  cookie: string | null;
}

export interface TestApp {
  env: Env;
  db: ReturnType<typeof createD1>;
  call(method: string, path: string, body?: unknown, cookie?: string | null, headers?: Record<string, string>): Promise<Res>;
  /** the raw Response (binary downloads) */
  raw(method: string, path: string, body?: unknown, cookie?: string | null, headers?: Record<string, string>): Promise<Response>;
  login(email: string, password?: string): Promise<string>;
  user(email: string, role: 'admin' | 'product' | 'department_lead', departments?: string[], name?: string): Promise<string>;
  one(sql: string, ...params: unknown[]): any;
  many(sql: string, ...params: unknown[]): any[];
}

export const PASSWORD = 'Test-password-123';
let fastHash: string | null = null;

export async function setup(opts: { seed?: boolean } = {}): Promise<TestApp> {
  const db = createD1();
  migrate(db);
  if (opts.seed !== false) for (const s of seedSql()) db.raw.exec(s);
  const env: Env = { DB: db, COOKIE_SECURE: '0' };
  fastHash ??= await hashPassword(PASSWORD, 1000); // tests use the minimum accepted iteration count

  const raw: TestApp['raw'] = async (method, path, body, cookie, headers = {}) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (cookie) (init.headers as Record<string, string>).cookie = cookie;
    return worker.fetch(new Request(`http://app.test${path}`, init), env);
  };

  const call: TestApp['call'] = async (method, path, body, cookie, headers = {}) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (cookie) (init.headers as Record<string, string>).cookie = cookie;
    const res = await worker.fetch(new Request(`http://app.test${path}`, init), env);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not json */
    }
    const set = res.headers.get('set-cookie');
    return { status: res.status, body: parsed, cookie: set ? set.split(';')[0] : null };
  };

  const login = async (email: string, password = PASSWORD) => {
    const r = await call('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
    return r.cookie!;
  };

  const user: TestApp['user'] = async (email, role, departments = [], name) => {
    const id = `u_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    db.raw.prepare('INSERT INTO users (id, email, name, role_code, password_hash, must_change_password, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)')
      .run(id, email, name ?? email.split('@')[0], role, fastHash, now, now);
    for (const d of departments) db.raw.prepare('INSERT INTO department_memberships (user_id, department_id) VALUES (?, ?)').run(id, d);
    return login(email);
  };

  return {
    env,
    db,
    call,
    raw,
    login,
    user,
    one: (sql, ...p) => db.raw.prepare(sql).get(...(p as never[])),
    many: (sql, ...p) => db.raw.prepare(sql).all(...(p as never[])),
  };
}

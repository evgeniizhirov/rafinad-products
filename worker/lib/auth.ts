import type { Env } from '../env';
import { all, first, nowIso, run, stmt } from './db';
import { sha256Hex } from './crypto';
import { forbidden, unauthorized, type Ctx } from './http';

export type Role = 'department_lead' | 'product' | 'admin';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  departmentIds: string[];
  mustChangePassword: boolean;
  sessionId: string;
}

export const SESSION_COOKIE = 'rr_session';
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(env: Env, token: string, maxAgeSec: number): string {
  const secure = env.COOKIE_SECURE === '0' ? '' : '; Secure';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export async function loadSessionUser(env: Env, req: Request): Promise<SessionUser | null> {
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  const sid = await sha256Hex(token);
  const row = await first(
    env.DB,
    `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.id, u.email, u.name, u.role_code, u.must_change_password, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sid,
  );
  if (!row) return null;
  if (!row.is_active || row.expires_at < nowIso()) {
    await run(env.DB, 'DELETE FROM sessions WHERE id = ?', sid);
    return null;
  }
  const deps = await all<{ department_id: string }>(env.DB, 'SELECT department_id FROM department_memberships WHERE user_id = ?', row.id);
  // sliding expiration, written at most every 10 minutes
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  if (Date.now() - lastSeen > 10 * 60 * 1000) {
    await run(env.DB, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString(), sid);
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role_code as Role,
    departmentIds: deps.map((d) => d.department_id),
    mustChangePassword: !!row.must_change_password,
    sessionId: sid,
  };
}

// ───────────────────────── permissions ─────────────────────────
// The single source of truth for "who may do what". Checked by every write route.

export const perms = {
  isEmployee: (u: SessionUser | null) => !!u,
  editCatalog: (u: SessionUser | null) => !!u && (u.role === 'product' || u.role === 'admin'),
  seeDrafts: (u: SessionUser | null) => !!u && (u.role === 'product' || u.role === 'admin'),
  comment: (u: SessionUser | null) => !!u,
  // FR-04: membership is re-read from department_memberships on every request (loadSessionUser),
  // so a change applies to existing sessions immediately. Future API keys (FR-01) must go through
  // the same check: a `priorities:write-own` scope never replaces the current membership.
  voteFor: (u: SessionUser | null, departmentId: string) => !!u && u.departmentIds.includes(departmentId),
  overrideVote: (u: SessionUser | null) => !!u && u.role === 'admin',
  plan: (u: SessionUser | null) => !!u && (u.role === 'product' || u.role === 'admin'),
  import: (u: SessionUser | null) => !!u && (u.role === 'product' || u.role === 'admin'),
  admin: (u: SessionUser | null) => !!u && u.role === 'admin',
};

export function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw unauthorized();
  if (ctx.user.mustChangePassword) throw forbidden('Сначала смените временный пароль');
  return ctx.user;
}

export function requirePerm(ctx: Ctx, check: (u: SessionUser | null) => boolean, message?: string): SessionUser {
  const u = requireUser(ctx);
  if (!check(u)) throw forbidden(message);
  return u;
}

// ───────────────────────── login throttling ─────────────────────────
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const LIMITS = { email: 5, ip: 25 };

export async function checkLoginLock(env: Env, keys: string[]): Promise<string | null> {
  const now = nowIso();
  for (const key of keys) {
    const r = await first(env.DB, 'SELECT locked_until FROM login_attempts WHERE key = ?', key);
    if (r?.locked_until && r.locked_until > now) return r.locked_until;
  }
  return null;
}

export async function registerLoginFailure(env: Env, keys: string[]) {
  const now = Date.now();
  for (const key of keys) {
    const limit = key.startsWith('ip:') ? LIMITS.ip : LIMITS.email;
    const r = await first(env.DB, 'SELECT failures, first_failure_at FROM login_attempts WHERE key = ?', key);
    if (!r || now - Date.parse(r.first_failure_at) > WINDOW_MS) {
      await run(
        env.DB,
        `INSERT INTO login_attempts (key, failures, first_failure_at, locked_until) VALUES (?, 1, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET failures = 1, first_failure_at = excluded.first_failure_at, locked_until = NULL`,
        key,
        new Date(now).toISOString(),
      );
      continue;
    }
    const failures = r.failures + 1;
    const lockedUntil = failures >= limit ? new Date(now + LOCK_MS).toISOString() : null;
    await run(env.DB, 'UPDATE login_attempts SET failures = ?, locked_until = ? WHERE key = ?', failures, lockedUntil, key);
  }
}

export async function clearLoginFailures(env: Env, keys: string[]) {
  await env.DB.batch(keys.map((k) => stmt(env.DB, 'DELETE FROM login_attempts WHERE key = ?', k)));
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

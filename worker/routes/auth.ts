import { z } from 'zod';
import {
  checkLoginLock, clearLoginFailures, clientIp, perms, registerLoginFailure, sessionCookie, SESSION_TTL_MS,
} from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { hashPassword, randomToken, sha256Hex, validatePasswordStrength, verifyPassword } from '../lib/crypto';
import { first, nowIso, run, stmt, tx } from '../lib/db';
import { badRequest, HttpError, json, readJson, unauthorized, type Ctx, type Router } from '../lib/http';

async function createSession(ctx: Ctx, userId: string) {
  const token = randomToken(32);
  const sid = await sha256Hex(token);
  const now = nowIso();
  await run(
    ctx.env.DB,
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sid, userId, now, new Date(Date.now() + SESSION_TTL_MS).toISOString(), now,
    (ctx.req.headers.get('user-agent') || '').slice(0, 300), clientIp(ctx.req),
  );
  ctx.setCookies.push(sessionCookie(ctx.env, token, Math.floor(SESSION_TTL_MS / 1000)));
}

export function meDto(ctx: Ctx) {
  const u = ctx.user;
  if (!u) return { user: null };
  return {
    user: {
      id: u.id, email: u.email, name: u.name, role: u.role, department_ids: u.departmentIds, must_change_password: u.mustChangePassword,
      permissions: {
        edit_catalog: perms.editCatalog(u), plan: perms.plan(u), import: perms.import(u), admin: perms.admin(u), comment: perms.comment(u),
      },
      ...(u.apiKey ? { api_key: { id: u.apiKey.id, scopes: u.apiKey.scopes } } : {}),
    },
  };
}

export function registerAuthRoutes(r: Router) {
  r.get('/api/auth/me', (ctx) => json(meDto(ctx)));

  r.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx, z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) }));
    const keys = [`email:${body.email}`, `ip:${clientIp(ctx.req)}`];
    const locked = await checkLoginLock(ctx.env, keys);
    if (locked) throw new HttpError(429, 'locked', 'Слишком много неудачных попыток входа. Попробуйте через 15 минут.', { locked_until: locked });
    const user = await first(ctx.env.DB, 'SELECT * FROM users WHERE email = ?', body.email);
    // verify even when the user does not exist to keep timing similar
    const ok = await verifyPassword(body.password, user?.password_hash ?? 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!user || !ok || !user.is_active) {
      await registerLoginFailure(ctx.env, keys);
      throw unauthorized('Неверный email или пароль');
    }
    await clearLoginFailures(ctx.env, [`email:${body.email}`]);
    await run(ctx.env.DB, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    await createSession(ctx, user.id);
    return json({ ok: true, must_change_password: !!user.must_change_password });
  });

  r.post('/api/auth/logout', async (ctx) => {
    if (ctx.user) await run(ctx.env.DB, 'DELETE FROM sessions WHERE id = ?', ctx.user.sessionId);
    ctx.setCookies.push(sessionCookie(ctx.env, '', 0));
    return json({ ok: true });
  });

  r.post('/api/auth/change-password', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJson(ctx, z.object({ current_password: z.string().max(200), new_password: z.string().max(200) }));
    const row = await first(ctx.env.DB, 'SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(body.current_password, row?.password_hash))) throw badRequest('Текущий пароль указан неверно');
    const weak = validatePasswordStrength(body.new_password);
    if (weak) throw badRequest(weak);
    if (body.new_password === body.current_password) throw badRequest('Новый пароль должен отличаться от текущего');
    const hash = await hashPassword(body.new_password);
    await tx(ctx.env.DB, [
      stmt(ctx.env.DB, 'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ?, version = version + 1 WHERE id = ?', hash, nowIso(), ctx.user.id),
      // log out every other session of this user
      stmt(ctx.env.DB, 'DELETE FROM sessions WHERE user_id = ? AND id <> ?', ctx.user.id, ctx.user.sessionId),
      auditStmt(ctx.env.DB, ctx.user, 'user', ctx.user.id, 'password_changed'),
    ]);
    return json({ ok: true });
  });

  // One-time invitation: sets the first password and signs in.
  r.get('/api/auth/invite/:token', async (ctx) => {
    const inv = await first(
      ctx.env.DB,
      `SELECT i.expires_at, i.used_at, u.email, u.name, u.is_active FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?`,
      await sha256Hex(ctx.params.token),
    );
    if (!inv || inv.used_at || inv.expires_at < nowIso() || !inv.is_active) throw badRequest('Приглашение недействительно или уже использовано');
    return json({ email: inv.email, name: inv.name });
  });

  r.post('/api/auth/accept-invite', async (ctx) => {
    const body = await readJson(ctx, z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }));
    const th = await sha256Hex(body.token);
    const inv = await first(ctx.env.DB, 'SELECT i.*, u.is_active FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?', th);
    if (!inv || inv.used_at || inv.expires_at < nowIso() || !inv.is_active) throw badRequest('Приглашение недействительно или уже использовано');
    const weak = validatePasswordStrength(body.password);
    if (weak) throw badRequest(weak);
    const hash = await hashPassword(body.password);
    const now = nowIso();
    await tx(
      ctx.env.DB,
      [
        // single use: the guard fails if someone used the token concurrently
        stmt(ctx.env.DB, `INSERT INTO _guard (v, tag) SELECT 1, 'invite' WHERE EXISTS (SELECT 1 FROM invites WHERE token_hash = ? AND used_at IS NOT NULL)`, th),
        stmt(ctx.env.DB, 'UPDATE invites SET used_at = ? WHERE token_hash = ?', now, th),
        stmt(ctx.env.DB, 'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ?, version = version + 1 WHERE id = ?', hash, now, inv.user_id),
        stmt(ctx.env.DB, 'DELETE FROM sessions WHERE user_id = ?', inv.user_id),
        auditStmt(ctx.env.DB, { id: inv.user_id, name: 'Пользователь' }, 'user', inv.user_id, 'invite_accepted'),
      ],
      'Приглашение уже использовано',
    );
    await createSession(ctx, inv.user_id);
    return json({ ok: true });
  });
}

// Personal API keys (FR-01): create (token shown once), list, revoke; admin sees metadata of all keys and can revoke.
import { z } from 'zod';
import { API_SCOPES, perms, requirePerm, requireUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { all, first, newId, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, readJson, type Ctx, type Router } from '../lib/http';

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomString(alphabet: string, n: number) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

const keyDto = (k: Row, extra: Row = {}) => ({
  id: k.id, name: k.name, prefix: `rr_${k.prefix}_…`, scopes: parseJson<string[]>(k.scopes, []),
  created_at: k.created_at, expires_at: k.expires_at, revoked_at: k.revoked_at, last_used_at: k.last_used_at, use_count: k.use_count,
  active: !k.revoked_at && k.expires_at > nowIso(), ...extra,
});

/** keys are managed only from a browser session, never with another key */
function sessionOnly(ctx: Ctx) {
  const u = requireUser(ctx);
  if (u.apiKey) throw forbidden('Ключами управляют только из браузера');
  return u;
}

export function registerApiKeyRoutes(r: Router) {
  r.get('/api/me/api-keys', async (ctx) => {
    const u = sessionOnly(ctx);
    const keys = await all(ctx.env.DB, 'SELECT * FROM api_keys WHERE owner_id = ? ORDER BY created_at DESC', u.id);
    return json({ keys: keys.map((k) => keyDto(k)), scopes: API_SCOPES });
  });

  r.post('/api/me/api-keys', async (ctx) => {
    const u = sessionOnly(ctx);
    const b = await readJson(ctx, z.object({
      name: z.string().trim().min(1, 'Назовите ключ, например «Claude Code на ноутбуке»').max(80),
      scopes: z.array(z.enum(API_SCOPES)).min(1, 'Выберите хотя бы одно разрешение').max(API_SCOPES.length),
      expires_in_days: z.number().int().min(1).max(365).default(90),
    }));
    const active = await first<{ n: number }>(ctx.env.DB, 'SELECT COUNT(*) AS n FROM api_keys WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?', u.id, nowIso());
    if ((active?.n ?? 0) >= 10) throw conflict('too_many_keys', 'Не больше 10 активных ключей. Отзовите ненужные.');
    const prefix = randomString(ALPHA, 8);
    const token = `rr_${prefix}_${randomString(ALNUM, 40)}`;
    const id = newId('key');
    const now = nowIso();
    const expires = new Date(Date.now() + b.expires_in_days * 86_400_000).toISOString();
    const scopes = [...new Set(b.scopes)];
    await tx(ctx.env.DB, [
      stmt(ctx.env.DB, 'INSERT INTO api_keys (id, owner_id, name, prefix, secret_hash, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, u.id, b.name, prefix, await sha256Hex(token), JSON.stringify(scopes), expires, now),
      auditStmt(ctx.env.DB, u, 'api_key', id, 'created', [{ field: 'scopes', old: null, new: scopes }, { field: 'expires_at', old: null, new: expires }]),
    ]);
    const k = await first(ctx.env.DB, 'SELECT * FROM api_keys WHERE id = ?', id);
    // the only moment the token leaves the server
    return json({ key: keyDto(k!), token }, 201);
  });

  r.delete('/api/me/api-keys/:id', async (ctx) => {
    const u = sessionOnly(ctx);
    const k = await first(ctx.env.DB, 'SELECT * FROM api_keys WHERE id = ? AND owner_id = ?', ctx.params.id, u.id);
    if (!k) throw notFound('Ключ не найден');
    if (k.revoked_at) return json({ ok: true, unchanged: true });
    await tx(ctx.env.DB, [
      stmt(ctx.env.DB, 'UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', nowIso(), u.id, k.id),
      auditStmt(ctx.env.DB, u, 'api_key', k.id, 'revoked'),
    ]);
    return json({ ok: true });
  });

  r.get('/api/admin/api-keys', async (ctx) => {
    requirePerm(ctx, perms.admin);
    const keys = await all(ctx.env.DB, 'SELECT k.*, u.name AS owner_name, u.email AS owner_email FROM api_keys k JOIN users u ON u.id = k.owner_id ORDER BY k.created_at DESC');
    return json({ keys: keys.map((k) => keyDto(k, { owner: { id: k.owner_id, name: k.owner_name, email: k.owner_email } })) });
  });

  r.post('/api/admin/api-keys/:id/revoke', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const b = await readJson(ctx, z.object({ reason: z.string().trim().min(1, 'Укажите причину').max(500) }));
    const k = await first(ctx.env.DB, 'SELECT * FROM api_keys WHERE id = ?', ctx.params.id);
    if (!k) throw notFound('Ключ не найден');
    if (k.revoked_at) throw badRequest('Ключ уже отозван');
    await tx(ctx.env.DB, [
      stmt(ctx.env.DB, 'UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', nowIso(), admin.id, k.id),
      auditStmt(ctx.env.DB, admin, 'api_key', k.id, 'revoked_by_admin', null, b.reason, true),
    ]);
    return json({ ok: true });
  });
}

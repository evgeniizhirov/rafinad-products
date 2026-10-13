import { z } from 'zod';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt, diffFields } from '../lib/audit';
import { ANY_LOCKED_SQL, planAlertIfStmt } from '../lib/alerts';
import { hashPassword, randomToken, sha256Hex, tempPassword } from '../lib/crypto';
import { abortIf, all, first, guardVersion, newId, nowIso, placeholders, stmt, tx, type Row } from '../lib/db';
import { parseSpreadsheetId } from '../lib/google';
import { badRequest, conflict, json, notFound, readJson, type Ctx, type Router } from '../lib/http';

const roleEnum = z.enum(['department_lead', 'product', 'admin']);
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

async function credentialsStatements(ctx: Ctx, userId: string, delivery: 'invite' | 'temp_password') {
  const db = ctx.env.DB;
  if (delivery === 'invite') {
    const token = randomToken(24);
    const origin = new URL(ctx.req.url).origin;
    return {
      statements: [
        stmt(db, 'DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', userId),
        stmt(db, 'INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
          await sha256Hex(token), userId, ctx.user!.id, nowIso(), new Date(Date.now() + INVITE_TTL_MS).toISOString()),
        stmt(db, 'UPDATE users SET password_hash = NULL, must_change_password = 1 WHERE id = ?', userId),
      ],
      result: { invite_url: `${origin}/invite/${token}`, expires_in_days: 7 },
    };
  }
  const pw = tempPassword();
  return {
    statements: [
      stmt(db, 'DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', userId),
      stmt(db, 'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await hashPassword(pw), userId),
    ],
    result: { temp_password: pw },
  };
}

// ───────────────────────── dictionaries ─────────────────────────
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const code = z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/, 'Код: латиница в нижнем регистре, цифры и _');
const DICTS = {
  departments: {
    table: 'departments',
    create: z.object({ code, name: z.string().trim().min(1).max(120), weight: z.number().positive().max(100).default(1), is_product: z.boolean().default(false), sort_order: z.number().int().default(0) }),
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), weight: z.number().positive().max(100).optional(), is_product: z.boolean().optional(), is_active: z.boolean().optional(), sort_order: z.number().int().optional(), version: z.number().int() }),
    timestamps: true,
  },
  teams: {
    table: 'resource_teams',
    create: z.object({ code, name: z.string().trim().min(1).max(120), color, sort_order: z.number().int().default(0) }),
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), color, is_active: z.boolean().optional(), sort_order: z.number().int().optional(), version: z.number().int() }),
    timestamps: true,
  },
  categories: {
    table: 'categories',
    create: z.object({ name: z.string().trim().min(1).max(120), color, sort_order: z.number().int().default(0) }),
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), color, is_active: z.boolean().optional(), sort_order: z.number().int().optional(), version: z.number().int() }),
    timestamps: false,
  },
  statuses: {
    table: 'statuses',
    create: z.object({
      entity: z.enum(['feature', 'epic', 'release']), code, name: z.string().trim().min(1).max(120),
      semantic: z.enum(['new', 'analysis', 'ready', 'planned', 'in_progress', 'blocked', 'postponed', 'done', 'cancelled', 'active']), color, sort_order: z.number().int().default(0),
    }),
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), color, is_active: z.boolean().optional(), sort_order: z.number().int().optional(), version: z.number().int() }),
    timestamps: false,
  },
  stages: {
    table: 'stages',
    // phase on the Gantt (vNext §2.2): several stages may share one phase (Backend + Frontend = Разработка)
    create: z.object({ code, name: z.string().trim().min(1).max(120), sort_order: z.number().int().default(0), phase: z.enum(['product', 'design', 'dev', 'qa', 'release']).nullable().optional() }),
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), is_active: z.boolean().optional(), sort_order: z.number().int().optional(), phase: z.enum(['product', 'design', 'dev', 'qa', 'release']).nullable().optional(), version: z.number().int() }),
    timestamps: false,
  },
  periods: {
    table: 'capacity_periods',
    create: z.object({ name: z.string().trim().min(1).max(120), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), is_active: z.boolean().optional(), version: z.number().int() }),
    timestamps: true,
  },
} as const;
type DictKind = keyof typeof DICTS;

function dictOf(kind: string) {
  if (!(kind in DICTS)) throw notFound('Неизвестный справочник');
  return DICTS[kind as DictKind];
}

const toDb = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function registerAdminRoutes(r: Router) {
  // ───── users ─────
  /** Directory for pickers (initiator, future assignee): names only, active users, no e-mails. */
  r.get('/api/users/directory', async (ctx) => {
    requirePerm(ctx, perms.editCatalog);
    const users = await all(ctx.env.DB, 'SELECT id, name FROM users WHERE is_active = 1 ORDER BY name');
    return json({ users });
  });

  r.get('/api/admin/users', async (ctx) => {
    requirePerm(ctx, perms.admin);
    const users = await all(ctx.env.DB, `SELECT id, email, name, role_code, is_active, must_change_password, created_at, last_login_at, version,
      (password_hash IS NOT NULL) AS has_password,
      EXISTS (SELECT 1 FROM invites i WHERE i.user_id = users.id AND i.used_at IS NULL AND i.expires_at > ?) AS has_pending_invite
      FROM users ORDER BY name`, nowIso());
    const mem = await all(ctx.env.DB, 'SELECT user_id, department_id FROM department_memberships');
    return json({
      users: users.map((u) => ({
        ...u, role: u.role_code, is_active: !!u.is_active, must_change_password: !!u.must_change_password, has_password: !!u.has_password,
        has_pending_invite: !!u.has_pending_invite, department_ids: mem.filter((m) => m.user_id === u.id).map((m) => m.department_id),
      })),
    });
  });

  r.post('/api/admin/users', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const body = await readJson(ctx, z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      name: z.string().trim().min(1).max(120),
      role: roleEnum,
      department_ids: z.array(z.string()).max(50).default([]),
      delivery: z.enum(['invite', 'temp_password']).default('invite'),
    }));
    const db = ctx.env.DB;
    if (await first(db, 'SELECT 1 FROM users WHERE email = ?', body.email)) throw conflict('exists', 'Пользователь с таким email уже существует');
    await assertDepartments(ctx, body.department_ids);
    const id = newId('u');
    const now = nowIso();
    const cred = await credentialsStatements(ctx, id, body.delivery);
    await tx(db, [
      stmt(db, 'INSERT INTO users (id, email, name, role_code, must_change_password, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)', id, body.email, body.name, body.role, now, now),
      ...body.department_ids.map((d) => stmt(db, 'INSERT INTO department_memberships (user_id, department_id) VALUES (?, ?)', id, d)),
      ...cred.statements,
      auditStmt(db, admin, 'user', id, 'created', [{ field: 'role', old: null, new: body.role }, { field: 'departments', old: null, new: body.department_ids }]),
    ]);
    return json({ id, ...cred.result }, 201);
  });

  r.patch('/api/admin/users/:id', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const body = await readJson(ctx, z.object({
      name: z.string().trim().min(1).max(120).optional(),
      role: roleEnum.optional(),
      is_active: z.boolean().optional(),
      department_ids: z.array(z.string()).max(50).optional(),
      version: z.number().int(),
    }));
    const db = ctx.env.DB;
    const u = await first(db, 'SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!u) throw notFound('Пользователь не найден');
    if (body.department_ids) await assertDepartments(ctx, body.department_ids);
    const patch: Row = { name: body.name, role_code: body.role, is_active: body.is_active === undefined ? undefined : body.is_active ? 1 : 0 };
    const changes = diffFields(u, patch);
    const statements = [guardVersion(db, 'users', u.id, body.version)];
    const sets = changes.map((c) => `${c.field} = ?`);
    if (sets.length) statements.push(stmt(db, `UPDATE users SET ${sets.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...changes.map((c) => c.new), nowIso(), u.id));
    if (body.department_ids) {
      const before = (await all(db, 'SELECT department_id FROM department_memberships WHERE user_id = ?', u.id)).map((m) => m.department_id).sort();
      const after = [...new Set(body.department_ids)].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field: 'departments', old: before, new: after });
        statements.push(stmt(db, 'DELETE FROM department_memberships WHERE user_id = ?', u.id));
        for (const d of after) statements.push(stmt(db, 'INSERT INTO department_memberships (user_id, department_id) VALUES (?, ?)', u.id, d));
        if (!sets.length) statements.push(stmt(db, 'UPDATE users SET updated_at = ?, version = version + 1 WHERE id = ?', nowIso(), u.id));
      }
    }
    if (!changes.length) return json({ ok: true, unchanged: true });
    if (body.is_active === false) statements.push(stmt(db, 'DELETE FROM sessions WHERE user_id = ?', u.id));
    // never leave the system without an active administrator
    statements.push(abortIf(db, 'last_admin', `NOT EXISTS (SELECT 1 FROM users WHERE role_code = 'admin' AND is_active = 1)`));
    statements.push(auditStmt(db, admin, 'user', u.id, 'updated', changes));
    try {
      await tx(db, statements);
    } catch (e) {
      if ((e as { code?: string }).code === 'version_conflict') {
        const stillAdmin = await first(db, `SELECT COUNT(*) AS n FROM users WHERE role_code = 'admin' AND is_active = 1 AND id <> ?`, u.id);
        if (u.role_code === 'admin' && (body.role && body.role !== 'admin' || body.is_active === false) && !stillAdmin?.n) {
          throw conflict('last_admin', 'Нельзя отключить или понизить последнего администратора');
        }
      }
      throw e;
    }
    return json({ ok: true });
  });

  r.post('/api/admin/users/:id/reset', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const body = await readJson(ctx, z.object({ delivery: z.enum(['invite', 'temp_password']) }));
    const db = ctx.env.DB;
    const u = await first(db, 'SELECT id, role_code FROM users WHERE id = ?', ctx.params.id);
    if (!u) throw notFound('Пользователь не найден');
    const cred = await credentialsStatements(ctx, u.id, body.delivery);
    const statements = [...cred.statements, stmt(db, 'DELETE FROM sessions WHERE user_id = ?', u.id), auditStmt(db, admin, 'user', u.id, 'credentials_reset')];
    // resetting the only admin with an invite would lock everybody out until it is accepted — still allowed for
    // temp passwords; for invites require another working admin
    if (u.role_code === 'admin' && body.delivery === 'invite') {
      statements.push(abortIf(db, 'last_admin', `NOT EXISTS (SELECT 1 FROM users WHERE role_code = 'admin' AND is_active = 1 AND password_hash IS NOT NULL)`));
    }
    await tx(db, statements, 'Нельзя сбросить пароль единственного администратора приглашением — используйте временный пароль');
    return json(cred.result);
  });

  // ───── dictionaries ─────
  r.post('/api/admin/dict/:kind', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const d = dictOf(ctx.params.kind);
    const body = (await readJson(ctx, d.create)) as Row;
    if (ctx.params.kind === 'periods' && body.end_date < body.start_date) throw badRequest('Дата окончания раньше даты начала');
    const id = newId(ctx.params.kind.slice(0, 3));
    const now = nowIso();
    const cols = Object.keys(body);
    const vals = cols.map((c) => toDb(body[c]));
    const extraCols = d.timestamps ? ['created_at', 'updated_at'] : [];
    const db = ctx.env.DB;
    const statements = [
      stmt(db, `INSERT INTO ${d.table} (id, ${[...cols, ...extraCols].join(', ')}) VALUES (?, ${placeholders(cols.length + extraCols.length)})`, id, ...vals, ...extraCols.map(() => now)),
      auditStmt(db, admin, ctx.params.kind, id, 'created', cols.map((c) => ({ field: c, old: null, new: body[c] }))),
    ];
    if (ctx.params.kind === 'departments' && body.is_product) statements.unshift(stmt(db, 'UPDATE departments SET is_product = 0, version = version + 1 WHERE is_product = 1'));
    await tx(db, statements);
    return json({ id }, 201);
  });

  r.patch('/api/admin/dict/:kind/:id', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const kind = ctx.params.kind;
    const d = dictOf(kind);
    const body = (await readJson(ctx, d.patch)) as Row;
    const db = ctx.env.DB;
    const row = await first(db, `SELECT * FROM ${d.table} WHERE id = ?`, ctx.params.id);
    if (!row) throw notFound();
    const { version, ...rest } = body;
    const patch: Row = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = toDb(v);
    const changes = diffFields(row, patch);
    if (!changes.length) return json({ ok: true, unchanged: true });
    if (kind === 'periods') {
      const s = patch.start_date ?? row.start_date;
      const e = patch.end_date ?? row.end_date;
      if (e < s) throw badRequest('Дата окончания раньше даты начала');
    }
    const statements = [
      guardVersion(db, d.table, row.id, version),
      stmt(db, `UPDATE ${d.table} SET ${changes.map((c) => `${c.field} = ?`).join(', ')}${d.timestamps ? ', updated_at = ?' : ''}, version = version + 1 WHERE id = ?`,
        ...changes.map((c) => c.new), ...(d.timestamps ? [nowIso()] : []), row.id),
      auditStmt(db, admin, kind, row.id, 'updated', changes),
    ];
    if (kind === 'departments' && patch.is_product === 1) statements.splice(1, 0, stmt(db, 'UPDATE departments SET is_product = 0 WHERE is_product = 1 AND id <> ?', row.id));
    if (kind === 'departments' && changes.some((c) => c.field === 'weight' || c.field === 'is_active')) {
      statements.push(planAlertIfStmt(db, 'department_weight', `Изменён вес/активность отдела «${row.name}» — рейтинг пересчитан, проверьте утверждённый план`, 'department', row.id, ANY_LOCKED_SQL));
    }
    await tx(db, statements);
    return json({ ok: true });
  });

  // ───── settings ─────
  r.put('/api/admin/settings', async (ctx) => {
    const admin = requirePerm(ctx, perms.admin);
    const body = await readJson(ctx, z.object({
      public_show_estimates: z.boolean().optional(),
      public_show_capacity: z.boolean().optional(),
      planning_horizon: z.number().int().min(1).max(24).optional(),
      // calendar generator (FR-06): reference sprint start (a Wednesday) and its release number
      calendar_anchor_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 3, 'Опорная дата должна быть средой').optional(),
      calendar_anchor_release: z.number().int().min(1).max(10000).optional(),
      calendar_releases_ahead: z.number().int().min(1).max(12).optional(),
      calendar_months_ahead: z.number().int().min(1).max(36).optional(),
      // FR-08: the only spreadsheet the export may write to (its «Import» tab), and who may write there
      export_google_spreadsheet_id: z.string().trim().max(300).transform((v) => (v ? parseSpreadsheetId(v) ?? '#invalid' : '')).refine((v) => v !== '#invalid', 'Укажите ссылку на Google-таблицу или её ID').optional(),
      budget_allocation: z.enum(['workdays', 'calendar_days']).optional(),
      analytics_high_priority: z.number().min(1).max(5).optional(),
      export_google_roles: z.array(z.enum(['department_lead', 'product', 'admin'])).min(1).transform((v) => v.join(',')).optional(),
    }));
    const db = ctx.env.DB;
    const statements = [];
    const changes = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      const val = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      statements.push(stmt(db, 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, val));
      changes.push({ field: k, old: null, new: val });
    }
    statements.push(auditStmt(db, admin, 'settings', 'app', 'updated', changes));
    await tx(db, statements);
    return json({ ok: true });
  });

  // ───── audit log ─────
  r.get('/api/admin/audit', async (ctx) => {
    requirePerm(ctx, perms.admin);
    const et = ctx.url.searchParams.get('entity_type');
    const actor = ctx.url.searchParams.get('actor_id');
    const before = Number(ctx.url.searchParams.get('before') || '0');
    const where: string[] = [];
    const vals: unknown[] = [];
    if (et) { where.push('entity_type = ?'); vals.push(et); }
    if (actor) { where.push('actor_id = ?'); vals.push(actor); }
    if (before > 0) { where.push('id < ?'); vals.push(before); }
    const rows = await all(ctx.env.DB, `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 100`, ...vals);
    return json({ entries: rows.map((e) => ({ ...e, changes: e.changes ? JSON.parse(e.changes) : null, is_override: !!e.is_override })) });
  });
}

async function assertDepartments(ctx: Ctx, ids: string[]) {
  if (!ids.length) return;
  const rows = await all(ctx.env.DB, `SELECT id FROM departments WHERE id IN (${placeholders(ids.length)})`, ...ids);
  if (rows.length !== new Set(ids).size) throw badRequest('Указан несуществующий отдел');
}

// Manual export of tasks (FR-08): XLSX download or the «Import» tab of the admin-configured Google spreadsheet.
// The server re-runs the backlog query with the caller's rights — the client list is never trusted.
import { z } from 'zod';
import { exportTable } from '../domain/exportTable';
import { xlsx } from '../domain/xlsx';
import { requireUser, type SessionUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { all, newId, nowIso, run, stmt, tx } from '../lib/db';
import { writeImportTab, EXPORT_SHEET } from '../lib/google';
import { conflict, forbidden, HttpError, json, readJson, type Ctx, type Router } from '../lib/http';
import { indexWorld, isProductInternal, loadWorld, viewerOf } from '../lib/world';
import { queryFeatures } from './features';

export const EXPORT_LIMIT = 5000;
const body = z.object({ query: z.string().max(4000).default('') });

/** query string from the backlog; `internal` is honoured only for product/admin (inside queryFeatures) */
async function selection(ctx: Ctx, query: string) {
  const user = requireUser(ctx);
  const viewer = viewerOf(user);
  const p = new URLSearchParams(query.replace(/^\?/, ''));
  const w = await loadWorld(ctx.env.DB, viewer, { includeInternal: true });
  const idx = indexWorld(w);
  const rows = queryFeatures(p, viewer, w, idx);
  if (rows.length > EXPORT_LIMIT) throw new HttpError(413, 'too_many', `Выборка больше ${EXPORT_LIMIT} задач — уточните фильтры`);
  return { user, viewer, rows, table: exportTable(rows, viewer, w, idx), internal: rows.filter((f) => isProductInternal(f)).length, settings: w.settings };
}

function canGoogle(user: SessionUser, settings: Record<string, string>) {
  const roles = (settings.export_google_roles || 'product,admin').split(',').map((x) => x.trim());
  return !user.apiKey && roles.includes(user.role);
}

async function logRun(ctx: Ctx, user: SessionUser, target: 'xlsx' | 'google', query: string, count: number, status: 'done' | 'failed', error?: string) {
  const db = ctx.env.DB;
  const id = newId('exp');
  await tx(db, [
    stmt(db, 'INSERT INTO export_runs (id, actor_id, api_key_id, target, query, row_count, status, error, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, user.id, user.apiKey?.id ?? null, target, query, count, status, error ?? null, nowIso(), nowIso()),
    auditStmt(db, user, 'export', id, target, [{ field: 'rows', old: null, new: count }, { field: 'query', old: null, new: query }]),
  ]);
}

export function registerExportRoutes(r: Router) {
  r.get('/api/exports/config', async (ctx) => {
    const user = requireUser(ctx);
    const s = Object.fromEntries((await all(ctx.env.DB, "SELECT key, value FROM app_settings WHERE key LIKE 'export_%'")).map((x) => [x.key, x.value]));
    const allowed = canGoogle(user, s);
    return json({
      limit: EXPORT_LIMIT,
      roles: (s.export_google_roles || 'product,admin'),
      google: { configured: !!s.export_google_spreadsheet_id, allowed, sheet: EXPORT_SHEET, ...(allowed && s.export_google_spreadsheet_id ? { url: `https://docs.google.com/spreadsheets/d/${s.export_google_spreadsheet_id}` } : {}) },
    });
  });

  r.post('/api/exports/preview', async (ctx) => {
    const b = await readJson(ctx, body);
    const s = await selection(ctx, b.query);
    return json({ count: s.rows.length, internal_count: s.internal, columns: s.table[0] });
  });

  r.post('/api/exports/xlsx', async (ctx) => {
    const b = await readJson(ctx, body);
    const s = await selection(ctx, b.query);
    const file = xlsx('Задачи', s.table);
    await logRun(ctx, s.user, 'xlsx', b.query, s.rows.length, 'done');
    const name = `rafinad-tasks-${nowIso().slice(0, 10)}.xlsx`;
    return new Response(file as unknown as BodyInit, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
        'x-export-count': String(s.rows.length),
      },
    });
  });

  r.post('/api/exports/google', async (ctx) => {
    const b = await readJson(ctx, body.extend({ confirm_external: z.boolean().optional(), confirm_internal: z.boolean().optional() }));
    const s = await selection(ctx, b.query);
    if (!canGoogle(s.user, s.settings)) throw forbidden('Выгрузка в Google-таблицу недоступна для вашей роли');
    const target = s.settings.export_google_spreadsheet_id;
    if (!target) throw new HttpError(400, 'not_configured', 'Администратор ещё не указал таблицу для экспорта');
    if (!b.confirm_external) {
      throw conflict('confirm_external', `Вкладку «${EXPORT_SHEET}» увидят все, у кого есть доступ к Google-таблице. Будет выгружено задач: ${s.rows.length}.`, { count: s.rows.length, internal_count: s.internal });
    }
    if (s.internal && !b.confirm_internal) {
      throw conflict('confirm_internal', `В выгрузке ${s.internal} внутренних задач продукта — они станут видны читателям таблицы.`, { count: s.rows.length, internal_count: s.internal });
    }
    const db = ctx.env.DB;
    const id = newId('exp');
    // concurrent Google exports: the partial unique index lets only one 'running' row exist
    await run(db, `UPDATE export_runs SET status = 'failed', error = 'прервано', finished_at = ? WHERE target = 'google' AND status = 'running' AND created_at < ?`, nowIso(), new Date(Date.now() - 5 * 60_000).toISOString());
    try {
      await run(db, "INSERT INTO export_runs (id, actor_id, api_key_id, target, query, row_count, status, created_at) VALUES (?, ?, NULL, 'google', ?, ?, 'running', ?)", id, s.user.id, b.query, s.rows.length, nowIso());
    } catch {
      throw conflict('export_running', 'Другая выгрузка в Google-таблицу ещё идёт. Повторите через минуту.');
    }
    try {
      await writeImportTab(ctx.env, target, s.table);
    } catch (e) {
      await run(db, "UPDATE export_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", (e as Error).message.slice(0, 500), nowIso(), id);
      throw e;
    }
    await tx(db, [
      stmt(db, "UPDATE export_runs SET status = 'done', finished_at = ? WHERE id = ?", nowIso(), id),
      auditStmt(db, s.user, 'export', id, 'google', [{ field: 'rows', old: null, new: s.rows.length }, { field: 'query', old: null, new: b.query }], s.internal ? `включены внутренние задачи продукта: ${s.internal}` : null, s.internal > 0),
    ]);
    return json({ ok: true, count: s.rows.length, url: `https://docs.google.com/spreadsheets/d/${target}` });
  });

  r.get('/api/exports/runs', async (ctx) => {
    const user = requireUser(ctx);
    const rows = user.role === 'admin'
      ? await all(ctx.env.DB, 'SELECT e.*, u.name AS actor_name FROM export_runs e LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.created_at DESC LIMIT 100')
      : await all(ctx.env.DB, 'SELECT e.*, u.name AS actor_name FROM export_runs e LEFT JOIN users u ON u.id = e.actor_id WHERE e.actor_id = ? ORDER BY e.created_at DESC LIMIT 50', user.id);
    return json({ runs: rows });
  });
}


// Manual export of tasks (FR-08): XLSX download or the «Import» tab of the admin-configured Google spreadsheet.
// The server re-runs the backlog query with the caller's rights — the client list is never trusted.
import { z } from 'zod';
import { buildTable, flatRows, type BuiltTable } from '../domain/exportBuild';
import { FIELD_GROUPS, fieldCatalog, TASKFLOW_SPEC, TASKFLOW_TEMPLATE_ID, type ExportSpec, type FieldCtx } from '../domain/exportFields';
import { exportTable } from '../domain/exportTable';
import type { Timeline } from '../domain/phases';
import { xlsx, xlsxReport } from '../domain/xlsx';
import { requireUser, type SessionUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { all, first, guardVersion, newId, nowIso, parseJson, run, stmt, tx, type Row } from '../lib/db';
import { writeImportTab, writeTab, EXPORT_SHEET } from '../lib/google';
import { badRequest, conflict, forbidden, HttpError, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { indexWorld, isClosed, isProductInternal, loadWorld, viewerOf, visibleFeatures } from '../lib/world';
import { queryFeatures, sortFeatures } from './features';
import { loadPhaseData, timelineFor } from './phases';

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

// ───────────────────────── export builder (vNext ТЗ §4, owner decision 13.10 №15) ─────────────────────────

const specSchema = z.object({
  columns: z.array(z.object({ field: z.string().min(1).max(80), title: z.string().trim().max(120).optional() })).min(1, 'Выберите хотя бы одну колонку').max(80),
  query: z.string().max(4000).default(''),
  sort: z.array(z.object({ field: z.string().min(1).max(80), dir: z.enum(['asc', 'desc']) })).max(3).default([]),
  groups: z.array(z.string().min(1).max(80)).max(2).default([]),
  subtotals: z.boolean().default(true),
});
const buildBody = z.object({ spec: specSchema.optional(), template_id: z.string().max(80).optional() });

/** the world and the field catalog of this viewer: fields it may not see are not in the catalog at all */
async function builderContext(ctx: Ctx) {
  const user = requireUser(ctx);
  const viewer = viewerOf(user);
  const db = ctx.env.DB;
  const w = await loadWorld(db, viewer, { includeInternal: true });
  const idx = indexWorld(w);
  const proposalsBy = new Map<string, { key: string; title: string }[]>();
  for (const p of await all(db, 'SELECT pf.feature_id, p.number, p.title FROM proposal_features pf JOIN proposals p ON p.id = pf.proposal_id WHERE p.merged_into_id IS NULL ORDER BY p.number')) {
    if (!proposalsBy.has(p.feature_id)) proposalsBy.set(p.feature_id, []);
    proposalsBy.get(p.feature_id)!.push({ key: `P-${p.number}`, title: p.title });
  }
  const phases = await loadPhaseData(db);
  const today = new Date().toISOString().slice(0, 10);
  const memo = new Map<string, Timeline>();
  const timeline = (f: Row) => { if (!memo.has(f.id)) memo.set(f.id, timelineFor(f, idx, phases, today)); return memo.get(f.id)!; };
  // the rating as on «Приоритеты»: open tasks this viewer sees, by department priority
  const rank = new Map(sortFeatures(visibleFeatures(w, viewer).filter((f) => !isClosed(f, idx)), w, idx, 'priority').map((f, i) => [f.id, i + 1]));
  const fctx: FieldCtx = { viewer, w, idx, proposalsBy, timeline, rank };
  return { user, viewer, w, idx, catalog: fieldCatalog(fctx) };
}

interface Template { id: string; name: string; scope: 'builtin' | 'personal' | 'shared'; owner_id: string | null; spec: ExportSpec; version: number }
const BUILTIN: Template = { id: TASKFLOW_TEMPLATE_ID, name: 'TaskFlow — 12 колонок', scope: 'builtin', owner_id: null, spec: TASKFLOW_SPEC, version: 1 };

async function loadTemplate(ctx: Ctx, user: SessionUser, id: string): Promise<Template> {
  if (id === TASKFLOW_TEMPLATE_ID) return BUILTIN;
  const t = await first(ctx.env.DB, 'SELECT * FROM export_templates WHERE id = ?', id);
  if (!t || (t.scope === 'personal' && t.owner_id !== user.id)) throw notFound('Шаблон не найден');
  return { id: t.id, name: t.name, scope: t.scope, owner_id: t.owner_id, spec: parseJson<ExportSpec>(t.spec, TASKFLOW_SPEC), version: t.version };
}
const canEditTemplate = (user: SessionUser, t: { scope: string; owner_id: string | null }) =>
  !user.apiKey && (t.scope === 'shared' ? user.role === 'admin' : t.scope === 'personal' && t.owner_id === user.id);

async function builderSelection(ctx: Ctx, b: z.infer<typeof buildBody>) {
  const c = await builderContext(ctx);
  const template = b.template_id ? await loadTemplate(ctx, c.user, b.template_id) : null;
  // unsaved edits of a template win over its stored spec
  const spec = (b.spec as ExportSpec | undefined) ?? template?.spec;
  if (!spec) throw badRequest('Укажите шаблон или набор колонок');
  const rows = queryFeatures(new URLSearchParams(spec.query.replace(/^\?/, '')), c.viewer, c.w, c.idx);
  if (rows.length > EXPORT_LIMIT) throw new HttpError(413, 'too_many', `Выборка больше ${EXPORT_LIMIT} задач — уточните фильтры`);
  const table = buildTable(rows, spec, c.catalog);
  if (!table.columns.length) throw badRequest('Ни одна из выбранных колонок вам недоступна');
  // the TaskFlow exchange keeps its own file and its «Import» tab while its layout is untouched (filters may differ)
  const layout = (x: ExportSpec) => JSON.stringify([x.columns.map((c) => [c.field, c.title ?? '']), x.sort, x.groups]);
  const builtin = template?.id === TASKFLOW_TEMPLATE_ID && layout(spec) === layout(TASKFLOW_SPEC);
  // a changed copy of the built-in layout is no longer «TaskFlow»: its own sheet name and Google tab
  const name = template && (template.scope !== 'builtin' || builtin) ? template.name : 'Конструктор';
  return { ...c, spec, rows, table, template, builtin, name, internal: rows.filter((f) => isProductInternal(f)).length };
}

const TYPE_LABEL: Record<string, string> = { text: 'текст', number: 'число', date: 'дата ДД.ММ.ГГГГ', bool: 'Да / Нет', list: 'список через запятую', lines: 'несколько значений — по строке в ячейке' };
const googleTab = (name: string, builtin: boolean) => (builtin ? EXPORT_SHEET : `Экспорт — ${name}`.replace(/[\[\]*?/\\:]/g, ' ').slice(0, 90));

function structureOf(t: BuiltTable, name: string, builtin: boolean, subtotals: boolean) {
  return {
    sheet: name,
    columns: t.columns.map((c) => ({ title: c.title, type: TYPE_LABEL[c.type] ?? c.type, sum: c.sum && subtotals })),
    groups: t.groups.map((g) => g.label),
    excel: t.groups.length
      ? `Строки-заголовки групп над задачами${subtotals && t.columns.some((c) => c.sum) ? ' с промежуточными итогами часов' : ''}; уровни можно сворачивать кнопками «1 / 2${t.groups.length > 1 ? ' / 3' : ''}» слева.`
      : 'Плоская таблица с автофильтром, шапка закреплена.',
    google: builtin
      ? `Вкладка «${EXPORT_SHEET}» перезаписывается целиком, другие вкладки не меняются.`
      : `Вкладка «${googleTab(name, false)}» (создаётся при первой выгрузке, другие вкладки не меняются): плоская таблица без строк групп${t.groups.some((g) => !t.columns.some((c) => c.field === g.field)) ? ', поля группировки — первыми колонками' : ''}.`,
  };
}

export function registerExportRoutes(r: Router) {
  r.get('/api/exports/fields', async (ctx) => {
    const c = await builderContext(ctx);
    return json({
      groups: FIELD_GROUPS.map((g) => ({
        name: g,
        fields: c.catalog.filter((f) => f.group === g).map((f) => ({ id: f.id, label: f.label, type: f.type, sum: !!f.sum, groupable: !!f.groupable })),
      })).filter((g) => g.fields.length),
    });
  });

  r.get('/api/exports/templates', async (ctx) => {
    const user = requireUser(ctx);
    const rows = await all(ctx.env.DB, `SELECT t.*, u.name AS owner_name FROM export_templates t LEFT JOIN users u ON u.id = t.owner_id
      WHERE t.scope = 'shared' OR t.owner_id = ? ORDER BY t.scope DESC, t.name`, user.id);
    return json({
      templates: [
        { ...BUILTIN, can_edit: false },
        ...rows.map((t) => ({ id: t.id, name: t.name, scope: t.scope, owner_name: t.owner_name ?? null, spec: parseJson(t.spec, null), version: t.version, can_edit: canEditTemplate(user, { scope: t.scope, owner_id: t.owner_id }) })),
      ],
      can_share: user.role === 'admin' && !user.apiKey,
    });
  });

  r.post('/api/exports/templates', async (ctx) => {
    const user = requireUser(ctx);
    if (user.apiKey) throw forbidden('Шаблоны сохраняются только из интерфейса');
    const b = await readJson(ctx, z.object({ name: z.string().trim().min(1).max(120), scope: z.enum(['personal', 'shared']).default('personal'), spec: specSchema }));
    if (b.scope === 'shared' && user.role !== 'admin') throw forbidden('Общие шаблоны создаёт администратор');
    const id = newId('xt');
    const now = nowIso();
    await tx(ctx.env.DB, [
      stmt(ctx.env.DB, 'INSERT INTO export_templates (id, name, scope, owner_id, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, b.name, b.scope, user.id, JSON.stringify(b.spec), now, now),
      auditStmt(ctx.env.DB, user, 'export', id, 'template_created', [{ field: 'name', old: null, new: b.name }, { field: 'scope', old: null, new: b.scope }]),
    ]);
    return json({ id, version: 1 }, 201);
  });

  r.put('/api/exports/templates/:id', async (ctx) => {
    const user = requireUser(ctx);
    const t = await loadTemplate(ctx, user, ctx.params.id);
    if (!canEditTemplate(user, t)) throw forbidden(t.scope === 'builtin' ? 'Встроенный шаблон TaskFlow не меняется — сохраните копию' : 'Изменять общий шаблон может администратор');
    const b = await readJson(ctx, z.object({ name: z.string().trim().min(1).max(120).optional(), spec: specSchema.optional(), version: z.number().int() }));
    const db = ctx.env.DB;
    await tx(db, [
      guardVersion(db, 'export_templates', t.id, b.version),
      stmt(db, 'UPDATE export_templates SET name = ?, spec = ?, updated_at = ?, version = version + 1 WHERE id = ?', b.name ?? t.name, JSON.stringify(b.spec ?? t.spec), nowIso(), t.id),
      auditStmt(db, user, 'export', t.id, 'template_changed', b.name && b.name !== t.name ? [{ field: 'name', old: t.name, new: b.name }] : null),
    ], 'Шаблон изменил другой пользователь. Обновите страницу.');
    return json({ ok: true, version: b.version + 1 });
  });

  r.delete('/api/exports/templates/:id', async (ctx) => {
    const user = requireUser(ctx);
    const t = await loadTemplate(ctx, user, ctx.params.id);
    if (!canEditTemplate(user, t)) throw forbidden(t.scope === 'builtin' ? 'Встроенный шаблон нельзя удалить' : 'Удалять общий шаблон может администратор');
    await tx(ctx.env.DB, [
      stmt(ctx.env.DB, 'DELETE FROM export_templates WHERE id = ?', t.id),
      auditStmt(ctx.env.DB, user, 'export', t.id, 'template_deleted', [{ field: 'name', old: t.name, new: null }]),
    ]);
    return json({ ok: true });
  });

  r.post('/api/exports/build/preview', async (ctx) => {
    const s = await builderSelection(ctx, await readJson(ctx, buildBody));
    return json({
      count: s.rows.length, internal_count: s.internal,
      header: s.table.header, columns: s.table.columns,
      rows: s.table.rows.slice(0, 50).map((r) => ({ kind: r.kind, level: r.level, cells: r.cells })),
      total_rows: s.table.rows.length,
      skipped: s.table.skipped,
      structure: structureOf(s.table, s.name, s.builtin, s.spec.subtotals),
    });
  });

  r.post('/api/exports/build/xlsx', async (ctx) => {
    const b = await readJson(ctx, buildBody);
    const s = await builderSelection(ctx, b);
    const file = s.builtin ? xlsx('Задачи', flatRows(s.table)) : xlsxReport(s.name, s.table.header, s.table.rows);
    await logRun(ctx, s.user, 'xlsx', `${s.name}: ${s.spec.query}`, s.rows.length, 'done');
    const slug = s.builtin ? 'rafinad-tasks' : 'rafinad-export';
    return new Response(file as unknown as BodyInit, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${slug}-${nowIso().slice(0, 10)}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${s.name} ${nowIso().slice(0, 10)}.xlsx`)}`,
        'cache-control': 'no-store',
        'x-export-count': String(s.rows.length),
      },
    });
  });

  r.post('/api/exports/build/google', async (ctx) => {
    const b = await readJson(ctx, buildBody.extend({ confirm_external: z.boolean().optional(), confirm_internal: z.boolean().optional() }));
    const s = await builderSelection(ctx, b);
    if (!canGoogle(s.user, s.w.settings)) throw forbidden('Выгрузка в Google-таблицу недоступна для вашей роли');
    const target = s.w.settings.export_google_spreadsheet_id;
    if (!target) throw new HttpError(400, 'not_configured', 'Администратор ещё не указал таблицу для экспорта');
    const tab = googleTab(s.name, s.builtin);
    if (!b.confirm_external) {
      throw conflict('confirm_external', `Вкладку «${tab}» увидят все, у кого есть доступ к Google-таблице. Будет выгружено задач: ${s.rows.length}.`, { count: s.rows.length, internal_count: s.internal, tab });
    }
    if (s.internal && !b.confirm_internal) {
      throw conflict('confirm_internal', `В выгрузке ${s.internal} внутренних задач продукта — они станут видны читателям таблицы.`, { count: s.rows.length, internal_count: s.internal, tab });
    }
    const db = ctx.env.DB;
    const id = newId('exp');
    await run(db, `UPDATE export_runs SET status = 'failed', error = 'прервано', finished_at = ? WHERE target = 'google' AND status = 'running' AND created_at < ?`, nowIso(), new Date(Date.now() - 5 * 60_000).toISOString());
    const label = `${s.name}: ${s.spec.query}`;
    try {
      await run(db, "INSERT INTO export_runs (id, actor_id, api_key_id, target, query, row_count, status, created_at) VALUES (?, ?, NULL, 'google', ?, ?, 'running', ?)", id, s.user.id, label, s.rows.length, nowIso());
    } catch {
      throw conflict('export_running', 'Другая выгрузка в Google-таблицу ещё идёт. Повторите через минуту.');
    }
    try {
      await writeTab(ctx.env, target, flatRows(s.table), tab, !s.builtin);
    } catch (e) {
      await run(db, "UPDATE export_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", (e as Error).message.slice(0, 500), nowIso(), id);
      throw e;
    }
    await tx(db, [
      stmt(db, "UPDATE export_runs SET status = 'done', finished_at = ? WHERE id = ?", nowIso(), id),
      auditStmt(db, s.user, 'export', id, 'google', [{ field: 'rows', old: null, new: s.rows.length }, { field: 'tab', old: null, new: tab }, { field: 'query', old: null, new: s.spec.query }], s.internal ? `включены внутренние задачи продукта: ${s.internal}` : null, s.internal > 0),
    ]);
    return json({ ok: true, count: s.rows.length, tab, url: `https://docs.google.com/spreadsheets/d/${target}` });
  });

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


// Google Sheets / CSV import: sources, connection check, preview, decisions, atomic idempotent apply.
import { z } from 'zod';
import { parseCsv, toCsv } from '../domain/csv';
import { findCycle, type Edge } from '../domain/graph';
import {
  buildLookup, buildPreview, countItems, DEFAULT_IMPORT_CONFIG, linkPlanFor, resolveEpicExt, resolveMerged, SHEET_COLUMNS, SHEET_KEYS, sourceSheetNames, sourceValues, unresolvedReasons,
  type ImportConfig, type ItemDraft, type Resolution, type SheetHyperlinks, type SheetKey, type SheetsData, type Snapshot,
} from '../domain/importer';
import { DEMO_SHEETS } from '../demoData';
import { emptyPlan, linkSummary, type LinkPlan, type SourceLink } from '../domain/linkImport';
import { BUGS_CONFIG, BUGS_SPREADSHEET_ID, IMPROVEMENTS_CONFIG, TASKFLOW_CONFIG } from '../domain/flatSheet';
import { perms, requirePerm } from '../lib/auth';
import { auditStmt, type Change } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { abortIf, all, bool, first, guardVersion, newId, nowIso, parseJson, run as runSql, stmt, tx, type Row } from '../lib/db';
import { fetchSpreadsheet, parseSpreadsheetId, serviceAccount } from '../lib/google';
import { badRequest, conflict, HttpError, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import type { D1Database, D1PreparedStatement } from '../env';

const colName = z.string().trim().min(1).max(100);
const optCol = z.string().trim().max(100).optional().transform((v) => (v ? v : undefined));
const flatSchema = z.object({
  sheet: colName,
  columns: z.object({
    id: optCol, title: colName, description: optCol, category: optCol, assignee: optCol,
    deadline: z.array(colName).max(5).optional(), closed_at: optCol, done: optCol, priority: optCol, fact_hours: optCol,
    id_pattern: z.string().max(100).optional().refine((v) => { if (!v) return true; try { new RegExp(v); return true; } catch { return false; } }, 'Некорректное регулярное выражение'),
    status: optCol, urgency: optCol, requested_at: optCol, initiator: optCol, author: optCol,
    extra: z.array(colName).max(20).optional(),
  }),
  kind: z.enum(['planned', 'bug', 'operational_improvement']).optional(),
  status_map: z.record(z.string().max(60), z.enum(['new', 'analysis', 'ready', 'planned', 'in_progress', 'blocked', 'postponed', 'done', 'cancelled'])).optional(),
  urgency_map: z.record(z.string().max(60), z.enum(['low', 'medium', 'high', 'critical'])).optional(),
  fact_hours_as: z.enum(['description', 'field']).optional(),
  flags: z.record(colName, z.string().trim().min(1).max(40)).default({}),
  hours: z.record(colName, z.string().trim().min(1).max(40)).default({}),
  links: z.record(colName, z.enum(['bitrix24', 'jira', 'docs', 'other'])).optional(),
  links_from_text: z.boolean().optional(),
});
const configSchema = z.object({
  format: z.enum(['template', 'flat']).default('template'),
  // an «offers» key of a config saved before vNext is accepted and dropped
  sheets: z.object({ epics: colName, features: colName, relations: colName }).default(DEFAULT_IMPORT_CONFIG.sheets),
  hoursColumns: z.record(colName, z.string().trim().min(1).max(40)).default({}),
  flat: flatSchema.optional(),
  newVisibility: z.enum(['draft', 'internal']).default('draft'),
}).refine((c) => c.format !== 'flat' || !!c.flat, { message: 'Для формата «одна таблица» укажите лист и колонки' });

const configOf = (s: Row) => parseJson<ImportConfig>(s.config, DEFAULT_IMPORT_CONFIG);

function sourceDto(s: Row, lastRun?: Row | null) {
  const csv = parseJson<Record<string, string>>(s.csv_data, {});
  return {
    id: s.id, name: s.name, kind: s.kind, spreadsheet_id: s.spreadsheet_id, config: parseJson(s.config, DEFAULT_IMPORT_CONFIG),
    is_active: bool(s.is_active), created_at: s.created_at, updated_at: s.updated_at, version: s.version,
    last_checked_at: s.last_checked_at, last_check_ok: s.last_check_ok === null ? null : bool(s.last_check_ok), last_check_msg: s.last_check_msg,
    csv_sheets: s.kind === 'csv' ? Object.fromEntries(Object.entries(csv).map(([k, v]) => [k, { rows: Math.max(0, parseCsv(v).length - 1), bytes: v.length }])) : undefined,
    last_run: lastRun ? { id: lastRun.id, status: lastRun.status, created_at: lastRun.created_at, applied_at: lastRun.applied_at, counts: parseJson(lastRun.counts, null) } : null,
  };
}

async function getSource(ctx: Ctx, id: string) {
  const s = await first(ctx.env.DB, 'SELECT * FROM sheet_sources WHERE id = ?', id);
  if (!s) throw notFound('Источник не найден');
  return s;
}

/**
 * Reads the source. Never writes anything: a failing Google API leaves the backlog untouched.
 * `files` — a CSV export uploaded by the user instead of reading Google directly (key: sheet key or 'flat').
 */
async function readSource(ctx: Ctx, s: Row, files?: Record<string, string>): Promise<{ data: SheetsData; hash: string; notes: string[]; title: string | null; hyperlinks: SheetHyperlinks }> {
  const config = configOf(s);
  const wanted = sourceSheetNames(config);
  const data: SheetsData = {};
  const notes: string[] = [];
  const hyperlinks: SheetHyperlinks = {};
  let title: string | null = null;
  // columns whose hidden hyperlinks are read from Google (flat sources with link columns / links in text)
  const flat = config.format === 'flat' ? config.flat : undefined;
  const linkHeaders = flat ? [...Object.keys(flat.links ?? {}), ...(flat.links_from_text ? [flat.columns.title, flat.columns.description ?? ''] : [])].filter(Boolean) : [];
  if (files) {
    for (const w of wanted) {
      if (files[w.key]) data[w.key] = parseCsv(files[w.key]);
      else if (wanted.length > 1) notes.push(`Файл для листа «${w.name}» не загружен — лист пропущен`);
    }
    title = 'Загруженная выгрузка';
  } else if (s.kind === 'google') {
    if (!s.spreadsheet_id) throw badRequest('Не указана таблица Google Sheets');
    const res = await fetchSpreadsheet(ctx.env, s.spreadsheet_id, wanted.map((w) => w.name), { linkColumns: flat && linkHeaders.length ? { [flat.sheet]: linkHeaders } : {} });
    title = res.title;
    if (flat && res.hyperlinks?.[flat.sheet]) hyperlinks.flat = res.hyperlinks[flat.sheet];
    if (flat && linkHeaders.length && res.mode === 'public_link') notes.push('Гиперссылки, скрытые за текстом ячеек, читаются только через сервисный аккаунт — импортированы адреса, видимые в тексте');
    for (const w of wanted) {
      if (res.data[w.name]) data[w.key] = res.data[w.name];
      else notes.push(`Лист «${w.name}» не найден${res.available.length ? ` (есть: ${res.available.slice(0, 20).join(', ')})` : ''} — пропущен`);
    }
  } else {
    const csv = parseJson<Record<string, string>>(s.csv_data, {});
    for (const w of wanted) {
      if (csv[w.key]) data[w.key] = parseCsv(csv[w.key]);
      else notes.push(`CSV для листа «${w.name}» не загружен — пропущен`);
    }
  }
  if (!Object.keys(data).length) throw badRequest('В источнике нет ни одного листа для импорта');
  const canonical = wanted.map((w) => [w.key, data[w.key] ?? null]);
  // hidden hyperlinks are part of the source: a changed link makes an older preview stale
  if (hyperlinks.flat) canonical.push(['flat:hyperlinks', hyperlinks.flat as any]);
  return { data, hash: await sha256Hex(JSON.stringify(canonical)), notes, title, hyperlinks };
}

async function loadSnapshot(db: D1Database, sourceId: string): Promise<Snapshot> {
  const q = (sql: string, ...v: unknown[]) => stmt(db, sql, ...v);
  const res = await db.batch([
    q('SELECT id, name FROM categories'),
    q('SELECT id, entity, code, name, semantic, sort_order FROM statuses WHERE is_active = 1'),
    q('SELECT id, code, name FROM stages WHERE is_active = 1'),
    q('SELECT id, code, name FROM resource_teams WHERE is_active = 1 ORDER BY sort_order'),
    q('SELECT entity_type, external_id, entity_id, last_values FROM source_entity_links WHERE source_id = ?', sourceId),
    q('SELECT id, number, title, description, category_id, status_id, external_ref, version FROM epics'),
    q('SELECT id, number, title, description, category_id, status_id, external_ref, version, merged_into_id, epic_id, stage_id, requested_at, assignee_name, planned_end, urgency, fact_hours FROM features'),
    q('SELECT type, from_id, to_id FROM feature_relations'),
    q('SELECT feature_id, team_id, hours, is_manual FROM feature_estimates'),
    q('SELECT feature_id, tag FROM feature_tags ORDER BY tag'),
    q('SELECT id, name FROM departments'),
    q('SELECT id, name FROM users WHERE is_active = 1'),
    q('SELECT id, feature_id, kind, url, origin, source_id, locally_edited FROM feature_links'),
    q('SELECT entity_type, external_id, entity_key, deleted_at FROM import_tombstones WHERE source_id = ?', sourceId),
    q("SELECT key, value FROM app_settings WHERE key IN ('number_floor.features', 'number_floor.epics')"),
  ]);
  const r = (i: number) => (res[i].results ?? []) as Row[];
  const est = new Map<string, Record<string, { hours: number; is_manual: number }>>();
  for (const e of r(8)) {
    if (!est.has(e.feature_id)) est.set(e.feature_id, {});
    est.get(e.feature_id)![e.team_id] = { hours: e.hours, is_manual: e.is_manual };
  }
  const tagsBy = new Map<string, string[]>();
  for (const t of r(9)) {
    if (!tagsBy.has(t.feature_id)) tagsBy.set(t.feature_id, []);
    tagsBy.get(t.feature_id)!.push(t.tag);
  }
  return {
    categories: r(0) as Snapshot['categories'],
    statuses: r(1) as Snapshot['statuses'],
    stages: r(2) as Snapshot['stages'],
    teams: r(3) as Snapshot['teams'],
    links: r(4).map((l) => ({ ...l, last_values: parseJson(l.last_values, null) })) as Snapshot['links'],
    epics: r(5) as Snapshot['epics'],
    features: r(6).map((f) => ({ ...f, estimates: est.get(f.id) ?? {}, tags: tagsBy.get(f.id) ?? [] })) as Snapshot['features'],
    relations: r(7) as Snapshot['relations'],
    departments: r(10) as Snapshot['departments'],
    users: r(11) as Snapshot['users'],
    featureLinks: r(12) as Snapshot['featureLinks'],
    sourceId,
    tombstones: r(13) as Snapshot['tombstones'],
    numberFloors: {
      features: Number(r(14).find((x) => x.key === 'number_floor.features')?.value ?? 0) || 0,
      epics: Number(r(14).find((x) => x.key === 'number_floor.epics')?.value ?? 0) || 0,
    },
  };
}

function itemDto(i: Row) {
  return {
    id: i.id, seq: i.seq, sheet: i.sheet, row_number: i.row_number, entity_type: i.entity_type, external_id: i.external_id, action: i.action,
    target_id: i.target_id, candidates: parseJson(i.candidates, []), payload: parseJson(i.payload, {}), diff: parseJson(i.diff, []),
    errors: parseJson(i.errors, []), warnings: parseJson(i.warnings, []), resolution: parseJson(i.resolution, null),
  };
}

function toDraft(i: Row): ItemDraft {
  const d = itemDto(i);
  return {
    seq: d.seq, sheet: d.sheet, rowNumber: d.row_number, entityType: d.entity_type, externalId: d.external_id, action: d.action,
    targetId: d.target_id, targetVersion: i.target_version, candidates: d.candidates, payload: d.payload, diff: d.diff, errors: d.errors,
    warnings: d.warnings, resolution: d.resolution,
  };
}

async function runDto(ctx: Ctx, runId: string) {
  const run = await first(ctx.env.DB, 'SELECT r.*, u.name AS created_by_name, a.name AS applied_by_name FROM import_runs r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users a ON a.id = r.applied_by WHERE r.id = ?', runId);
  if (!run) throw notFound('Запуск импорта не найден');
  const items = await all(ctx.env.DB, 'SELECT * FROM import_items WHERE run_id = ? ORDER BY seq', runId);
  const drafts = items.map(toDraft);
  return {
    id: run.id, source_id: run.source_id, status: run.status, created_at: run.created_at, created_by: run.created_by_name, applied_at: run.applied_at,
    applied_by: run.applied_by_name, counts: parseJson(run.counts, null), error: run.error, source_hash: run.source_hash, origin: run.origin ?? 'source',
    summary: countItems(drafts),
    links: linkSummary(drafts),
    unresolved: run.status === 'preview' ? unresolvedReasons(drafts) : [],
    items: items.map(itemDto),
  };
}

const resolutionSchema = z.object({
  mode: z.enum(['create', 'update', 'link', 'skip']),
  targetId: z.string().optional(),
  fields: z.record(z.string(), z.enum(['source', 'local'])).optional(),
  protected: z.record(z.string(), z.boolean()).optional(),
  links: z.object({ source: z.array(z.string().max(2000)).max(200).optional(), remove: z.array(z.string().max(2000)).max(200).optional() }).optional(),
});

function validateResolution(item: Row, res: Resolution) {
  const action = item.action as string;
  const allowed: Record<string, string[]> = {
    create: ['create', 'skip'],
    update: ['update', 'skip'],
    unchanged: ['update', 'skip'],
    duplicate: ['create', 'link', 'skip'],
    error: [],
  };
  if (!(allowed[action] ?? []).includes(res.mode)) throw badRequest('Недопустимое решение для этой строки');
  if (item.entity_type === 'relation' && res.mode !== 'create' && res.mode !== 'skip') throw badRequest('Недопустимое решение для связи');
  if (res.mode === 'link' && !res.targetId) throw badRequest('Выберите существующую карточку');
  const diff = parseJson<{ field: string; kind: string }[]>(item.diff, []);
  for (const f of Object.keys(res.fields ?? {})) if (!diff.some((d) => d.field === f && d.kind !== 'protected')) throw badRequest(`Поле ${f} не участвует в изменениях`);
  for (const f of Object.keys(res.protected ?? {})) if (!diff.some((d) => d.field === f && d.kind === 'protected')) throw badRequest(`Поле ${f} не является защищённым`);
  const plan = parseJson<Record<string, any>>(item.payload, {}).link_plan as LinkPlan | undefined;
  for (const u of res.links?.source ?? []) if (!plan?.conflicts.some((c) => c.url === u)) throw badRequest(`Ссылка ${u} не в конфликте`);
  for (const u of res.links?.remove ?? []) if (!plan?.missing.some((m) => m.url === u)) throw badRequest(`Ссылка ${u} не отмечена «нет в источнике»`);
}

const TABLE: Record<string, string> = { epic: 'epics', feature: 'features' };

/** Build every statement of the apply transaction. Pure planning over the current snapshot — no writes here. */
async function buildApply(ctx: Ctx, run: Row, source: Row, drafts: ItemDraft[], itemIds: string[], snap: Snapshot) {
  const db = ctx.env.DB;
  const user = ctx.user!;
  const L = buildLookup(snap);
  const now = nowIso();
  const lc = (s: string) => s.trim().toLowerCase();
  const idFor: Record<string, Map<string, string>> = { epic: new Map(), feature: new Map() };
  const st: D1PreparedStatement[] = [];
  const counts = { created: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, errors: 0, relations_created: 0, relations_skipped: 0, conflicts: [] as { row: string; field: string; choice: string }[] };

  // 0. idempotency: the lock row can be inserted only once per run; the run must still be a preview
  st.push(stmt(db, 'INSERT INTO import_apply_locks (run_id, applied_at) VALUES (?, ?)', run.id, now));
  st.push(abortIf(db, 'run_state', `NOT EXISTS (SELECT 1 FROM import_runs WHERE id = ? AND status = 'preview')`, run.id));

  // 1. decide final ids for every entity row
  let nextFeature = Math.max(snap.numberFloors?.features ?? 0, ...snap.features.map((f) => f.number ?? 0)) + 1;
  let nextEpic = Math.max(snap.numberFloors?.epics ?? 0, ...snap.epics.map((f) => f.number ?? 0)) + 1;
  const entityItems = drafts.filter((d) => d.entityType === 'epic' || d.entityType === 'feature');
  const plan = new Map<number, { mode: string; id: string | null; number?: number }>();
  for (const d of entityItems) {
    const res = d.resolution;
    const ext = lc(d.externalId ?? '');
    if (d.action === 'error') { counts.errors++; continue; }
    if (!res || res.mode === 'skip') { counts.skipped++; continue; }
    if (res.mode === 'create') {
      const id = newId(d.entityType === 'feature' ? 'f' : d.entityType === 'epic' ? 'e' : 'o');
      const number = d.entityType === 'feature' ? nextFeature++ : d.entityType === 'epic' ? nextEpic++ : undefined;
      idFor[d.entityType].set(ext, id);
      plan.set(d.seq, { mode: 'create', id, number });
    } else if (res.mode === 'link') {
      const map = L.entities[d.entityType as 'epic' | 'feature'];
      const target = resolveMerged(map, res.targetId!);
      if (!target) throw badRequest(`${d.sheet}, строка ${d.rowNumber}: выбранная карточка не найдена`);
      idFor[d.entityType].set(ext, target.id);
      plan.set(d.seq, { mode: 'link', id: target.id });
    } else {
      idFor[d.entityType].set(ext, d.targetId!);
      plan.set(d.seq, { mode: d.action === 'unchanged' ? 'unchanged' : 'update', id: d.targetId });
    }
  }
  const resolveExt = (type: 'epic' | 'feature', ext: string | null): string | null => {
    if (!ext) return null;
    const mine = idFor[type].get(lc(ext));
    if (mine) return mine;
    if (type === 'epic') return resolveEpicExt(L, ext)?.id ?? null;
    const link = L.linkOf.get(`${type}|${lc(ext)}`);
    return link ? resolveMerged(L.entities[type], link.entity_id)?.id ?? null : null;
  };
  const defaultStatus = (entity: string) => L.defaultStatus(entity);
  const doneStatuses = new Set(snap.statuses.filter((s) => s.semantic === 'done').map((s) => s.id));
  const linkStmt = (type: string, ext: string, entityId: string, payload: Record<string, any>) =>
    stmt(db, `INSERT INTO source_entity_links (source_id, entity_type, external_id, entity_id, last_values, first_run_id, last_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, entity_type, external_id) DO UPDATE SET entity_id = excluded.entity_id, last_values = excluded.last_values,
        last_run_id = excluded.last_run_id, updated_at = excluded.updated_at`,
      source.id, type, ext, entityId, JSON.stringify(sourceValues(type, payload)), run.id, run.id, now, now);
  const reason = `Импорт: ${source.name}`;
  const newVisibility = configOf(source).newVisibility === 'internal' ? 'internal' : 'draft';
  const today = now.slice(0, 10);
  const linkCounts = { added: 0, updated: 0, removed: 0, kept_missing: 0, conflicts_local: 0, conflicts_source: 0 };
  /**
   * External links of one task row: the plan is recomputed here on fresh data (the preview only shows it).
   * Manual links are never touched; INSERT OR IGNORE protects a URL added by hand between preview and apply.
   */
  const importLinks = (d: ItemDraft, featureId: string, isNew: boolean) => {
    const links = d.payload.links as SourceLink[] | undefined;
    if (!links) return;
    const plan: LinkPlan = isNew ? { ...emptyPlan(), add: links } : linkPlanFor(snap, featureId, links);
    const choice = d.resolution?.links ?? {};
    const changes: Change[] = [];
    const label = (kind: string, url: string) => `${kind}: ${url}`;
    for (const a of plan.add) {
      st.push(stmt(db, `INSERT OR IGNORE INTO feature_links (id, feature_id, kind, url, origin, source_id, source_column, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?)`, newId('lnk'), featureId, a.kind, a.url, source.id, a.column, now, user.id, now, user.id));
      changes.push({ field: 'link', old: null, new: label(a.kind, a.url) });
      linkCounts.added++;
    }
    for (const u of plan.update) {
      st.push(stmt(db, `UPDATE feature_links SET kind = ?, source_column = ?, updated_at = ?, updated_by = ?, version = version + 1
        WHERE id = ? AND origin = 'import' AND locally_edited = 0`, u.to, u.column, now, user.id, u.id));
      changes.push({ field: 'link', old: label(u.from, u.url), new: label(u.to, u.url) });
      linkCounts.updated++;
    }
    for (const c of plan.conflicts) {
      if (!(choice.source ?? []).includes(c.url)) {
        linkCounts.conflicts_local++;
        counts.conflicts.push({ row: `${d.sheet}:${d.rowNumber}`, field: `ссылка ${c.url}`, choice: 'local' });
        continue;
      }
      st.push(stmt(db, `UPDATE feature_links SET kind = ?, source_column = ?, locally_edited = 0, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
        c.source, c.column, now, user.id, c.id));
      changes.push({ field: 'link', old: label(c.local, c.url), new: label(c.source, c.url) });
      counts.conflicts.push({ row: `${d.sheet}:${d.rowNumber}`, field: `ссылка ${c.url}`, choice: 'source' });
      linkCounts.conflicts_source++;
    }
    for (const m of plan.missing) {
      if (!(choice.remove ?? []).includes(m.url)) { linkCounts.kept_missing++; continue; }
      st.push(stmt(db, `DELETE FROM feature_links WHERE id = ? AND origin = 'import' AND source_id = ? AND locally_edited = 0`, m.id, source.id));
      changes.push({ field: 'link', old: label(m.kind, m.url), new: null });
      linkCounts.removed++;
    }
    if (changes.length) st.push(auditStmt(db, user, 'feature', featureId, 'import_links', changes, reason));
  };

  // 2. entity statements in dependency order: epics → features
  for (const type of ['epic', 'feature'] as const) {
    for (const d of entityItems.filter((x) => x.entityType === type)) {
      const p = plan.get(d.seq);
      if (!p || !p.id) continue;
      const pl = d.payload;
      const ext = d.externalId!;
      if (p.mode === 'create') {
        counts.created++;
        const status = pl.status_id ?? defaultStatus(type);
        if (type === 'epic') {
          st.push(stmt(db, `INSERT INTO epics (id, number, external_ref, title, description, category_id, status_id, visibility, created_at, updated_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.id, p.number, ext, pl.title, pl.description ?? '', pl.category_id ?? null, status, newVisibility, now, now, user.id));
        } else {
          const epicId = resolveExt('epic', pl.epic_ext);
          if (pl.epic_ext && !epicId) throw badRequest(`${d.sheet}, строка ${d.rowNumber}: эпик «${pl.epic_ext}» пропущен или не найден — измените решение по эпику`);
          const ini = pl.initiator as { type: string; id: string | null; name: string } | null | undefined;
          st.push(stmt(db, `INSERT INTO features (id, number, external_ref, title, description, category_id, epic_id, status_id, stage_id, requested_at, closed_at,
              assignee_name, planned_end, visibility, created_at, updated_at, created_by, updated_by,
              task_kind, urgency, fact_hours, author_name, initiator_type, initiator_user_id, initiator_department_id, initiator_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            p.id, p.number, pl.derived_id ? null : ext, pl.title, pl.description ?? '', pl.category_id ?? null, epicId, status, pl.stage_id ?? null, pl.requested_at ?? today,
            doneStatuses.has(status) ? pl.closed_at ?? today : null, pl.assignee_name ?? null, pl.planned_end ?? null, newVisibility, now, now, user.id, user.id,
            pl.task_kind ?? 'planned', pl.urgency ?? null, pl.fact_hours ?? null, pl.author_name ?? null,
            ini?.type ?? null, ini?.type === 'user' ? ini.id : null, ini?.type === 'department' ? ini.id : null, ini?.name ?? null));
          for (const tag of pl.tags ?? []) st.push(stmt(db, 'INSERT OR IGNORE INTO feature_tags (feature_id, tag) VALUES (?, ?)', p.id, tag));
          for (const [teamId, h] of Object.entries(pl.estimates ?? {})) {
            st.push(stmt(db, 'INSERT INTO feature_estimates (feature_id, team_id, hours, is_manual, updated_at, updated_by) VALUES (?, ?, ?, 0, ?, ?)', p.id, teamId, h, now, user.id));
          }
        }
        st.push(linkStmt(type, ext, p.id, pl));
        // a row deleted for good comes back only by this conscious choice: the tombstone goes away with it
        if (pl.tombstone) st.push(stmt(db, 'DELETE FROM import_tombstones WHERE source_id = ? AND entity_type = ? AND lower(external_id) = lower(?)', source.id, type, ext));
        st.push(auditStmt(db, user, type, p.id, 'import_created', [{ field: 'source', old: null, new: `${d.sheet}:${d.rowNumber}` }, ...(pl.tombstone ? [{ field: 'restored_after_delete', old: pl.tombstone.key, new: null }] : [])], reason));
        if (type === 'feature') importLinks(d, p.id, true);
        continue;
      }
      if (p.mode === 'link') {
        counts.linked++;
        // attach the source to an existing card without overwriting anything
        st.push(linkStmt(type, ext, p.id, pl));
        st.push(auditStmt(db, user, type, p.id, 'import_linked', [{ field: 'source', old: null, new: `${d.sheet}:${d.rowNumber} (${ext})` }], reason));
        if (type === 'feature') importLinks(d, p.id, false);
        continue;
      }
      if (p.mode === 'unchanged') {
        counts.unchanged++;
        st.push(linkStmt(type, ext, p.id, pl));
        if (type === 'feature') importLinks(d, p.id, false);
        continue;
      }
      // update: only the fields that the preview showed and the user accepted
      const res = d.resolution!;
      const cols: Record<string, unknown> = {};
      const changes: Change[] = [];
      const estimateWrites: [string, number][] = [];
      let tagsWrite: string[] | null = null;
      for (const df of d.diff) {
        const choice = df.kind === 'protected' ? (res.protected?.[df.field] ? 'source' : 'local') : res.fields?.[df.field] ?? (df.kind === 'update' ? 'source' : undefined);
        if (df.kind === 'conflict') counts.conflicts.push({ row: `${d.sheet}:${d.rowNumber}`, field: df.field, choice: choice ?? 'local' });
        if (choice !== 'source') continue;
        if (df.field.startsWith('hours:')) {
          estimateWrites.push([df.field.slice(6), Number(df.source)]);
        } else if (df.field === 'tags') {
          tagsWrite = String(df.source ?? '').split(',').map((t) => t.trim()).filter(Boolean);
        } else if (df.field === 'epic') {
          const epicId = resolveExt('epic', df.source as string | null);
          if (df.source && !epicId) throw badRequest(`${d.sheet}, строка ${d.rowNumber}: эпик «${df.source}» не найден`);
          cols.epic_id = epicId;
        } else {
          cols[df.field] = df.source;
          if (df.field === 'status_id' && type === 'feature') cols.closed_at = doneStatuses.has(df.source as string) ? pl.closed_at ?? today : null;
        }
        changes.push({ field: df.field, old: df.local, new: df.source });
      }
      if (!changes.length) {
        counts.unchanged++;
        st.push(linkStmt(type, ext, p.id, pl));
        if (type === 'feature') importLinks(d, p.id, false);
        continue;
      }
      counts.updated++;
      // optimistic locking: the card must be exactly the version shown in the preview
      st.push(guardVersion(db, TABLE[type], p.id, d.targetVersion!));
      const keys = Object.keys(cols);
      st.push(stmt(db, `UPDATE ${TABLE[type]} SET ${[...keys.map((k) => `${k} = ?`), 'updated_at = ?', 'version = version + 1'].join(', ')} WHERE id = ?`,
        ...keys.map((k) => cols[k]), now, p.id));
      if (tagsWrite) {
        st.push(stmt(db, 'DELETE FROM feature_tags WHERE feature_id = ?', p.id));
        for (const tag of tagsWrite) st.push(stmt(db, 'INSERT OR IGNORE INTO feature_tags (feature_id, tag) VALUES (?, ?)', p.id, tag));
      }
      for (const [teamId, h] of estimateWrites) {
        st.push(stmt(db, `INSERT INTO feature_estimates (feature_id, team_id, hours, is_manual, updated_at, updated_by) VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(feature_id, team_id) DO UPDATE SET hours = excluded.hours, is_manual = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = version + 1`,
          p.id, teamId, h, now, user.id));
      }
      st.push(linkStmt(type, ext, p.id, pl));
      st.push(auditStmt(db, user, type, p.id, 'import_updated', changes, reason));
      if (type === 'feature') importLinks(d, p.id, false);
    }
  }

  // 3. relations
  const blockEdges: Edge[] = snap.relations.filter((r) => r.type === 'blocks').map((r) => [r.from_id, r.to_id]);
  const keyToId = (key: string): string | null => {
    if (!key.startsWith('ext:')) return key;
    const [, type, ...rest] = key.split(':');
    return idFor[type]?.get(rest.join(':')) ?? null;
  };
  for (const d of drafts.filter((x) => x.entityType === 'relation')) {
    if (d.action === 'error') { counts.errors++; continue; }
    if (d.action !== 'create' || d.resolution?.mode !== 'create') { if (d.action === 'create') counts.relations_skipped++; continue; }
    const from = keyToId(d.payload.from_key);
    const to = keyToId(d.payload.to_key);
    if (!from || !to || from === to) { counts.relations_skipped++; continue; }
    const t = d.payload.relation_type as string;
    if (t === 'belongs_to_epic') {
      st.push(stmt(db, 'UPDATE features SET epic_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND (epic_id IS NULL OR epic_id <> ?)', to, now, from, to));
    } else {
      if (t === 'blocks') {
        if (findCycle([...blockEdges, [from, to]])) throw badRequest(`${d.sheet}, строка ${d.rowNumber}: с учётом выбранных решений связь создаёт циклическую зависимость`);
        blockEdges.push([from, to]);
      }
      st.push(stmt(db, `INSERT OR IGNORE INTO feature_relations (id, type, from_id, to_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`, newId('rel'), t, from, to, now, user.id));
    }
    st.push(auditStmt(db, user, 'relation', from, 'import_relation', [{ field: t, old: null, new: to }], reason));
    counts.relations_created++;
  }

  // 4. journal
  st.push(stmt(db, `UPDATE import_runs SET status = 'applied', applied_at = ?, applied_by = ?, counts = ? WHERE id = ?`, now, user.id, JSON.stringify(counts), run.id));
  st.push(stmt(db, 'UPDATE sheet_sources SET updated_at = ? WHERE id = ?', now, source.id));
  st.push(auditStmt(db, user, 'import', run.id, 'applied', [{ field: 'counts', old: null, new: { ...counts, conflicts: counts.conflicts.length } }], reason));
  return { statements: st, counts: { ...counts, links: linkCounts }, itemIds };
}

export function registerImportRoutes(r: Router) {
  r.get('/api/import/sources', async (ctx) => {
    requirePerm(ctx, perms.import);
    const sources = await all(ctx.env.DB, 'SELECT * FROM sheet_sources ORDER BY created_at');
    const out = [];
    for (const s of sources) {
      const last = await first(ctx.env.DB, 'SELECT * FROM import_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1', s.id);
      out.push(sourceDto(s, last));
    }
    const sa = serviceAccount(ctx.env);
    return json({
      sources: out, service_account_email: sa?.client_email ?? null, columns: SHEET_COLUMNS,
      default_config: { ...DEFAULT_IMPORT_CONFIG, format: 'template', newVisibility: 'draft' },
      flat_preset: { ...DEFAULT_IMPORT_CONFIG, format: 'flat', flat: TASKFLOW_CONFIG, newVisibility: 'internal' },
      // «Прием обращений по багам/доработкам»: one source per tab (different work types)
      bug_presets: [
        { name: 'Баги (прием обращений)', spreadsheet_id: BUGS_SPREADSHEET_ID, config: { ...DEFAULT_IMPORT_CONFIG, format: 'flat', flat: BUGS_CONFIG, newVisibility: 'internal' } },
        { name: 'Доработки (прием обращений)', spreadsheet_id: BUGS_SPREADSHEET_ID, config: { ...DEFAULT_IMPORT_CONFIG, format: 'flat', flat: IMPROVEMENTS_CONFIG, newVisibility: 'internal' } },
      ],
    });
  });

  r.post('/api/import/sources', async (ctx) => {
    const user = requirePerm(ctx, perms.import);
    const b = await readJson(ctx, z.object({
      name: z.string().trim().min(1).max(120),
      kind: z.enum(['google', 'csv']),
      spreadsheet: z.string().trim().max(500).optional(),
      config: configSchema.optional(),
      demo: z.boolean().optional(),
    }));
    let spreadsheetId: string | null = null;
    if (b.kind === 'google') {
      spreadsheetId = parseSpreadsheetId(b.spreadsheet ?? '');
      if (!spreadsheetId) throw badRequest('Укажите ссылку на Google-таблицу или её ID');
    }
    const id = newId('src');
    const now = nowIso();
    const db = ctx.env.DB;
    const csv = b.kind === 'csv' && b.demo ? JSON.stringify(DEMO_SHEETS) : b.kind === 'csv' ? '{}' : null;
    await tx(db, [
      stmt(db, 'INSERT INTO sheet_sources (id, name, kind, spreadsheet_id, config, csv_data, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, b.name, b.kind, spreadsheetId, JSON.stringify(b.config ?? DEFAULT_IMPORT_CONFIG), csv, now, user.id, now),
      auditStmt(db, user, 'import_source', id, 'created', [{ field: 'name', old: null, new: b.name }]),
    ]);
    return json({ id }, 201);
  });

  r.patch('/api/import/sources/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.import);
    const b = await readJson(ctx, z.object({
      name: z.string().trim().min(1).max(120).optional(),
      spreadsheet: z.string().trim().max(500).optional(),
      config: configSchema.optional(),
      is_active: z.boolean().optional(),
      version: z.number().int(),
    }));
    const s = await getSource(ctx, ctx.params.id);
    const patch: Row = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.spreadsheet !== undefined) {
      const sid = parseSpreadsheetId(b.spreadsheet);
      if (!sid) throw badRequest('Укажите ссылку на Google-таблицу или её ID');
      patch.spreadsheet_id = sid;
    }
    if (b.config) patch.config = JSON.stringify(b.config);
    if (b.is_active !== undefined) patch.is_active = b.is_active ? 1 : 0;
    const keys = Object.keys(patch).filter((k) => patch[k] !== s[k]);
    if (!keys.length) return json({ ok: true, unchanged: true });
    const db = ctx.env.DB;
    await tx(db, [
      guardVersion(db, 'sheet_sources', s.id, b.version),
      stmt(db, `UPDATE sheet_sources SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...keys.map((k) => patch[k]), nowIso(), s.id),
      auditStmt(db, user, 'import_source', s.id, 'updated', keys.map((k) => ({ field: k, old: k === 'config' ? '…' : s[k], new: k === 'config' ? '…' : patch[k] }))),
    ]);
    return json({ ok: true });
  });

  r.put('/api/import/sources/:id/csv', async (ctx) => {
    const user = requirePerm(ctx, perms.import);
    const b = await readJson(ctx, z.object({
      sheets: z.object({ epics: z.string().max(1_000_000).optional(), features: z.string().max(1_000_000).optional(), relations: z.string().max(1_000_000).optional(), flat: z.string().max(1_000_000).optional() }),
      version: z.number().int(),
    }));
    const s = await getSource(ctx, ctx.params.id);
    if (s.kind !== 'csv') throw badRequest('Источник не является CSV');
    const cur = parseJson<Record<string, string>>(s.csv_data, {});
    for (const [k, v] of Object.entries(b.sheets)) {
      if (v === undefined) continue;
      if (v.trim() === '') delete cur[k];
      else cur[k] = v;
    }
    const db = ctx.env.DB;
    await tx(db, [
      guardVersion(db, 'sheet_sources', s.id, b.version),
      stmt(db, 'UPDATE sheet_sources SET csv_data = ?, updated_at = ?, version = version + 1 WHERE id = ?', JSON.stringify(cur), nowIso(), s.id),
      auditStmt(db, user, 'import_source', s.id, 'csv_uploaded', Object.keys(b.sheets).map((k) => ({ field: k, old: null, new: 'csv' }))),
    ]);
    return json({ ok: true });
  });

  r.post('/api/import/sources/:id/check', async (ctx) => {
    requirePerm(ctx, perms.import);
    const s = await getSource(ctx, ctx.params.id);
    const config = configOf(s);
    let ok = false;
    let message = '';
    const sheets: { key: string; name: string; found: boolean; rows: number; missing_columns: string[] }[] = [];
    try {
      const { data, notes, title } = await readSource(ctx, s);
      for (const w of sourceSheetNames(config)) {
        const rows = data[w.key];
        const header = (rows?.[0] ?? []).map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase());
        let required: string[];
        if (w.key === 'flat') {
          const c = config.flat!.columns;
          required = [c.title, c.id, c.description, c.category, c.assignee, c.closed_at, c.done, c.priority, c.fact_hours, ...(c.deadline ?? []),
            c.status, c.urgency, c.requested_at, c.initiator, c.author, ...(c.extra ?? []),
            ...Object.keys(config.flat!.flags ?? {}), ...Object.keys(config.flat!.hours ?? {})].filter((x): x is string => !!x);
        } else required = SHEET_COLUMNS[w.key].required;
        const dataRows = rows ? rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim())).length : 0;
        sheets.push({ key: w.key, name: w.name, found: !!rows, rows: dataRows, missing_columns: rows ? [...new Set(required.filter((c) => !header.includes(c.replace(/\s+/g, ' ').trim().toLowerCase())))] : [] });
      }
      const titleMissing = config.format === 'flat' && sheets[0]?.missing_columns.includes(config.flat!.columns.title);
      ok = sheets.some((x) => x.found) && !titleMissing && (config.format === 'flat' || sheets.every((x) => !x.found || x.missing_columns.length === 0));
      message = [title ? `Таблица «${title}»` : 'Источник прочитан', ...notes].join('. ');
    } catch (e) {
      message = e instanceof HttpError ? e.message : 'Не удалось прочитать источник';
    }
    await runSql(ctx.env.DB, 'UPDATE sheet_sources SET last_checked_at = ?, last_check_ok = ?, last_check_msg = ? WHERE id = ?', nowIso(), ok ? 1 : 0, message, s.id);
    return json({ ok, message, sheets });
  });

  /**
   * Preview. Body (optional): `{ files: { <sheet key | 'flat'>: csvText } }` — a CSV export uploaded by the user
   * instead of reading Google (works without a service account; the run is marked origin = 'file').
   */
  r.post('/api/import/sources/:id/preview', async (ctx) => {
    const user = requirePerm(ctx, perms.import);
    const s = await getSource(ctx, ctx.params.id);
    if (!bool(s.is_active)) throw badRequest('Источник отключён');
    let files: Record<string, string> | undefined;
    if ((ctx.req.headers.get('content-type') || '').includes('application/json')) {
      const b = await readJson(ctx, z.object({ files: z.record(z.string().max(40), z.string().max(1_500_000)).optional() }));
      if (b.files && Object.keys(b.files).length) files = b.files;
    }
    const { data, hash, notes, hyperlinks } = await readSource(ctx, s, files);
    const config = configOf(s);
    const snap = await loadSnapshot(ctx.env.DB, s.id);
    const items = buildPreview(data, config, snap, { hyperlinks });
    if (items.length > 3000) throw badRequest('Слишком много строк для одного импорта (максимум 3000)');
    const db = ctx.env.DB;
    const runId = newId('run');
    const now = nowIso();
    const st = [
      // previous unfinished previews of this source become stale
      stmt(db, `UPDATE import_runs SET status = 'discarded' WHERE source_id = ? AND status = 'preview'`, s.id),
      stmt(db, 'INSERT INTO import_runs (id, source_id, status, source_hash, created_at, created_by, counts, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        runId, s.id, 'preview', hash, now, user.id, JSON.stringify({ notes }), files ? 'file' : 'source'),
    ];
    for (const it of items) {
      st.push(stmt(db, `INSERT INTO import_items (id, run_id, seq, sheet, row_number, entity_type, external_id, action, target_id, target_version, candidates, payload, diff, errors, warnings, resolution)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('it'), runId, it.seq, it.sheet, it.rowNumber, it.entityType, it.externalId, it.action, it.targetId, it.targetVersion,
        JSON.stringify(it.candidates), JSON.stringify(it.payload), JSON.stringify(it.diff), JSON.stringify(it.errors), JSON.stringify(it.warnings),
        it.resolution ? JSON.stringify(it.resolution) : null));
    }
    // preview writes only its own journal rows — never any catalog entity
    await tx(db, st);
    return json({ run: await runDto(ctx, runId) }, 201);
  });

  r.get('/api/import/runs', async (ctx) => {
    requirePerm(ctx, perms.import);
    const sid = ctx.url.searchParams.get('source_id');
    const rows = await all(ctx.env.DB,
      `SELECT r.id, r.source_id, r.status, r.created_at, r.applied_at, r.counts, r.error, s.name AS source_name, u.name AS created_by, a.name AS applied_by
       FROM import_runs r JOIN sheet_sources s ON s.id = r.source_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users a ON a.id = r.applied_by
       ${sid ? 'WHERE r.source_id = ?' : ''} ORDER BY r.created_at DESC LIMIT 100`, ...(sid ? [sid] : []));
    return json({ runs: rows.map((x) => ({ ...x, counts: parseJson(x.counts, null) })) });
  });

  r.get('/api/import/runs/:id', async (ctx) => {
    requirePerm(ctx, perms.import);
    return json({ run: await runDto(ctx, ctx.params.id) });
  });

  r.patch('/api/import/runs/:id/items/:itemId', async (ctx) => {
    requirePerm(ctx, perms.import);
    const b = await readJson(ctx, z.object({ resolution: resolutionSchema }));
    const db = ctx.env.DB;
    const item = await first(db, 'SELECT i.*, r.status AS run_status FROM import_items i JOIN import_runs r ON r.id = i.run_id WHERE i.id = ? AND i.run_id = ?', ctx.params.itemId, ctx.params.id);
    if (!item) throw notFound('Строка импорта не найдена');
    if (item.run_status !== 'preview') throw conflict('not_preview', 'Импорт уже применён или отменён');
    validateResolution(item, b.resolution as Resolution);
    await runSql(db, 'UPDATE import_items SET resolution = ? WHERE id = ?', JSON.stringify(b.resolution), item.id);
    return json({ ok: true });
  });

  r.post('/api/import/runs/:id/bulk', async (ctx) => {
    requirePerm(ctx, perms.import);
    const b = await readJson(ctx, z.object({ action: z.enum(['skip_duplicates', 'create_duplicates', 'link_exact_duplicates', 'keep_local_conflicts', 'take_source_conflicts']) }));
    const db = ctx.env.DB;
    const run = await first(db, 'SELECT * FROM import_runs WHERE id = ?', ctx.params.id);
    if (!run) throw notFound();
    if (run.status !== 'preview') throw conflict('not_preview', 'Импорт уже применён или отменён');
    const items = await all(db, 'SELECT * FROM import_items WHERE run_id = ?', run.id);
    const st = [];
    for (const it of items) {
      const res = parseJson<Resolution | null>(it.resolution, null);
      if (it.action === 'duplicate' && !res && (b.action === 'skip_duplicates' || b.action === 'create_duplicates')) {
        st.push(stmt(db, 'UPDATE import_items SET resolution = ? WHERE id = ?', JSON.stringify({ mode: b.action === 'skip_duplicates' ? 'skip' : 'create' }), it.id));
      }
      if (it.action === 'duplicate' && !res && b.action === 'link_exact_duplicates') {
        // only an unambiguous exact-title match is linked automatically; similar titles stay for a human decision
        const exact = parseJson<{ id: string; score: number }[]>(it.candidates, []).filter((c) => c.score >= 1);
        if (exact.length === 1) st.push(stmt(db, 'UPDATE import_items SET resolution = ? WHERE id = ?', JSON.stringify({ mode: 'link', targetId: exact[0].id }), it.id));
      }
      if (it.action === 'update' && res?.mode === 'update' && (b.action === 'keep_local_conflicts' || b.action === 'take_source_conflicts')) {
        const fields = { ...(res.fields ?? {}) };
        let changed = false;
        for (const d of parseJson<{ field: string; kind: string }[]>(it.diff, [])) {
          if (d.kind === 'conflict' && !fields[d.field]) { fields[d.field] = b.action === 'keep_local_conflicts' ? 'local' : 'source'; changed = true; }
        }
        if (changed) st.push(stmt(db, 'UPDATE import_items SET resolution = ? WHERE id = ?', JSON.stringify({ ...res, fields }), it.id));
      }
    }
    if (st.length) await tx(db, st);
    return json({ ok: true, changed: st.length });
  });

  r.post('/api/import/runs/:id/discard', async (ctx) => {
    const user = requirePerm(ctx, perms.import);
    const db = ctx.env.DB;
    await tx(db, [
      stmt(db, `UPDATE import_runs SET status = 'discarded' WHERE id = ? AND status = 'preview'`, ctx.params.id),
      auditStmt(db, user, 'import', ctx.params.id, 'discarded'),
    ]);
    return json({ ok: true });
  });

  /** Atomic, idempotent apply. Either every accepted change is written, or nothing is. */
  r.post('/api/import/runs/:id/apply', async (ctx) => {
    requirePerm(ctx, perms.import);
    const db = ctx.env.DB;
    const run = await first(db, 'SELECT * FROM import_runs WHERE id = ?', ctx.params.id);
    if (!run) throw notFound('Запуск импорта не найден');
    if (run.status === 'applied') throw conflict('already_applied', 'Этот импорт уже применён — повторное применение не выполняется');
    if (run.status !== 'preview') throw conflict('not_preview', run.status === 'stale' ? 'Источник изменился после предпросмотра — сформируйте предпросмотр заново' : 'Этот предпросмотр отменён');
    const source = await getSource(ctx, run.source_id);
    const items = await all(db, 'SELECT * FROM import_items WHERE run_id = ? ORDER BY seq', run.id);
    const drafts = items.map(toDraft);
    const unresolved = unresolvedReasons(drafts);
    if (unresolved.length) throw badRequest('Не все спорные строки разобраны', { unresolved });

    // the source must be exactly what the user reviewed (an uploaded export IS the reviewed data)
    const fresh = run.origin === 'file' ? { hash: run.source_hash } : await readSource(ctx, source);
    if (fresh.hash !== run.source_hash) {
      await runSql(db, `UPDATE import_runs SET status = 'stale', error = ? WHERE id = ? AND status = 'preview'`, 'Источник изменился после предпросмотра', run.id);
      throw conflict('stale', 'Таблица изменилась после предпросмотра. Сформируйте предпросмотр заново — устаревшие изменения не применены.');
    }
    const snap = await loadSnapshot(db, source.id);
    const { statements, counts } = await buildApply(ctx, run, source, drafts, items.map((i) => i.id), snap);
    try {
      await db.batch(statements);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const again = await first(db, 'SELECT status FROM import_runs WHERE id = ?', run.id);
      if (again?.status === 'applied' || /import_apply_locks/i.test(msg)) throw conflict('already_applied', 'Этот импорт уже применён — повторное применение не выполняется');
      if (/CHECK constraint failed/i.test(msg)) {
        throw conflict('changed', 'Карточки изменились после предпросмотра (их отредактировали вручную). Сформируйте предпросмотр заново — ничего не записано.');
      }
      await runSql(db, `UPDATE import_runs SET status = 'failed', error = ? WHERE id = ? AND status = 'preview'`, msg.slice(0, 500), run.id);
      throw new HttpError(500, 'import_failed', 'Ошибка записи: импорт отменён целиком, данные не изменены.');
    }
    return json({ ok: true, counts });
  });

  // ───── templates (header + example rows) ─────
  r.get('/api/import/template/:sheet', async (ctx) => {
    const key = ctx.params.sheet.replace(/\.csv$/, '') as SheetKey;
    if (!SHEET_KEYS.includes(key)) throw notFound();
    const csv = DEMO_SHEETS[key];
    return new Response('﻿' + csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${key}.csv"`, 'cache-control': 'no-store' },
    });
  });
}

export { toCsv };

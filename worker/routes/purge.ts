// Permanent deletion by an administrator (vNext ТЗ §5; owner decision 13.10 №14: the history of a deleted record is
// wiped, no copies are kept, one audit record of the fact stays).
//   GET  /api/admin/purge/:kind/:ref  — preview of the consequences (kind: feature | epic | proposal; ref: id or key)
//   POST /api/admin/purge/:kind/:ref  {confirm: '<key>', version, reason?} — the deletion itself, one transaction
// Only an administrator in a browser session (never an API key). One record at a time — no bulk deletion.
// Imported records leave a tombstone per source, so the next sync does not silently create them again (importer.ts).
// Numbers are never reused (lib/numbers.ts). Hiding instead of deleting stays the ordinary way: status «Отменена»,
// visibility «Черновик», proposal «Отклонено».
import { z } from 'zod';
import type { D1Database, D1PreparedStatement } from '../env';
import { PROPOSAL_STATUS_LABEL, proposalKey } from '../domain/proposals';
import { auditStmt } from '../lib/audit';
import { perms, requirePerm, type SessionUser } from '../lib/auth';
import { abortIf, all, first, guardVersion, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Router } from '../lib/http';
import { raiseFloorStmt, type Numbered } from '../lib/numbers';
import { isProductInternal } from '../lib/world';

type Kind = 'feature' | 'epic' | 'proposal';
const KIND: Record<Kind, { table: Numbered; prefix: string; label: string }> = {
  feature: { table: 'features', prefix: 'RF', label: 'Задача' },
  epic: { table: 'epics', prefix: 'EP', label: 'Эпик' },
  proposal: { table: 'proposals', prefix: 'P', label: 'Предложение' },
};
const keyOf = (kind: Kind, n: number) => (kind === 'proposal' ? proposalKey(n) : `${KIND[kind].prefix}-${n}`);

export interface Effect { label: string; count: number; items?: string[]; note?: string }
interface Plan {
  kind: Kind; record: Row; key: string; title: string;
  ids: string[]; numbers: number[]; dupKeys: string[];
  effects: Effect[]; warnings: string[];
  statements: (user: SessionUser, reason: string | null) => D1PreparedStatement[];
}

const ph = (xs: unknown[]) => xs.map(() => '?').join(', ');
const hours = (n: number) => `${Math.round(n * 10) / 10} ч`;

async function findRecord(db: D1Database, kind: Kind, ref: string): Promise<Row> {
  const m = new RegExp(`^(?:${KIND[kind].prefix}-)?(\\d+)$`, 'i').exec(ref.trim());
  const rec = m ? await first(db, `SELECT * FROM ${KIND[kind].table} WHERE number = ?`, Number(m[1])) : await first(db, `SELECT * FROM ${KIND[kind].table} WHERE id = ?`, ref);
  if (!rec) throw notFound(`${KIND[kind].label} не найдена`);
  return rec;
}

/** the record plus everything merged into it (merged duplicates are shells of the same record) */
async function withMerged(db: D1Database, table: 'features' | 'proposals', rec: Row): Promise<Row[]> {
  const out = [rec];
  let frontier = [rec.id];
  while (frontier.length) {
    const rows = (await all(db, `SELECT id, number, title FROM ${table} WHERE merged_into_id IN (${ph(frontier)})`, ...frontier)).filter((r) => !out.some((o) => o.id === r.id));
    out.push(...rows);
    frontier = rows.map((r) => r.id);
  }
  return out;
}

/** imported links of the records → tombstones, so the source does not bring them back */
async function importLinks(db: D1Database, type: 'feature' | 'epic', ids: string[]) {
  return all(db, `SELECT l.source_id, l.external_id, l.entity_id, s.name FROM source_entity_links l JOIN sheet_sources s ON s.id = l.source_id
    WHERE l.entity_type = ? AND l.entity_id IN (${ph(ids)})`, type, ...ids);
}

function importStatements(db: D1Database, type: 'feature' | 'epic', ids: string[], links: Row[], keyById: Map<string, string>, user: SessionUser, now: string) {
  return [
    ...links.map((l) => stmt(db, `INSERT INTO import_tombstones (source_id, entity_type, external_id, entity_key, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id, entity_type, external_id) DO UPDATE SET entity_key = excluded.entity_key, deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by`,
      l.source_id, type, l.external_id, keyById.get(l.entity_id) ?? '', now, user.id)),
    stmt(db, `DELETE FROM source_entity_links WHERE entity_type = ? AND entity_id IN (${ph(ids)})`, type, ...ids),
    // previews of earlier syncs hold copies of the row: wiped with the record
    stmt(db, `DELETE FROM import_items WHERE entity_type = ? AND target_id IN (${ph(ids)})`, type, ...ids),
  ];
}

function importEffects(links: Row[], items: number): Effect[] {
  const out: Effect[] = [];
  if (links.length) {
    out.push({
      label: 'Импорт из таблиц', count: links.length,
      items: links.map((l) => `${l.name}: строка с ID «${l.external_id}»`),
      note: 'Повторная синхронизация не создаст запись снова: строка будет пропущена с пометкой «удалена администратором». Вернуть её можно осознанно — «Восстановить импорт» в предпросмотре.',
    });
  }
  if (items) out.push({ label: 'Строки предпросмотров импорта', count: items, note: 'Копии строки в истории синхронизаций удаляются.' });
  return out;
}

const auditEffect = (n: number): Effect => ({ label: 'История изменений', count: n, note: 'Стирается полностью, копии не сохраняются. Останется одна запись журнала о факте удаления (ID, название, кто и когда удалил, причина).' });
const FEATURE_AUDIT_TYPES = "('feature', 'vote', 'estimate', 'placement', 'relation', 'comment')";
// Child mutations (for example comments and votes) do not bump the parent version.
// The monotonic audit sequence binds confirmation to the complete preview, and the
// transaction guard catches changes made while the deletion plan is being read.
const REVISION_SQL = "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'), 0)";
const STALE = 'Данные изменились после предпросмотра. Откройте предпросмотр заново.';
async function revision(db: D1Database): Promise<number> {
  return Number((await first(db, `SELECT ${REVISION_SQL} AS revision`))!.revision);
}

async function featurePlan(db: D1Database, rec: Row): Promise<Plan> {
  const recs = await withMerged(db, 'features', rec);
  const ids = recs.map((r) => r.id);
  const IN = ph(ids);
  const key = keyOf('feature', rec.number);
  const keyById = new Map(recs.map((r) => [r.id, keyOf('feature', r.number)]));
  const q = (sql: string, ...v: unknown[]) => stmt(db, sql, ...v);
  const res = await db.batch([
    q(`SELECT COUNT(*) AS n FROM comments WHERE feature_id IN (${IN})`, ...ids),
    q(`SELECT t.name, e.hours FROM feature_estimates e JOIN resource_teams t ON t.id = e.team_id WHERE e.feature_id IN (${IN})`, ...ids),
    q(`SELECT d.name, v.score FROM department_votes v JOIN departments d ON d.id = v.department_id WHERE v.feature_id IN (${IN})`, ...ids),
    q(`SELECT DISTINCT tag FROM feature_tags WHERE feature_id IN (${IN})`, ...ids),
    q(`SELECT r.type, r.from_id, r.to_id, a.number AS an, b.number AS bn FROM feature_relations r JOIN features a ON a.id = r.from_id JOIN features b ON b.id = r.to_id
       WHERE r.from_id IN (${IN}) OR r.to_id IN (${IN})`, ...ids, ...ids),
    q(`SELECT COUNT(*) AS n FROM feature_blockers WHERE feature_id IN (${IN})`, ...ids),
    q(`SELECT COUNT(*) AS n FROM feature_links WHERE feature_id IN (${IN})`, ...ids),
    q(`SELECT r.name, r.approved_at FROM release_features rf JOIN releases r ON r.id = rf.release_id WHERE rf.feature_id IN (${IN})`, ...ids),
    q('SELECT code FROM sprints WHERE id = ?', rec.sprint_id ?? ''),
    q('SELECT number, title FROM epics WHERE id = ?', rec.epic_id ?? ''),
    q(`SELECT DISTINCT p.number, p.title, p.status FROM proposal_features pf JOIN proposals p ON p.id = pf.proposal_id WHERE pf.feature_id IN (${IN})`, ...ids),
    q(`SELECT (SELECT COUNT(*) FROM feature_plan_baselines WHERE feature_id IN (${IN})) AS b, (SELECT COUNT(*) FROM feature_phase_events WHERE feature_id IN (${IN})) AS e,
       (SELECT COUNT(*) FROM feature_phase_forecasts WHERE feature_id IN (${IN})) AS f`, ...ids, ...ids, ...ids),
    q(`SELECT COUNT(*) AS n FROM import_items WHERE entity_type = 'feature' AND target_id IN (${IN})`, ...ids),
    q(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type IN ${FEATURE_AUDIT_TYPES} AND entity_id IN (${IN})`, ...ids),
    q('SELECT ms.month_id, ms.data, m.month FROM month_snapshots ms JOIN accounting_months m ON m.id = ms.month_id'),
  ]);
  const r = (i: number) => (res[i].results ?? []) as Row[];
  const n = (i: number) => Number(r(i)[0]?.n ?? 0);
  const links = await importLinks(db, 'feature', ids);
  const snaps = r(14).filter((s) => (parseJson<Row>(s.data, {}).tasks ?? []).some((t: Row) => ids.includes(t.id)));
  const release = r(7)[0];
  const effects: Effect[] = [];
  const add = (e: Effect) => { if (e.count > 0) effects.push(e); };
  add({ label: 'Объединённые дубли', count: recs.length - 1, items: recs.slice(1).map((x) => `${keyOf('feature', x.number)} ${x.title}`), note: 'Удаляются вместе с задачей.' });
  add({ label: 'Комментарии', count: n(0) });
  add({ label: 'Оценки часов', count: r(1).length, items: r(1).map((e) => `${e.name}: ${hours(Number(e.hours))}`), note: 'Загрузка команд и прогноз бюджета пересчитаются без них.' });
  add({ label: 'Голоса отделов', count: r(2).length, items: r(2).map((v) => `${v.name}: ${v.score}`), note: 'Задача уйдёт из рейтинга приоритетов, места остальных задач сдвинутся.' });
  add({ label: 'Теги', count: r(3).length, items: r(3).map((t) => t.tag) });
  add({
    label: 'Связи с задачами', count: r(4).length,
    items: r(4).map((x) => (ids.includes(x.from_id) ? `${x.type === 'blocks' ? 'блокирует' : 'связана с'} RF-${x.bn}` : `${x.type === 'blocks' ? 'блокируется' : 'связана с'} RF-${x.an}`)),
    note: 'Связи удаляются; задачи, которые ждали эту, перестанут считаться заблокированными ею.',
  });
  add({ label: 'Блокировки (ожидания)', count: n(5) });
  add({ label: 'Внешние ссылки', count: n(6) });
  if (release) add({ label: 'Релиз', count: 1, items: [`${release.name}${release.approved_at ? ' (утверждён)' : ''}`], note: 'Состав релиза и его готовность изменятся.' });
  if (r(8)[0]) add({ label: 'Спринт', count: 1, items: [`Спринт ${r(8)[0].code}`] });
  if (r(9)[0]) add({ label: 'Эпик', count: 1, items: [`EP-${r(9)[0].number} ${r(9)[0].title}`], note: 'Прогресс эпика пересчитается.' });
  add({
    label: 'Предложения', count: r(10).length,
    items: r(10).map((p) => `${proposalKey(p.number)} ${p.title} — ${PROPOSAL_STATUS_LABEL[p.status as keyof typeof PROPOSAL_STATUS_LABEL] ?? p.status}`),
    note: 'Связь удаляется, само предложение и его статус не меняются.',
  });
  const ph3 = r(11)[0] ?? {};
  add({ label: 'Этапы: исходный план, факты, прогнозы', count: Number(ph3.b ?? 0) + Number(ph3.e ?? 0) + Number(ph3.f ?? 0) });
  effects.push(...importEffects(links, n(12)));
  add({ label: 'Закрытые месяцы бюджета', count: snaps.length, items: snaps.map((s) => s.month), note: 'Зафиксированные суммы не меняются; название задачи в них заменяется на «Удалённая задача».' });
  effects.push(auditEffect(n(13)));
  effects.push({ label: 'Аналитика', count: 0, note: 'Задача пропадёт из аналитики: сроки, просрочки, переносы и выполнение плана пересчитаются без неё.' });

  const warnings: string[] = [];
  if (release?.approved_at) warnings.push(`Задача входит в утверждённый ${release.name}: состав утверждённого плана изменится.`);
  if (isProductInternal(rec)) warnings.push('Это скрытая задача продукта.');
  return {
    kind: 'feature', record: rec, key, title: rec.title, ids, numbers: recs.map((x) => x.number), dupKeys: recs.slice(1).map((x) => keyOf('feature', x.number)),
    effects, warnings,
    statements: (user, reason) => {
      const now = nowIso();
      const del = (table: string, col = 'feature_id') => stmt(db, `DELETE FROM ${table} WHERE ${col} IN (${IN})`, ...ids);
      return [
        del('feature_tags'), del('feature_estimates'), del('department_votes'), del('release_features'), del('comments'), del('feature_blockers'),
        del('feature_links'), del('proposal_features'), del('feature_plan_baselines'), del('feature_phase_events'), del('feature_phase_forecasts'),
        stmt(db, `DELETE FROM feature_relations WHERE from_id IN (${IN}) OR to_id IN (${IN})`, ...ids, ...ids),
        ...importStatements(db, 'feature', ids, links, keyById, user, now),
        stmt(db, `DELETE FROM audit_log WHERE entity_type IN ${FEATURE_AUDIT_TYPES} AND entity_id IN (${IN})`, ...ids),
        ...snaps.map((s) => {
          const data = parseJson<Row>(s.data, {});
          data.tasks = (data.tasks ?? []).map((t: Row) => (ids.includes(t.id) ? { ...t, id: null, title: 'Удалённая задача' } : t));
          return stmt(db, 'UPDATE month_snapshots SET data = ? WHERE month_id = ?', JSON.stringify(data), s.month_id);
        }),
        stmt(db, `UPDATE features SET merged_into_id = NULL WHERE merged_into_id IN (${IN}) AND id NOT IN (${IN})`, ...ids, ...ids),
        stmt(db, `DELETE FROM features WHERE id IN (${IN})`, ...ids),
      ];
    },
  };
}

async function epicPlan(db: D1Database, rec: Row): Promise<Plan> {
  const key = keyOf('epic', rec.number);
  const tasks = await all(db, 'SELECT id, number, title FROM features WHERE epic_id = ? ORDER BY number', rec.id);
  const links = await importLinks(db, 'epic', [rec.id]);
  const items = Number((await first(db, `SELECT COUNT(*) AS n FROM import_items WHERE entity_type = 'epic' AND target_id = ?`, rec.id))?.n ?? 0);
  const audit = Number((await first(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'epic' AND entity_id = ?`, rec.id))?.n ?? 0);
  const effects: Effect[] = [];
  if (tasks.length) effects.push({ label: 'Задачи эпика', count: tasks.length, items: tasks.map((t) => `RF-${t.number} ${t.title}`), note: 'Задачи не удаляются — они останутся без эпика (запись об этом попадёт в их историю).' });
  effects.push(...importEffects(links, items), auditEffect(audit));
  return {
    kind: 'epic', record: rec, key, title: rec.title, ids: [rec.id], numbers: [rec.number], dupKeys: [], effects, warnings: [],
    statements: (user, reason) => {
      const now = nowIso();
      return [
        ...tasks.flatMap((t) => [
          stmt(db, 'UPDATE features SET epic_id = NULL, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', now, user.id, t.id),
          auditStmt(db, user, 'feature', t.id, 'updated', [{ field: 'epic', old: key, new: null }], `Эпик ${key} удалён навсегда${reason ? `: ${reason}` : ''}`),
        ]),
        ...importStatements(db, 'epic', [rec.id], links, new Map([[rec.id, key]]), user, now),
        stmt(db, `DELETE FROM audit_log WHERE entity_type = 'epic' AND entity_id = ?`, rec.id),
        stmt(db, 'DELETE FROM epics WHERE id = ?', rec.id),
      ];
    },
  };
}

async function proposalPlan(db: D1Database, rec: Row): Promise<Plan> {
  const recs = await withMerged(db, 'proposals', rec);
  const ids = recs.map((r) => r.id);
  const IN = ph(ids);
  const key = keyOf('proposal', rec.number);
  const votes = await all(db, `SELECT d.name, v.score FROM proposal_votes v JOIN departments d ON d.id = v.department_id WHERE v.proposal_id IN (${IN})`, ...ids);
  const tasks = await all(db, `SELECT DISTINCT f.number, f.title FROM proposal_features pf JOIN features f ON f.id = pf.feature_id WHERE pf.proposal_id IN (${IN}) ORDER BY f.number`, ...ids);
  const comments = Number((await first(db, `SELECT COUNT(*) AS n FROM proposal_comments WHERE proposal_id IN (${IN})`, ...ids))?.n ?? 0);
  const audit = Number((await first(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'proposal' AND entity_id IN (${IN})`, ...ids))?.n ?? 0);
  const effects: Effect[] = [];
  const add = (e: Effect) => { if (e.count > 0) effects.push(e); };
  add({ label: 'Объединённые дубли', count: recs.length - 1, items: recs.slice(1).map((x) => `${keyOf('proposal', x.number)} ${x.title}`), note: 'Удаляются вместе с предложением.' });
  add({ label: 'Голоса отделов', count: votes.length, items: votes.map((v) => `${v.name}: ${v.score}`) });
  add({ label: 'Связанные задачи', count: tasks.length, items: tasks.map((t) => `RF-${t.number} ${t.title}`), note: 'Задачи не удаляются, пропадёт только связь с предложением.' });
  add({ label: 'Комментарии', count: comments });
  effects.push(auditEffect(audit));
  return {
    kind: 'proposal', record: rec, key, title: rec.title, ids, numbers: recs.map((x) => x.number), dupKeys: recs.slice(1).map((x) => keyOf('proposal', x.number)), effects, warnings: [],
    statements: () => [
      stmt(db, `DELETE FROM proposal_votes WHERE proposal_id IN (${IN})`, ...ids),
      stmt(db, `DELETE FROM proposal_features WHERE proposal_id IN (${IN})`, ...ids),
      stmt(db, `DELETE FROM proposal_comments WHERE proposal_id IN (${IN})`, ...ids),
      stmt(db, `DELETE FROM audit_log WHERE entity_type = 'proposal' AND entity_id IN (${IN})`, ...ids),
      stmt(db, `UPDATE proposals SET merged_into_id = NULL WHERE merged_into_id IN (${IN}) AND id NOT IN (${IN})`, ...ids, ...ids),
      stmt(db, `DELETE FROM proposals WHERE id IN (${IN})`, ...ids),
    ],
  };
}

async function planFor(db: D1Database, kind: string, ref: string): Promise<Plan> {
  if (!Object.hasOwn(KIND, kind)) throw badRequest('Удалить навсегда можно задачу, эпик или предложение');
  const rec = await findRecord(db, kind as Kind, ref);
  return kind === 'feature' ? featurePlan(db, rec) : kind === 'epic' ? epicPlan(db, rec) : proposalPlan(db, rec);
}

const purgeSchema = z.object({ confirm: z.string().max(40), version: z.number().int(), preview_revision: z.number().int().nonnegative(), reason: z.string().trim().max(500).optional() });

export function registerPurgeRoutes(r: Router) {
  r.get('/api/admin/purge/:kind/:ref', async (ctx) => {
    requirePerm(ctx, perms.admin, 'Удалять навсегда может только администратор');
    const previewRevision = await revision(ctx.env.DB);
    const p = await planFor(ctx.env.DB, ctx.params.kind, ctx.params.ref);
    if (previewRevision !== await revision(ctx.env.DB)) throw conflict('version_conflict', STALE);
    return json({
      kind: p.kind, id: p.record.id, key: p.key, title: p.title, version: p.record.version,
      preview_revision: previewRevision,
      merged: p.dupKeys, effects: p.effects, warnings: p.warnings,
      confirm: p.key,
      backup: 'Отменить удаление нельзя. Вернуть данные можно только восстановлением всей базы из резервной копии Cloudflare D1 (Time Travel, до 30 дней) — это откатит и все остальные изменения после этого момента.',
    });
  });

  r.post('/api/admin/purge/:kind/:ref', async (ctx) => {
    const user = requirePerm(ctx, perms.admin, 'Удалять навсегда может только администратор');
    const b = await readJson(ctx, purgeSchema);
    const db = ctx.env.DB;
    const p = await planFor(db, ctx.params.kind, ctx.params.ref);
    if (b.confirm.trim().toUpperCase() !== p.key.toUpperCase()) throw badRequest(`Для подтверждения введите ${p.key}`);
    const reason = b.reason || null;
    await tx(db, [
      abortIf(db, 'purge:preview', `${REVISION_SQL} <> ?`, b.preview_revision),
      guardVersion(db, KIND[p.kind].table, p.record.id, b.version),
      ...p.statements(user, reason),
      raiseFloorStmt(db, KIND[p.kind].table, Math.max(...p.numbers)),
      // the one record that survives: the fact of the deletion, without content or private notes
      auditStmt(db, user, p.kind, p.record.id, 'deleted_permanently', [
        { field: 'key', old: p.key, new: null },
        { field: 'title', old: p.title, new: null },
        ...(p.dupKeys.length ? [{ field: 'merged_duplicates', old: p.dupKeys.join(', '), new: null }] : []),
      ], reason),
    ], STALE);
    return json({ ok: true, key: p.key, deleted: [p.key, ...p.dupKeys] });
  });
}

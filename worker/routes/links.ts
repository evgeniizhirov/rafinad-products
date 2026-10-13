// External links of a task (vNext ТЗ §3): Bitrix24 / Jira / documentation / other — stored URLs only.
// Read: any signed-in employee who may see the task (never guests). Write: product / admin (edit_catalog).
// The server never requests a link. Audit events are written on the task, so they appear in its history.
import { z } from 'zod';
import { checkUrl, guessKind, LINK_KIND_LABEL, LINK_KINDS, MAX_LINKS_PER_TASK, type LinkKind } from '../domain/links';
import { perms, requirePerm, requireUser } from '../lib/auth';
import { auditStmt } from '../lib/audit';
import { all, first, guardVersion, newId, nowIso, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { isProductInternal, linkDto, viewerOf } from '../lib/world';
import { resolveFeature } from './features';

const kind = z.enum(LINK_KINDS);
const title = z.string().trim().max(200).nullable().optional();

function validUrl(raw: string): string {
  const c = checkUrl(raw);
  if (!c.ok) throw badRequest(c.error);
  return c.url;
}

const describe = (l: { kind?: unknown; url?: unknown; title?: unknown }) => `${LINK_KIND_LABEL[l.kind as LinkKind] ?? String(l.kind)}: ${l.title ? `${l.title} — ` : ''}${l.url}`;

/** a link row together with its task, with the same hidden-task rule as the card (404 for non-editors) */
async function linkWithTask(ctx: Ctx, id: string): Promise<{ link: Row; task: Row }> {
  const link = await first(ctx.env.DB, 'SELECT * FROM feature_links WHERE id = ?', id);
  if (!link) throw notFound('Ссылка не найдена');
  const task = await first(ctx.env.DB, 'SELECT * FROM features WHERE id = ?', link.feature_id);
  if (!task || (isProductInternal(task) && viewerOf(ctx.user) !== 'editor')) throw notFound('Ссылка не найдена');
  return { link, task };
}

export function registerLinkRoutes(r: Router) {
  r.get('/api/features/:id/links', async (ctx) => {
    requireUser(ctx);
    const f = await resolveFeature(ctx, ctx.params.id);
    const rows = await all(ctx.env.DB, 'SELECT * FROM feature_links WHERE feature_id = ? ORDER BY kind, created_at, id', f.id);
    return json({ links: rows.map(linkDto) });
  });

  r.post('/api/features/:id/links', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({ url: z.string().max(4000), kind: kind.optional(), title }));
    const f = await resolveFeature(ctx, ctx.params.id);
    const url = validUrl(b.url);
    const db = ctx.env.DB;
    if (await first(db, 'SELECT 1 FROM feature_links WHERE feature_id = ? AND url = ?', f.id, url)) throw conflict('duplicate_link', 'Эта ссылка уже есть в задаче');
    const n = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM feature_links WHERE feature_id = ?', f.id))?.n ?? 0;
    if (n >= MAX_LINKS_PER_TASK) throw badRequest(`У задачи не больше ${MAX_LINKS_PER_TASK} ссылок`);
    const id = newId('lnk');
    const now = nowIso();
    const k = b.kind ?? guessKind(url);
    await tx(db, [
      stmt(db, `INSERT INTO feature_links (id, feature_id, kind, url, title, origin, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`, id, f.id, k, url, b.title || null, now, user.id, now, user.id),
      auditStmt(db, user, 'feature', f.id, 'link_added', [{ field: 'link', old: null, new: describe({ kind: k, url, title: b.title }) }]),
    ]);
    return json({ link: linkDto((await first(db, 'SELECT * FROM feature_links WHERE id = ?', id))!) }, 201);
  });

  r.patch('/api/links/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const b = await readJson(ctx, z.object({ url: z.string().max(4000).optional(), kind: kind.optional(), title, version: z.number().int() }));
    const { link, task } = await linkWithTask(ctx, ctx.params.id);
    const next = { kind: b.kind ?? link.kind, url: b.url !== undefined ? validUrl(b.url) : link.url, title: b.title === undefined ? link.title : b.title || null };
    if (next.kind === link.kind && next.url === link.url && (next.title ?? null) === (link.title ?? null)) return json({ ok: true, unchanged: true, link: linkDto(link) });
    const db = ctx.env.DB;
    if (next.url !== link.url && (await first(db, 'SELECT 1 FROM feature_links WHERE feature_id = ? AND url = ? AND id <> ?', task.id, next.url, link.id))) {
      throw conflict('duplicate_link', 'Эта ссылка уже есть в задаче');
    }
    const now = nowIso();
    await tx(db, [
      guardVersion(db, 'feature_links', link.id, b.version),
      // a manual edit of an imported link is remembered: the next import shows a conflict instead of overwriting it
      stmt(db, `UPDATE feature_links SET kind = ?, url = ?, title = ?, locally_edited = CASE WHEN origin = 'import' THEN 1 ELSE locally_edited END,
        updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`, next.kind, next.url, next.title, now, user.id, link.id),
      auditStmt(db, user, 'feature', task.id, 'link_changed', [{ field: 'link', old: describe(link), new: describe(next) }]),
    ], 'Ссылку изменил другой пользователь. Обновите карточку.');
    return json({ ok: true, link: linkDto((await first(db, 'SELECT * FROM feature_links WHERE id = ?', link.id))!) });
  });

  r.delete('/api/links/:id', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const { link, task } = await linkWithTask(ctx, ctx.params.id);
    const db = ctx.env.DB;
    await tx(db, [
      stmt(db, 'DELETE FROM feature_links WHERE id = ?', link.id),
      auditStmt(db, user, 'feature', task.id, 'link_removed', [{ field: 'link', old: describe(link), new: null }]),
    ]);
    return json({ ok: true });
  });
}

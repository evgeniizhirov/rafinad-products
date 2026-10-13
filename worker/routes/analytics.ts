// Analytics (FR-11): separate section, figures over the caller's visible tasks with the backlog filters.
import { analytics, type HistoryEvent } from '../domain/analytics';
import { requireUser } from '../lib/auth';
import { all, parseJson } from '../lib/db';
import { badRequest, json, type Router } from '../lib/http';
import { indexWorld, loadWorld, viewerOf } from '../lib/world';
import { queryFeatures } from './features';

const iso = /^\d{4}-\d{2}-\d{2}$/;

export function registerAnalyticsRoutes(r: Router) {
  r.get('/api/analytics/summary', async (ctx) => {
    const user = requireUser(ctx);
    const viewer = viewerOf(user);
    const p = new URLSearchParams(ctx.url.searchParams);
    const today = new Date().toISOString().slice(0, 10);
    const to = p.get('to') || today;
    const from = p.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
    if (!iso.test(from) || !iso.test(to) || from > to) throw badRequest('Период: from ≤ to, даты ГГГГ-ММ-ДД');
    // general tasks only: hidden Product tasks never enter aggregates, for any role
    p.delete('internal');
    p.delete('from');
    p.delete('to');
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const rows = queryFeatures(p, viewer, w, idx);
    const visible = new Set(rows.map((f) => f.id));
    const events = (await all(ctx.env.DB, `SELECT entity_id, at, action, changes, api_key_id FROM audit_log
        WHERE entity_type = 'feature' AND action IN ('created', 'import_created', 'updated', 'import_updated')`))
      .filter((e) => visible.has(e.entity_id))
      .map((e) => ({ ...e, changes: parseJson(e.changes, null) })) as HistoryEvent[];
    const threshold = Number(w.settings.analytics_high_priority || 4);
    return json({ ...analytics({ rows, w, idx, events, from, to, today, highThreshold: threshold }), total: rows.length });
  });
}

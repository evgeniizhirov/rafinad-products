// Roadmap (Now / Next / Later + timeline) and the overview dashboard.
import { all, bool } from '../lib/db';
import { json, type Router } from '../lib/http';
import { canSee, featureDto, hasFlag, indexWorld, loadWorld, metaDto, viewerOf, visibleFeatures } from '../lib/world';
import { sortFeatures } from './features';
import { activePeriods, currentLoad, currentPeriodId } from './planning';
import { releaseSummary } from './releases';

export function registerDashboardRoutes(r: Router) {
  r.get('/api/meta', async (ctx) => {
    const w = await loadWorld(ctx.env.DB, viewerOf(ctx.user));
    return json(metaDto(w, viewerOf(ctx.user)));
  });

  r.get('/api/roadmap', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    const periods = activePeriods(w);
    const cur = currentPeriodId(w);
    const curIdx = periods.findIndex((p) => p.id === cur);
    const nextId = curIdx >= 0 ? periods[curIdx + 1]?.id ?? null : null;
    const rows = sortFeatures(
      visibleFeatures(w, viewer).filter((f) => idx.status.get(f.status_id)?.semantic !== 'cancelled'),
      w, idx, 'priority',
    );
    const lane = (f: (typeof rows)[number]): 'now' | 'next' | 'later' | 'done' => {
      const sem = idx.status.get(f.status_id)?.semantic;
      if (sem === 'done') return 'done';
      if (sem === 'in_progress' || (cur && f.period_id === cur)) return 'now';
      if (nextId && f.period_id === nextId) return 'next';
      if (f.period_id) {
        const pi = periods.findIndex((p) => p.id === f.period_id);
        if (pi >= 0 && curIdx >= 0 && pi < curIdx) return 'now'; // overdue placements stay visible in "now"
      }
      return 'later';
    };
    const features = rows.map((f) => ({ ...featureDto(f, viewer, w, idx), lane: lane(f) }));
    const showCapacity = viewer !== 'guest' || w.settings.public_show_capacity === '1';
    const alerts = viewer === 'guest' ? [] : await all(ctx.env.DB, 'SELECT * FROM plan_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50');
    return json({
      periods,
      current_period_id: cur,
      next_period_id: nextId,
      features,
      releases: w.releases.filter((x) => canSee(viewer, x.visibility)).map((x) => releaseSummary(x, viewer, w, idx)),
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      load: showCapacity ? currentLoad(w, idx) : null,
      dependencies: w.relations
        .filter((x) => x.type === 'blocks' && idx.feature.has(x.from_id) && idx.feature.has(x.to_id))
        .filter((x) => canSee(viewer, idx.feature.get(x.from_id)!.visibility) && canSee(viewer, idx.feature.get(x.to_id)!.visibility))
        .map((x) => ({ from: x.from_id, to: x.to_id })),
      alerts,
    });
  });

  r.get('/api/overview', async (ctx) => {
    const viewer = viewerOf(ctx.user);
    const w = await loadWorld(ctx.env.DB, viewer);
    const idx = indexWorld(w);
    // every aggregate is computed over what this viewer may see
    const rows = visibleFeatures(w, viewer);
    const bySemantic: Record<string, number> = {};
    for (const f of rows) {
      const sem = idx.status.get(f.status_id)?.semantic ?? 'new';
      bySemantic[sem] = (bySemantic[sem] ?? 0) + 1;
    }
    const open = rows.filter((f) => hasFlag('open', f, w, idx));
    const ranked = sortFeatures(open, w, idx, 'priority');
    const blocked = open.filter((f) => hasFlag('blocked', f, w, idx));
    const unvoted = open.filter((f) => hasFlag('unvoted', f, w, idx)).length;
    const unestimated = open.filter((f) => hasFlag('unestimated', f, w, idx)).length;
    const periods = activePeriods(w);
    const cur = currentPeriodId(w);
    const ci = periods.findIndex((p) => p.id === cur);
    const showCapacity = viewer !== 'guest' || w.settings.public_show_capacity === '1';
    const load = showCapacity ? currentLoad(w, idx).filter((l) => ci >= 0 && (l.periodId === periods[ci]?.id || l.periodId === periods[ci + 1]?.id)) : null;
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = w.releases
      .filter((x) => canSee(viewer, x.visibility) && idx.status.get(x.status_id)?.semantic !== 'done' && idx.status.get(x.status_id)?.semantic !== 'cancelled')
      .sort((a, b) => (a.planned_date ?? '9999') < (b.planned_date ?? '9999') ? -1 : 1)
      .slice(0, 4)
      .map((x) => releaseSummary(x, viewer, w, idx));
    const alerts = viewer === 'guest' ? 0 : ((await all(ctx.env.DB, 'SELECT COUNT(*) AS n FROM plan_alerts WHERE resolved_at IS NULL'))[0]?.n ?? 0);
    return json({
      kpi: {
        total: rows.length,
        open: open.length,
        in_progress: bySemantic.in_progress ?? 0,
        ready: bySemantic.ready ?? 0,
        planned: bySemantic.planned ?? 0,
        done: bySemantic.done ?? 0,
        blocked: blocked.length,
        unvoted,
        unestimated,
        epics: w.epics.filter((e) => canSee(viewer, e.visibility)).length,
        offers: w.offers.filter((o) => canSee(viewer, o.visibility)).length,
      },
      by_status: w.statuses
        .filter((s) => s.entity === 'feature')
        .map((s) => ({ id: s.id, name: s.name, semantic: s.semantic, color: s.color, count: rows.filter((f) => f.status_id === s.id).length })),
      top: ranked.slice(0, 8).map((f) => featureDto(f, viewer, w, idx)),
      blocked: blocked.slice(0, 8).map((f) => featureDto(f, viewer, w, idx)),
      periods: ci >= 0 ? periods.slice(ci, ci + 2) : [],
      teams: w.teams.filter((t) => bool(t.is_active)).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      load,
      releases: upcoming,
      alerts,
      today,
    });
  });
}

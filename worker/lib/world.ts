// Loads the planning "world" in one D1 round-trip and turns it into role-appropriate DTOs.
// Guest DTOs are built from an explicit allow-list of fields — private data is never fetched into them.

import type { D1Database } from '../env';
import { computePriority, type DeptWeight, type PriorityResult } from '../domain/priority';
import type { SessionUser } from './auth';
import { bool, stmt, type Row } from './db';

export type Viewer = 'guest' | 'employee' | 'editor';

export function viewerOf(u: SessionUser | null): Viewer {
  if (!u) return 'guest';
  return u.role === 'product' || u.role === 'admin' ? 'editor' : 'employee';
}

export function canSee(viewer: Viewer, visibility: string): boolean {
  if (viewer === 'editor') return true;
  if (viewer === 'employee') return visibility !== 'draft';
  return visibility === 'public';
}

export interface World {
  departments: Row[];
  teams: Row[];
  categories: Row[];
  statuses: Row[];
  stages: Row[];
  periods: Row[];
  capacities: Row[];
  settings: Record<string, string>;
  epics: Row[];
  features: Row[];
  estimates: Row[];
  votes: Row[];
  tags: Row[];
  offers: Row[];
  featureOffers: Row[];
  relations: Row[];
  releases: Row[];
  releaseFeatures: Row[];
}

export async function loadWorld(db: D1Database): Promise<World> {
  const q = (sql: string) => stmt(db, sql);
  const res = await db.batch([
    q('SELECT * FROM departments ORDER BY sort_order, name'),
    q('SELECT * FROM resource_teams ORDER BY sort_order, name'),
    q('SELECT * FROM categories ORDER BY sort_order, name'),
    q('SELECT * FROM statuses ORDER BY entity, sort_order'),
    q('SELECT * FROM stages ORDER BY sort_order'),
    q('SELECT * FROM capacity_periods ORDER BY start_date, id'),
    q('SELECT * FROM team_capacities'),
    q('SELECT key, value FROM app_settings'),
    q('SELECT * FROM epics ORDER BY number'),
    q('SELECT * FROM features ORDER BY number'),
    q('SELECT * FROM feature_estimates'),
    q('SELECT feature_id, department_id, score, voted_at, version FROM department_votes'),
    q('SELECT * FROM feature_tags ORDER BY tag'),
    q('SELECT * FROM offers ORDER BY name'),
    q('SELECT * FROM feature_offers'),
    q('SELECT * FROM feature_relations'),
    q('SELECT * FROM releases ORDER BY planned_date IS NULL, planned_date, name'),
    q('SELECT * FROM release_features'),
  ]);
  const r = (i: number) => (res[i].results ?? []) as Row[];
  const settings: Record<string, string> = {};
  for (const s of r(7)) settings[s.key] = s.value;
  return {
    departments: r(0), teams: r(1), categories: r(2), statuses: r(3), stages: r(4), periods: r(5), capacities: r(6), settings,
    epics: r(8), features: r(9), estimates: r(10), votes: r(11), tags: r(12), offers: r(13), featureOffers: r(14),
    relations: r(15), releases: r(16), releaseFeatures: r(17),
  };
}

export function deptWeights(w: World): Map<string, DeptWeight> {
  return new Map(w.departments.map((d) => [d.id, { id: d.id, weight: Number(d.weight), isActive: bool(d.is_active), isProduct: bool(d.is_product) }]));
}

export interface Indexes {
  status: Map<string, Row>;
  category: Map<string, Row>;
  stage: Map<string, Row>;
  epic: Map<string, Row>;
  feature: Map<string, Row>;
  offer: Map<string, Row>;
  release: Map<string, Row>;
  period: Map<string, Row>;
  estimatesBy: Map<string, Row[]>;
  votesBy: Map<string, Row[]>;
  tagsBy: Map<string, string[]>;
  offersByFeature: Map<string, string[]>;
  featuresByOffer: Map<string, string[]>;
  releaseOf: Map<string, string>;
  featuresByRelease: Map<string, string[]>;
  priority: Map<string, PriorityResult>;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

export function indexWorld(w: World): Indexes {
  const weights = deptWeights(w);
  const votesBy = groupBy(w.votes, (v) => v.feature_id);
  const priority = new Map<string, PriorityResult>();
  for (const f of w.features) {
    priority.set(
      f.id,
      computePriority((votesBy.get(f.id) ?? []).map((v) => ({ departmentId: v.department_id, score: v.score, votedAt: v.voted_at })), weights),
    );
  }
  const offersByFeature = new Map<string, string[]>();
  const featuresByOffer = new Map<string, string[]>();
  for (const fo of w.featureOffers) {
    if (!offersByFeature.has(fo.feature_id)) offersByFeature.set(fo.feature_id, []);
    offersByFeature.get(fo.feature_id)!.push(fo.offer_id);
    if (!featuresByOffer.has(fo.offer_id)) featuresByOffer.set(fo.offer_id, []);
    featuresByOffer.get(fo.offer_id)!.push(fo.feature_id);
  }
  const releaseOf = new Map<string, string>();
  const featuresByRelease = new Map<string, string[]>();
  for (const rf of w.releaseFeatures) {
    releaseOf.set(rf.feature_id, rf.release_id);
    if (!featuresByRelease.has(rf.release_id)) featuresByRelease.set(rf.release_id, []);
    featuresByRelease.get(rf.release_id)!.push(rf.feature_id);
  }
  const tagsBy = new Map<string, string[]>();
  for (const t of w.tags) {
    if (!tagsBy.has(t.feature_id)) tagsBy.set(t.feature_id, []);
    tagsBy.get(t.feature_id)!.push(t.tag);
  }
  return {
    status: new Map(w.statuses.map((s) => [s.id, s])),
    category: new Map(w.categories.map((s) => [s.id, s])),
    stage: new Map(w.stages.map((s) => [s.id, s])),
    epic: new Map(w.epics.map((s) => [s.id, s])),
    feature: new Map(w.features.map((s) => [s.id, s])),
    offer: new Map(w.offers.map((s) => [s.id, s])),
    release: new Map(w.releases.map((s) => [s.id, s])),
    period: new Map(w.periods.map((s) => [s.id, s])),
    estimatesBy: groupBy(w.estimates, (e) => e.feature_id),
    votesBy,
    tagsBy,
    offersByFeature,
    featuresByOffer,
    releaseOf,
    featuresByRelease,
    priority,
  };
}

// ───────────────────────── DTO builders ─────────────────────────

const statusDto = (s: Row | undefined) => (s ? { id: s.id, name: s.name, semantic: s.semantic, color: s.color } : null);
const categoryDto = (c: Row | undefined) => (c ? { id: c.id, name: c.name, color: c.color } : null);

export function featureRef(f: Row | undefined, viewer: Viewer, idx: Indexes) {
  if (!f || !canSee(viewer, f.visibility)) return { hidden: true as const };
  return {
    id: f.id, number: f.number, key: `RF-${f.number}`, title: f.title, status: statusDto(idx.status.get(f.status_id)),
    ...(viewer === 'guest' ? {} : { visibility: f.visibility }),
  };
}

export function showEstimates(viewer: Viewer, w: World) {
  return viewer !== 'guest' || w.settings.public_show_estimates === '1';
}

export interface FeatureDtoOptions {
  detail?: boolean;
}

export function featureDto(f: Row, viewer: Viewer, w: World, idx: Indexes, opts: FeatureDtoOptions = {}) {
  const epic = f.epic_id ? idx.epic.get(f.epic_id) : undefined;
  const release = idx.releaseOf.has(f.id) ? idx.release.get(idx.releaseOf.get(f.id)!) : undefined;
  const period = f.period_id ? idx.period.get(f.period_id) : undefined;
  const pr = idx.priority.get(f.id)!;
  const estRows = idx.estimatesBy.get(f.id) ?? [];
  const activeTeams = w.teams.filter((t) => bool(t.is_active));
  const withEst = showEstimates(viewer, w);
  const estimates: Record<string, number> = {};
  const manual: Record<string, boolean> = {};
  for (const e of estRows) {
    estimates[e.team_id] = e.hours;
    manual[e.team_id] = bool(e.is_manual);
  }
  const total = Object.values(estimates).reduce((s, h) => s + h, 0);
  const dto: Record<string, unknown> = {
    id: f.id,
    number: f.number,
    key: `RF-${f.number}`,
    title: f.title,
    description: opts.detail ? f.description : undefined,
    excerpt: opts.detail ? undefined : (f.description || '').slice(0, 220),
    category: categoryDto(idx.category.get(f.category_id)),
    tags: idx.tagsBy.get(f.id) ?? [],
    epic: epic ? (canSee(viewer, epic.visibility) ? { id: epic.id, number: epic.number, title: epic.title } : { hidden: true }) : null,
    status: statusDto(idx.status.get(f.status_id)),
    stage: f.stage_id ? { id: f.stage_id, name: idx.stage.get(f.stage_id)?.name ?? '' } : null,
    requested_at: f.requested_at,
    created_at: f.created_at,
    planned_start: f.planned_start,
    planned_end: f.planned_end,
    closed_at: f.closed_at,
    period: period ? { id: period.id, name: period.name, start_date: period.start_date, end_date: period.end_date } : null,
    placement_locked: bool(f.placement_locked),
    release: release && canSee(viewer, release.visibility)
      ? { id: release.id, name: release.name, version_label: release.version_label, planned_date: release.planned_date, approved: !!release.approved_at }
      : null,
    priority: pr,
    votes: (idx.votesBy.get(f.id) ?? []).map((v) => ({ department_id: v.department_id, score: v.score, voted_at: v.voted_at, ...(viewer !== 'guest' ? { version: v.version } : {}) })),
    offers: (idx.offersByFeature.get(f.id) ?? [])
      .map((id) => idx.offer.get(id))
      .filter((o): o is Row => !!o && canSee(viewer, o.visibility))
      .map((o) => ({ id: o.id, name: o.name, external_code: o.external_code })),
  };
  if (withEst) {
    dto.estimates = estimates;
    dto.estimate_total = Math.round(total * 10) / 10;
    dto.estimate_missing = activeTeams.filter((t) => !(t.id in estimates)).map((t) => t.id);
  }
  if (viewer !== 'guest') {
    dto.external_ref = f.external_ref;
    dto.author_name = f.author_name;
    dto.assignee_name = f.assignee_name;
    dto.visibility = f.visibility;
    dto.version = f.version;
    dto.updated_at = f.updated_at;
    dto.estimate_manual = manual;
  }
  if (viewer === 'editor') dto.private_notes = opts.detail ? f.private_notes : undefined;

  // relations: hidden counterparts are reported without any content
  const rel = { blocks: [] as unknown[], blocked_by: [] as unknown[], related: [] as unknown[], duplicate_of: [] as unknown[], duplicates: [] as unknown[] };
  for (const r of w.relations) {
    if (r.from_id !== f.id && r.to_id !== f.id) continue;
    const otherId = r.from_id === f.id ? r.to_id : r.from_id;
    const other = idx.feature.get(otherId);
    if (other?.merged_into_id) continue;
    const ref = { ...featureRef(other, viewer, idx), relation_id: viewer === 'editor' ? r.id : undefined };
    if (r.type === 'blocks') (r.from_id === f.id ? rel.blocks : rel.blocked_by).push(ref);
    else if (r.type === 'related_to') rel.related.push(ref);
    else if (r.type === 'duplicate_of') (r.from_id === f.id ? rel.duplicate_of : rel.duplicates).push(ref);
  }
  dto.relations = rel;
  dto.open_blockers = (w.relations as Row[]).filter((r) => r.type === 'blocks' && r.to_id === f.id).filter((r) => {
    const b = idx.feature.get(r.from_id);
    const sem = b ? idx.status.get(b.status_id)?.semantic : null;
    return b && !b.merged_into_id && sem !== 'done' && sem !== 'cancelled';
  }).length;
  return dto;
}

export function visibleFeatures(w: World, viewer: Viewer): Row[] {
  return w.features.filter((f) => !f.merged_into_id && canSee(viewer, f.visibility));
}

export function metaDto(w: World, viewer: Viewer) {
  return {
    departments: w.departments.map((d) => ({ id: d.id, code: d.code, name: d.name, weight: d.weight, is_product: bool(d.is_product), is_active: bool(d.is_active), sort_order: d.sort_order, version: d.version })),
    teams: w.teams.map((t) => ({ id: t.id, code: t.code, name: t.name, color: t.color, is_active: bool(t.is_active), sort_order: t.sort_order, version: t.version })),
    categories: w.categories.map((c) => ({ id: c.id, name: c.name, color: c.color, is_active: bool(c.is_active), sort_order: c.sort_order, version: c.version })),
    statuses: w.statuses.map((s) => ({ id: s.id, entity: s.entity, code: s.code, name: s.name, semantic: s.semantic, color: s.color, is_active: bool(s.is_active), sort_order: s.sort_order, version: s.version })),
    stages: w.stages.map((s) => ({ id: s.id, code: s.code, name: s.name, is_active: bool(s.is_active), sort_order: s.sort_order, version: s.version })),
    periods: w.periods.map((p) => ({ id: p.id, name: p.name, start_date: p.start_date, end_date: p.end_date, is_active: bool(p.is_active), version: p.version })),
    settings: {
      public_show_estimates: w.settings.public_show_estimates === '1',
      public_show_capacity: w.settings.public_show_capacity === '1',
      planning_horizon: Number(w.settings.planning_horizon || 3),
    },
    viewer,
  };
}

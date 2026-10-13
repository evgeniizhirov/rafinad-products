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

/** FR-02: hidden Product task (separate from visibility — 'internal' visibility is readable by every employee). */
export const isProductInternal = (f: Row | undefined | null) => !!f && bool(f.is_product_internal);

/** The one rule for a single task: visibility level AND the Product-internal flag. */
export function canSeeFeature(viewer: Viewer, f: Row | undefined | null): boolean {
  if (!f) return false;
  if (isProductInternal(f) && viewer !== 'editor') return false;
  return canSee(viewer, f.visibility);
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
  relations: Row[];
  releases: Row[];
  releaseFeatures: Row[];
  /** id, name, is_active — for initiator names (never sent to guests) */
  users: Row[];
  sprints: Row[];
  months: Row[];
  /** business blockers (FR-03): what we wait for, from whom, since when */
  blockers: Row[];
  /** external links (vNext §3) — URLs only, shown to signed-in employees, never to guests */
  links: Row[];
}

/**
 * Loads the catalog for one viewer. Hidden Product tasks (FR-02) are removed together with every row that
 * references them (votes, estimates, tags, relations, release links), so no list, counter, graph,
 * relation or aggregate built on the world can reveal them — not even as a "hidden" placeholder.
 * They stay only when product/admin explicitly ask for them (`includeInternal`): the task list with
 * `?internal=…` and the task card. General views (overview, roadmap, priorities, releases, epics,
 * planning) never include them, for any role.
 */
export async function loadWorld(db: D1Database, viewer: Viewer | 'system', opts: { includeInternal?: boolean } = {}): Promise<World> {
  const w = await loadAll(db);
  return (viewer === 'editor' || viewer === 'system') && opts.includeInternal ? w : withoutProductInternal(w);
}

export function linkDto(l: Row) {
  return {
    id: l.id, kind: l.kind, url: l.url, title: l.title ?? null, origin: l.origin, source_id: l.source_id ?? null,
    locally_edited: bool(l.locally_edited), updated_at: l.updated_at, version: l.version,
  };
}

export function withoutProductInternal(w: World): World {
  const hidden = new Set(w.features.filter((f) => isProductInternal(f)).map((f) => f.id as string));
  if (!hidden.size) return w;
  const keep = (id: unknown) => !hidden.has(id as string);
  return {
    ...w,
    features: w.features.filter((f) => keep(f.id)),
    estimates: w.estimates.filter((x) => keep(x.feature_id)),
    votes: w.votes.filter((x) => keep(x.feature_id)),
    tags: w.tags.filter((x) => keep(x.feature_id)),
    relations: w.relations.filter((x) => keep(x.from_id) && keep(x.to_id)),
    releaseFeatures: w.releaseFeatures.filter((x) => keep(x.feature_id)),
    blockers: w.blockers.filter((x) => keep(x.feature_id)),
    links: w.links.filter((x) => keep(x.feature_id)),
  };
}

async function loadAll(db: D1Database): Promise<World> {
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
    q('SELECT * FROM feature_relations'),
    q('SELECT * FROM releases ORDER BY planned_date IS NULL, planned_date, name'),
    q('SELECT * FROM release_features'),
    q('SELECT id, name, is_active FROM users'),
    q('SELECT * FROM sprints ORDER BY start_date, ordinal'),
    q('SELECT * FROM accounting_months ORDER BY month'),
    q('SELECT * FROM feature_blockers ORDER BY started_at, created_at'),
    q('SELECT * FROM feature_links ORDER BY kind, created_at, id'),
  ]);
  const r = (i: number) => (res[i].results ?? []) as Row[];
  const settings: Record<string, string> = {};
  for (const s of r(7)) settings[s.key] = s.value;
  return {
    departments: r(0), teams: r(1), categories: r(2), statuses: r(3), stages: r(4), periods: r(5), capacities: r(6), settings,
    epics: r(8), features: r(9), estimates: r(10), votes: r(11), tags: r(12),
    relations: r(13), releases: r(14), releaseFeatures: r(15), users: r(16), sprints: r(17), months: r(18), blockers: r(19), links: r(20),
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
  release: Map<string, Row>;
  period: Map<string, Row>;
  sprint: Map<string, Row>;
  openBlockersBy: Map<string, Row[]>;
  linksBy: Map<string, Row[]>;
  estimatesBy: Map<string, Row[]>;
  votesBy: Map<string, Row[]>;
  tagsBy: Map<string, string[]>;
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
    release: new Map(w.releases.map((s) => [s.id, s])),
    period: new Map(w.periods.map((s) => [s.id, s])),
    sprint: new Map(w.sprints.map((s) => [s.id, s])),
    openBlockersBy: groupBy(w.blockers.filter((b) => !b.resolved_at), (b) => b.feature_id),
    linksBy: groupBy(w.links, (l) => l.feature_id),
    estimatesBy: groupBy(w.estimates, (e) => e.feature_id),
    votesBy,
    tagsBy,
    releaseOf,
    featuresByRelease,
    priority,
  };
}

// ───────────────────────── DTO builders ─────────────────────────

export const statusDto = (s: Row | undefined) => (s ? { id: s.id, name: s.name, semantic: s.semantic, color: s.color } : null);
const categoryDto = (c: Row | undefined) => (c ? { id: c.id, name: c.name, color: c.color } : null);

export function featureRef(f: Row | undefined, viewer: Viewer, idx: Indexes) {
  if (!f || !canSeeFeature(viewer, f)) return { hidden: true as const };
  return {
    id: f.id, number: f.number, key: `RF-${f.number}`, title: f.title, status: statusDto(idx.status.get(f.status_id)),
    ...(viewer === 'guest' ? {} : { visibility: f.visibility }),
  };
}

/** sprint as seen from a task: hidden when its release is not visible to the viewer */
export function sprintRef(s: Row | undefined, viewer: Viewer, idx: Indexes) {
  if (!s) return null;
  const rel = idx.release.get(s.release_id);
  if (!rel || !canSee(viewer, rel.visibility)) return null;
  return { id: s.id, code: s.code, ordinal: s.ordinal, release_id: s.release_id, start_date: s.start_date, end_date: s.end_date, testing_start: s.testing_start, production_due: s.production_due, status: s.status };
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
  const estVersions: Record<string, number> = {};
  for (const e of estRows) {
    estimates[e.team_id] = e.hours;
    manual[e.team_id] = bool(e.is_manual);
    estVersions[e.team_id] = e.version;
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
    sprint: sprintRef(f.sprint_id ? idx.sprint.get(f.sprint_id) : undefined, viewer, idx),
    planned_production_date: f.planned_production_date ?? null,
    urgency: f.urgency ?? null,
    is_focus: bool(f.is_focus),
    placement_locked: bool(f.placement_locked),
    release: release && canSee(viewer, release.visibility)
      ? { id: release.id, name: release.name, version_label: release.version_label, planned_date: release.planned_date, approved: !!release.approved_at }
      : null,
    priority: pr,
    votes: (idx.votesBy.get(f.id) ?? []).map((v) => ({ department_id: v.department_id, score: v.score, voted_at: v.voted_at, ...(viewer !== 'guest' ? { version: v.version } : {}) })),
  };
  if (withEst) {
    dto.estimates = estimates;
    dto.estimate_total = Math.round(total * 10) / 10;
    dto.estimate_missing = activeTeams.filter((t) => !(t.id in estimates)).map((t) => t.id);
  }
  dto.task_kind = f.task_kind ?? 'planned';
  if (viewer !== 'guest') {
    dto.baseline_production_date = f.baseline_production_date ?? null;
    dto.fact_hours = f.fact_hours ?? null;
    dto.is_product_internal = isProductInternal(f);
    dto.initiator = initiatorDto(f, w);
    dto.external_ref = f.external_ref;
    dto.author_name = f.author_name;
    dto.assignee_name = f.assignee_name;
    dto.visibility = f.visibility;
    dto.version = f.version;
    dto.updated_at = f.updated_at;
    dto.estimate_manual = manual;
    dto.estimate_versions = estVersions;
    dto.links = (idx.linksBy.get(f.id) ?? []).map(linkDto);
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
  dto.open_blockers = openBlockerIds(f, w, idx).length;
  if (viewer !== 'guest') dto.business_blockers = (idx.openBlockersBy.get(f.id) ?? []).map((b) => blockerDto(b, w));
  return dto;
}

// ───────────────────────── shared feature predicates (overview counters = backlog filters) ─────────────────────────

export const isClosed = (f: Row, idx: Indexes) => ['done', 'cancelled'].includes(idx.status.get(f.status_id)?.semantic);

/** blocking features that are not done/cancelled */
export function openBlockerIds(f: Row, w: World, idx: Indexes): string[] {
  return (w.relations as Row[])
    .filter((r) => r.type === 'blocks' && r.to_id === f.id)
    .map((r) => r.from_id as string)
    .filter((id) => {
      const b = idx.feature.get(id);
      const sem = b ? idx.status.get(b.status_id)?.semantic : null;
      return !!b && !b.merged_into_id && sem !== 'done' && sem !== 'cancelled';
    });
}

export type FeatureFlag = 'open' | 'blocked' | 'unvoted' | 'unestimated';

export const FLAG_LABELS: Record<FeatureFlag, string> = {
  open: 'Открытые задачи',
  blocked: 'С блокировками',
  unvoted: 'Без голосов отделов',
  unestimated: 'Без оценки часов',
};

/** Every flag except "open" also implies the task is open (not done / cancelled). */
export function hasFlag(flag: FeatureFlag, f: Row, w: World, idx: Indexes): boolean {
  if (isClosed(f, idx)) return false;
  switch (flag) {
    case 'open':
      return true;
    case 'blocked':
      return idx.status.get(f.status_id)?.semantic === 'blocked' || openBlockerIds(f, w, idx).length > 0 || (idx.openBlockersBy.get(f.id) ?? []).length > 0;
    case 'unvoted':
      return !(idx.votesBy.get(f.id) ?? []).length;
    case 'unestimated':
      return !(idx.estimatesBy.get(f.id) ?? []).some((e) => e.hours > 0);
  }
}

/**
 * Tasks of the general lists (backlog, priorities, roadmap, overview, releases, epics, planning).
 * Hidden Product tasks never belong there; product/admin open them with `scope = 'internal'` (or `'all'`).
 */
export function visibleFeatures(w: World, viewer: Viewer, scope: 'general' | 'internal' | 'all' = 'general'): Row[] {
  return w.features.filter((f) => {
    if (f.merged_into_id || !canSeeFeature(viewer, f)) return false;
    if (scope === 'all') return true;
    return scope === 'internal' ? isProductInternal(f) : !isProductInternal(f);
  });
}

/**
 * Only planned, non-hidden tasks take part in capacity planning, budgets and release composition (FR-02, FR-07).
 * Bugs and operational improvements are visible in work views but never consume planned hours.
 */
export const isPlannable = (f: Row) => (f.task_kind ?? 'planned') === 'planned' && !isProductInternal(f);

export const TASK_KINDS = ['planned', 'bug', 'operational_improvement'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export function blockerDto(b: Row, w: World) {
  const dep = b.owner_department_id ? w.departments.find((d) => d.id === b.owner_department_id) : null;
  return {
    id: b.id, feature_id: b.feature_id, expectation: b.expectation,
    owner_department: dep ? { id: dep.id, name: dep.name } : null, owner_name: b.owner_name ?? null,
    started_at: b.started_at, due_at: b.due_at ?? null, resolved_at: b.resolved_at ?? null, resolution: b.resolution ?? null, version: b.version,
  };
}

export type InitiatorType = 'free_text' | 'user' | 'department';

/** Current name of the linked user / department, falling back to the snapshot taken when it was chosen. */
export function initiatorDto(f: Row, w: World) {
  const type = f.initiator_type as InitiatorType | null;
  if (!type) return null;
  if (type === 'user') {
    const u = w.users.find((x) => x.id === f.initiator_user_id);
    return { type, user_id: f.initiator_user_id ?? null, name: u?.name ?? f.initiator_name ?? 'Пользователь удалён', inactive: u ? !bool(u.is_active) : true };
  }
  if (type === 'department') {
    const d = w.departments.find((x) => x.id === f.initiator_department_id);
    return { type, department_id: f.initiator_department_id ?? null, name: d?.name ?? f.initiator_name ?? 'Отдел удалён', inactive: d ? !bool(d.is_active) : true };
  }
  return { type, name: f.initiator_name ?? '' };
}

/** "user:<id>" / "department:<id>" / "text:<substring>" */
export function matchesInitiator(f: Row, w: World, filter: string): boolean {
  const [kind, ...rest] = filter.split(':');
  const value = rest.join(':');
  if (kind === 'none') return !f.initiator_type;
  if (kind === 'user') return f.initiator_type === 'user' && f.initiator_user_id === value;
  if (kind === 'department') return f.initiator_type === 'department' && f.initiator_department_id === value;
  if (kind === 'text') return !!f.initiator_type && (initiatorDto(f, w)?.name ?? '').toLowerCase().includes(value.toLowerCase());
  return false;
}

export function metaDto(w: World, viewer: Viewer) {
  return {
    departments: w.departments.map((d) => ({ id: d.id, code: d.code, name: d.name, weight: d.weight, is_product: bool(d.is_product), is_active: bool(d.is_active), sort_order: d.sort_order, version: d.version })),
    teams: w.teams.map((t) => ({ id: t.id, code: t.code, name: t.name, color: t.color, is_active: bool(t.is_active), sort_order: t.sort_order, version: t.version })),
    categories: w.categories.map((c) => ({ id: c.id, name: c.name, color: c.color, is_active: bool(c.is_active), sort_order: c.sort_order, version: c.version })),
    statuses: w.statuses.map((s) => ({ id: s.id, entity: s.entity, code: s.code, name: s.name, semantic: s.semantic, color: s.color, is_active: bool(s.is_active), sort_order: s.sort_order, version: s.version })),
    stages: w.stages.map((s) => ({ id: s.id, code: s.code, name: s.name, phase: s.phase ?? null, is_active: bool(s.is_active), sort_order: s.sort_order, version: s.version })),
    periods: w.periods.map((p) => ({ id: p.id, name: p.name, start_date: p.start_date, end_date: p.end_date, is_active: bool(p.is_active), version: p.version })),
    settings: {
      public_show_estimates: w.settings.public_show_estimates === '1',
      public_show_capacity: w.settings.public_show_capacity === '1',
      planning_horizon: Number(w.settings.planning_horizon || 3),
    },
    viewer,
  };
}

// Spreadsheet import engine (pure; no I/O). Produces a preview that the product team reviews
// before anything is written. See TZ §5 and §15.
//
// Matching order: (source_id, external_id) link → exact business ID → normalised title / similarity.
// Similar items are NEVER merged automatically: they become "duplicate" items that need a decision.
// Field ownership: descriptive fields follow 3-way merge (last imported / local / source);
// protected fields (status, stage, manual estimates, visibility, votes, plans…) are never overwritten
// unless the user explicitly ticks them.

import { flatToCanonical, type FlatConfig } from './flatSheet';
import { findCycle, type Edge } from './graph';
import { normalizeTitle, parseDate, parseHours, sanitizeCell, similarity } from './text';

export type SheetKey = 'epics' | 'features' | 'offers' | 'relations';
export const SHEET_KEYS: SheetKey[] = ['epics', 'offers', 'features', 'relations'];

export interface ImportConfig {
  /** 'template' — four sheets Epics/Features/Offers/Relations; 'flat' — one sheet of tasks with a column mapping */
  format?: 'template' | 'flat';
  sheets: Record<SheetKey, string>;
  /** extra column header → resource team code (in addition to automatic `<code>_hours`) */
  hoursColumns: Record<string, string>;
  flat?: FlatConfig;
  /** visibility of cards created by this source; TZ default is «черновик» */
  newVisibility?: 'draft' | 'internal';
}

export const DEFAULT_IMPORT_CONFIG: ImportConfig = {
  sheets: { epics: 'Epics', features: 'Features', offers: 'Offers', relations: 'Relations' },
  hoursColumns: {},
};

export const SHEET_COLUMNS: Record<SheetKey, { required: string[]; optional: string[] }> = {
  epics: { required: ['external_id', 'title'], optional: ['description', 'category', 'status', 'visibility'] },
  features: {
    required: ['external_id', 'title'],
    optional: ['description', 'category', 'epic_external_id', 'status', 'stage', 'requested_at', 'assignee', 'planned_end', 'closed_at', 'tags', 'visibility',
      // bugs / operational improvements (P05); task_kind, initiator and author are applied on creation only
      'task_kind', 'urgency', 'fact_hours', 'initiator', 'author'],
  },
  offers: { required: ['external_id', 'name'], optional: ['description', 'category', 'status', 'visibility'] },
  relations: { required: ['from_type', 'from_external_id', 'relation_type', 'to_type', 'to_external_id'], optional: [] },
};

/** raw sheets as read from the source; `flat` holds the single sheet of the 'flat' format */
export type SheetsData = Partial<Record<SheetKey | 'flat', string[][]>>;

/** names of the sheets to read for a config */
export function sourceSheetNames(config: ImportConfig): { key: SheetKey | 'flat'; name: string }[] {
  if (config.format === 'flat' && config.flat) return [{ key: 'flat', name: config.flat.sheet }];
  return SHEET_KEYS.map((k) => ({ key: k, name: config.sheets[k] }));
}

export interface SnapshotEntity {
  id: string;
  number?: number;
  title: string; // offers: name
  description: string;
  category_id: string | null;
  status_id: string;
  external_ref: string | null; // offers: external_code
  version: number;
  merged_into_id?: string | null;
  epic_id?: string | null;
  stage_id?: string | null;
  requested_at?: string | null;
  assignee_name?: string | null;
  planned_end?: string | null;
  urgency?: string | null;
  fact_hours?: number | null;
  tags?: string[];
  estimates?: Record<string, { hours: number; is_manual: number }>;
}

export interface Snapshot {
  categories: { id: string; name: string }[];
  statuses: { id: string; entity: string; code: string; name: string; semantic: string; sort_order: number }[];
  stages: { id: string; code: string; name: string }[];
  teams: { id: string; code: string; name: string }[];
  links: { entity_type: string; external_id: string; entity_id: string; last_values: Record<string, unknown> | null }[];
  epics: SnapshotEntity[];
  features: SnapshotEntity[];
  offers: SnapshotEntity[];
  relations: { type: string; from_id: string; to_id: string }[];
  featureOffers: { feature_id: string; offer_id: string }[];
  /** for the initiator column: an exact name match becomes a link to a department / user */
  departments?: { id: string; name: string }[];
  users?: { id: string; name: string }[];
}

export type EntityType = 'epic' | 'feature' | 'offer' | 'relation' | 'sheet';
export type Action = 'create' | 'update' | 'unchanged' | 'duplicate' | 'error';

export interface DiffEntry {
  field: string;
  label: string;
  local: unknown;
  source: unknown;
  last: unknown;
  localLabel?: string;
  sourceLabel?: string;
  kind: 'update' | 'conflict' | 'protected';
}

export interface Candidate {
  id: string;
  label: string;
  score: number;
  reason: string;
}

export interface Resolution {
  mode: 'create' | 'update' | 'link' | 'skip';
  targetId?: string;
  /** conflict / update field → which value wins */
  fields?: Record<string, 'source' | 'local'>;
  /** protected field → explicitly confirmed overwrite */
  protected?: Record<string, boolean>;
}

export interface ItemDraft {
  seq: number;
  sheet: string;
  rowNumber: number;
  entityType: EntityType;
  externalId: string | null;
  action: Action;
  targetId: string | null;
  targetVersion: number | null;
  candidates: Candidate[];
  payload: Record<string, any>;
  diff: DiffEntry[];
  errors: string[];
  warnings: string[];
  resolution: Resolution | null;
}

const ENTITY_OF: Record<Exclude<SheetKey, 'relations'>, 'epic' | 'feature' | 'offer'> = {
  epics: 'epic',
  features: 'feature',
  offers: 'offer',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'Название',
  name: 'Название',
  description: 'Описание',
  category_id: 'Категория',
  epic: 'Эпик',
  status_id: 'Статус',
  stage_id: 'Этап',
  requested_at: 'Дата постановки',
  assignee_name: 'Исполнитель',
  planned_end: 'Срок',
  tags: 'Теги',
  urgency: 'Срочность',
  fact_hours: 'Факт часов',
};

export const URGENCIES = ['low', 'medium', 'high', 'critical'] as const;

/** initiator cell → department / user when the name matches exactly one of them, otherwise free text */
export function initiatorOf(raw: string, snap: Snapshot): { type: 'free_text' | 'user' | 'department'; id: string | null; name: string } | null {
  const name = raw.trim();
  if (!name) return null;
  const k = lc(name);
  const deps = (snap.departments ?? []).filter((d) => lc(d.name) === k);
  if (deps.length === 1) return { type: 'department', id: deps[0].id, name: deps[0].name };
  // «Мхитарян Дмитрий» and «Дмитрий Мхитарян» are the same person
  const words = (s: string) => lc(s).split(/\s+/).filter(Boolean).sort().join(' ');
  const users = (snap.users ?? []).filter((u) => words(u.name) === words(name));
  if (users.length === 1) return { type: 'user', id: users[0].id, name: users[0].name };
  return { type: 'free_text', id: null, name };
}
const KINDS = ['planned', 'bug', 'operational_improvement'];

export const RELATION_TYPES = ['blocks', 'related_to', 'duplicate_of', 'affects_offer', 'belongs_to_epic'] as const;

const SIMILARITY_THRESHOLD = 0.55;

function lc(s: string) {
  return s.trim().toLowerCase();
}

/** header row → column index, case-insensitive */
function headerIndex(header: string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => {
    const k = lc(sanitizeCell(h, 200));
    if (k && !m.has(k)) m.set(k, i);
  });
  return m;
}

export function hoursColumnMap(config: ImportConfig, teams: Snapshot['teams']): Map<string, string> {
  // column (lower-case) → teamId
  const byCode = new Map(teams.map((t) => [lc(t.code), t.id]));
  const out = new Map<string, string>();
  for (const t of teams) out.set(`${lc(t.code)}_hours`, t.id);
  for (const [col, code] of Object.entries(config.hoursColumns || {})) {
    const id = byCode.get(lc(code));
    if (id && col.trim()) out.set(lc(col), id);
  }
  return out;
}

export interface Lookup {
  categoryByName: Map<string, string>;
  categoryName: Map<string, string>;
  status: (entity: string, raw: string) => string | null;
  statusName: Map<string, string>;
  defaultStatus: (entity: string) => string;
  stage: (raw: string) => string | null;
  stageName: Map<string, string>;
  linkOf: Map<string, { entity_id: string; last_values: Record<string, unknown> | null }>;
  extOfEntity: Map<string, string>; // `${type}|${entityId}` → external id (this source)
  entities: Record<'epic' | 'feature' | 'offer', Map<string, SnapshotEntity>>;
}

export function buildLookup(s: Snapshot): Lookup {
  const statusFor = (entity: string) => s.statuses.filter((x) => x.entity === entity);
  const linkOf = new Map<string, { entity_id: string; last_values: Record<string, unknown> | null }>();
  const extOfEntity = new Map<string, string>();
  for (const l of s.links) {
    linkOf.set(`${l.entity_type}|${lc(l.external_id)}`, { entity_id: l.entity_id, last_values: l.last_values });
    extOfEntity.set(`${l.entity_type}|${l.entity_id}`, l.external_id);
  }
  return {
    categoryByName: new Map(s.categories.map((c) => [lc(c.name), c.id])),
    categoryName: new Map(s.categories.map((c) => [c.id, c.name])),
    status: (entity, raw) => {
      const k = lc(raw);
      return statusFor(entity).find((x) => lc(x.code) === k || lc(x.name) === k)?.id ?? null;
    },
    statusName: new Map(s.statuses.map((x) => [x.id, x.name])),
    defaultStatus: (entity) => statusFor(entity).slice().sort((a, b) => a.sort_order - b.sort_order)[0]?.id ?? '',
    stage: (raw) => {
      const k = lc(raw);
      return s.stages.find((x) => lc(x.code) === k || lc(x.name) === k)?.id ?? null;
    },
    stageName: new Map(s.stages.map((x) => [x.id, x.name])),
    linkOf,
    extOfEntity,
    entities: {
      epic: new Map(s.epics.map((e) => [e.id, e])),
      feature: new Map(s.features.map((e) => [e.id, e])),
      offer: new Map(s.offers.map((e) => [e.id, e])),
    },
  };
}

/** follow merged_into chain so a re-import of a merged duplicate updates the surviving card */
export function resolveMerged(map: Map<string, SnapshotEntity>, id: string): SnapshotEntity | undefined {
  let e = map.get(id);
  let guard = 0;
  while (e?.merged_into_id && guard++ < 20) e = map.get(e.merged_into_id);
  return e;
}

export function buildPreview(rawSheets: SheetsData, config: ImportConfig, snap: Snapshot, opts: { today?: string } = {}): ItemDraft[] {
  const L = buildLookup(snap);
  const items: ItemDraft[] = [];
  let seq = 0;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  // 'flat' format: convert the single task sheet into canonical Features rows first
  let sheets: SheetsData = rawSheets;
  const sheetNameOf = (key: SheetKey) => (config.format === 'flat' && config.flat && key === 'features' ? config.flat.sheet : config.sheets[key]);
  let flatDerived: Map<number, boolean> | null = null;
  let flatProblems: Map<number, string[]> | null = null;
  if (config.format === 'flat' && config.flat) {
    sheets = {};
    const raw = rawSheets.flat;
    if (raw && raw.length) {
      const conv = flatToCanonical(raw, config.flat, snap.teams.map((t) => t.code.toLowerCase()), today);
      if (conv.missing.includes(config.flat.columns.title)) {
        items.push({
          seq: seq++, sheet: config.flat.sheet, rowNumber: 1, entityType: 'sheet', externalId: null, action: 'error', targetId: null, targetVersion: null,
          candidates: [], payload: {}, diff: [], warnings: [], resolution: null,
          errors: [`Лист «${config.flat.sheet}»: нет колонки «${config.flat.columns.title}» с названием задачи`],
        });
        return items;
      }
      sheets.features = conv.rows;
      flatDerived = conv.derived;
      flatProblems = conv.problems;
      if (conv.missing.length) {
        items.push({
          seq: seq++, sheet: config.flat.sheet, rowNumber: 1, entityType: 'sheet', externalId: null, action: 'unchanged', targetId: null, targetVersion: null,
          candidates: [], payload: {}, diff: [], errors: [], resolution: null,
          warnings: [`Колонки не найдены и будут пропущены: ${conv.missing.map((m) => `«${m}»`).join(', ')}`],
        });
      }
    }
  }
  const hoursCols = hoursColumnMap(config, snap.teams);
  const teamName = new Map(snap.teams.map((t) => [t.id, t.name]));

  // external ids present in this import (per entity type) → item, used by Relations and epic links
  const inRun: Record<'epic' | 'feature' | 'offer', Map<string, ItemDraft>> = { epic: new Map(), feature: new Map(), offer: new Map() };

  // flat sheets often list the same task twice (assigned block + general list): flag, never merge silently
  const flatTitles = new Map<string, { row: number; assignee: string }>();

  const push = (it: Omit<ItemDraft, 'seq'>) => {
    const d = { ...it, seq: seq++ };
    items.push(d);
    return d;
  };

  for (const key of SHEET_KEYS) {
    const rows = sheets[key];
    const sheetName = sheetNameOf(key);
    if (!rows || rows.length === 0) continue;
    const header = rows[0].map((h) => sanitizeCell(h, 200));
    const idx = headerIndex(header);
    const missing = SHEET_COLUMNS[key].required.filter((c) => !idx.has(c));
    if (missing.length) {
      push({
        sheet: sheetName, rowNumber: 1, entityType: 'sheet', externalId: null, action: 'error', targetId: null, targetVersion: null,
        candidates: [], payload: {}, diff: [], warnings: [], resolution: null,
        errors: [`Лист «${sheetName}»: нет обязательных колонок ${missing.map((m) => `«${m}»`).join(', ')}`],
      });
      continue;
    }
    const cell = (row: string[], col: string, max = 20000) => {
      const i = idx.get(col);
      return i === undefined ? '' : sanitizeCell(row[i], max);
    };

    const has = (col: string) => idx.has(col);
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const rowNumber = r + 1;
      if (row.every((c) => !String(c ?? '').trim())) continue; // blank row
      if (key === 'relations') {
        items.push(relationItem(seq++, sheetName, rowNumber, row, cell, L, inRun, snap));
        continue;
      }
      const entityType = ENTITY_OF[key];
      const errors: string[] = [];
      const warnings: string[] = [];
      const externalId = cell(row, 'external_id', 200);
      const titleCol = key === 'offers' ? 'name' : 'title';
      const title = cell(row, titleCol, 2000);
      if (!externalId) errors.push('Не заполнен обязательный столбец external_id');
      if (!title) errors.push(`Не заполнен обязательный столбец ${titleCol}`);
      if (title.length > 300) errors.push(`Название длиннее 300 символов (${title.length})`);
      const isDerived = !!flatDerived?.get(r);
      if (externalId && inRun[entityType].has(lc(externalId))) {
        const prev = inRun[entityType].get(lc(externalId))!.rowNumber;
        errors.push(isDerived
          ? `Повтор: та же задача с тем же исполнителем уже есть в строке ${prev} — строка не импортируется`
          : `Повтор external_id «${externalId}» — уже встречался в строке ${prev}`);
      }
      for (const p of flatProblems?.get(r) ?? []) warnings.push(p);
      if (flatDerived && title && !errors.length) {
        const k = normalizeTitle(title);
        const seen = flatTitles.get(k);
        const who = cell(row, 'assignee', 120);
        if (seen) warnings.push(`Такая же задача есть в строке ${seen.row}${seen.assignee ? ` (${seen.assignee})` : ' (без исполнителя)'} — если это одна задача, удалите повтор в таблице или объедините карточки`);
        else flatTitles.set(k, { row: rowNumber, assignee: who });
      }
      const description = has('description') ? cell(row, 'description') : undefined;

      // dictionaries
      const categoryRaw = cell(row, 'category', 200);
      let category_id: string | null | undefined = has('category') ? null : undefined;
      if (categoryRaw) {
        category_id = L.categoryByName.get(lc(categoryRaw)) ?? null;
        if (!category_id) warnings.push(`Категория «${categoryRaw}» не найдена в справочнике — будет пустой`);
      }
      const statusRaw = cell(row, 'status', 200);
      let status_id: string | null = null;
      if (statusRaw) {
        status_id = L.status(entityType, statusRaw);
        if (!status_id) warnings.push(`Статус «${statusRaw}» не найден в справочнике — будет проигнорирован`);
      }
      const visibilityRaw = lc(cell(row, 'visibility', 50));
      if (visibilityRaw && !['public', 'internal', 'draft', 'публичная', 'внутренняя', 'черновик'].includes(visibilityRaw)) {
        warnings.push(`Неизвестное значение visibility «${visibilityRaw}»`);
      }

      const payload: Record<string, any> = { external_id: externalId, title, description, category_id, status_id, visibility_hint: visibilityRaw || null };
      if (isDerived) payload.derived_id = true;

      if (entityType === 'feature') {
        const epicExt = cell(row, 'epic_external_id', 200);
        payload.epic_ext = has('epic_external_id') ? epicExt || null : undefined;
        if (epicExt) {
          const runEpic = inRun.epic.get(lc(epicExt));
          if (runEpic?.action === 'error') errors.push(`Эпик «${epicExt}» (строка ${runEpic.rowNumber}) содержит ошибки`);
          else if (!runEpic && !resolveEpicExt(L, epicExt)) errors.push(`Ссылка на отсутствующий эпик «${epicExt}»`);
        }
        const stageRaw = cell(row, 'stage', 200);
        payload.stage_id = null;
        if (stageRaw) {
          payload.stage_id = L.stage(stageRaw);
          if (!payload.stage_id) warnings.push(`Этап «${stageRaw}» не найден в справочнике`);
        }
        const reqRaw = cell(row, 'requested_at', 50);
        payload.requested_at = has('requested_at') ? null : undefined;
        if (reqRaw) {
          payload.requested_at = parseDate(reqRaw);
          if (!payload.requested_at) warnings.push(`Дата «${reqRaw}» не распознана (ожидается ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)`);
        }
        if (has('assignee')) payload.assignee_name = cell(row, 'assignee', 120) || null;
        for (const dc of ['planned_end', 'closed_at'] as const) {
          if (!has(dc)) continue;
          const raw = cell(row, dc, 50);
          payload[dc] = raw ? parseDate(raw) : null;
          if (raw && !payload[dc]) warnings.push(`Дата «${raw}» не распознана (ожидается ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)`);
        }
        if (has('tags')) {
          payload.tags = [...new Set(cell(row, 'tags', 500).split(',').map((t) => t.trim().slice(0, 40)).filter(Boolean))].sort();
        }
        if (has('task_kind')) {
          const k = lc(cell(row, 'task_kind', 40));
          if (k && !KINDS.includes(k)) errors.push(`Неизвестный тип работы «${k}»`);
          payload.task_kind = k || 'planned';
        }
        if (has('urgency')) {
          const u = lc(cell(row, 'urgency', 40));
          payload.urgency = (URGENCIES as readonly string[]).includes(u) ? u : null;
          if (u && !payload.urgency) warnings.push(`Неизвестная срочность «${u}»`);
        }
        if (has('fact_hours')) {
          const raw = cell(row, 'fact_hours', 50);
          const h = raw ? parseHours(raw) : { value: null };
          payload.fact_hours = h.value;
        }
        if (has('initiator')) payload.initiator = initiatorOf(cell(row, 'initiator', 200), snap);
        if (has('author')) payload.author_name = cell(row, 'author', 120) || null;
        const estimates: Record<string, number> = {};
        for (const [col, teamId] of hoursCols) {
          const i = idx.get(col);
          if (i === undefined) continue;
          const raw = sanitizeCell(row[i], 50);
          const h = parseHours(raw);
          if (h.error) errors.push(`${col}: ${h.error}`);
          else if (h.value !== null) estimates[teamId] = h.value;
        }
        payload.estimates = estimates;
      }

      const base = {
        sheet: sheetName, rowNumber, entityType, externalId: externalId || null,
        candidates: [] as Candidate[], payload, diff: [] as DiffEntry[], errors, warnings,
        targetId: null as string | null, targetVersion: null as number | null,
      };

      if (errors.length) {
        const it = push({ ...base, action: 'error', resolution: null });
        if (externalId && !inRun[entityType].has(lc(externalId))) inRun[entityType].set(lc(externalId), it);
        continue;
      }

      // 1. link by (source, external_id)
      const link = L.linkOf.get(`${entityType}|${lc(externalId)}`);
      let target: SnapshotEntity | undefined;
      let lastValues: Record<string, unknown> | null = null;
      let matchNote: string | null = null;
      if (link) {
        target = resolveMerged(L.entities[entityType], link.entity_id);
        lastValues = link.last_values;
        if (target && target.id !== link.entity_id) matchNote = 'Карточка была объединена — обновится основная карточка';
      }
      // 2. exact business identifier
      if (!target) {
        const matches = [...L.entities[entityType].values()].filter((e) => !e.merged_into_id && e.external_ref && lc(e.external_ref) === lc(externalId));
        if (matches.length === 1) {
          target = matches[0];
          matchNote = 'Сопоставлено по бизнес-идентификатору';
        } else if (matches.length > 1) {
          const it = push({
            ...base, action: 'duplicate', resolution: null,
            candidates: matches.map((m) => ({ id: m.id, label: entityLabel(entityType, m), score: 1, reason: 'Совпадает бизнес-ID' })),
          });
          inRun[entityType].set(lc(externalId), it);
          continue;
        }
      }

      if (target) {
        if (matchNote) warnings.push(matchNote);
        const diff = diffEntity(entityType, target, payload, lastValues, L, teamName, { statusFollowsSource: config.format === 'flat' });
        const action: Action = diff.length ? 'update' : 'unchanged';
        const fields: Record<string, 'source' | 'local'> = {};
        for (const d of diff) if (d.kind === 'update') fields[d.field] = 'source';
        const it = push({
          ...base, targetId: target.id, targetVersion: target.version, diff, action,
          resolution: action === 'update' ? { mode: 'update', targetId: target.id, fields, protected: {} } : { mode: 'update', targetId: target.id, fields: {}, protected: {} },
        });
        inRun[entityType].set(lc(externalId), it);
        continue;
      }

      // 3. similar titles → explicit decision required
      const norm = normalizeTitle(title);
      const candidates: Candidate[] = [];
      for (const e of L.entities[entityType].values()) {
        if (e.merged_into_id) continue;
        const exact = normalizeTitle(e.title) === norm;
        const score = exact ? 1 : similarity(title, e.title);
        if (score >= SIMILARITY_THRESHOLD) {
          candidates.push({ id: e.id, label: entityLabel(entityType, e), score: Math.round(score * 100) / 100, reason: exact ? 'Совпадает название' : 'Похожее название' });
        }
      }
      candidates.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      if (candidates.length) {
        const it = push({ ...base, action: 'duplicate', candidates: candidates.slice(0, 5), resolution: null });
        inRun[entityType].set(lc(externalId), it);
        continue;
      }
      if (visibilityRaw === 'public' || visibilityRaw === 'публичная') {
        warnings.push('Новая карточка попадёт в черновики; опубликуйте её после проверки');
      }
      const it = push({ ...base, action: 'create', resolution: { mode: 'create' } });
      inRun[entityType].set(lc(externalId), it);
    }
  }

  // cycle check over blocks relations (existing + new from this run, by external id / entity id)
  const blockItems = items.filter((i) => i.entityType === 'relation' && i.action === 'create' && i.payload.relation_type === 'blocks');
  if (blockItems.length) {
    const edges: Edge[] = snap.relations.filter((r) => r.type === 'blocks').map((r) => [r.from_id, r.to_id]);
    for (const it of blockItems) {
      const e: Edge = [it.payload.from_key, it.payload.to_key];
      const cyc = findCycle([...edges, e]);
      if (cyc) {
        it.action = 'error';
        it.resolution = null;
        it.errors.push('Связь blocks создаёт циклическую зависимость');
      } else edges.push(e);
    }
  }
  return items;
}

function entityLabel(type: string, e: SnapshotEntity) {
  const prefix = type === 'feature' ? `RF-${e.number}` : type === 'epic' ? `EP-${e.number}` : e.external_ref || 'Оффер';
  return `${prefix}: ${e.title}`;
}

/** existing epic for an external id: link of this source first, then the epic's business ID */
export function resolveEpicExt(L: Lookup, ext: string): SnapshotEntity | undefined {
  const link = L.linkOf.get(`epic|${lc(ext)}`);
  if (link) return resolveMerged(L.entities.epic, link.entity_id);
  const m = [...L.entities.epic.values()].filter((e) => e.external_ref && lc(e.external_ref) === lc(ext));
  return m.length === 1 ? m[0] : undefined;
}

function epicKey(L: Lookup, epicId: string): string {
  const ext = L.extOfEntity.get(`epic|${epicId}`);
  if (ext) return ext;
  const ref = L.entities.epic.get(epicId)?.external_ref;
  return ref || `id:${epicId}`;
}

/** current local values in "comparable" form */
function localValues(type: string, e: SnapshotEntity, L: Lookup): Record<string, unknown> {
  const v: Record<string, unknown> = {
    title: e.title,
    description: e.description ?? '',
    category_id: e.category_id ?? null,
    status_id: e.status_id ?? null,
  };
  if (type === 'feature') {
    v.epic = e.epic_id ? epicKey(L, e.epic_id) : null;
    v.stage_id = e.stage_id ?? null;
    v.requested_at = e.requested_at ?? null;
    v.assignee_name = e.assignee_name ?? null;
    v.planned_end = e.planned_end ?? null;
    v.urgency = e.urgency ?? null;
    v.fact_hours = e.fact_hours ?? null;
    v.tags = tagsKey(e.tags ?? []);
    for (const [teamId, est] of Object.entries(e.estimates ?? {})) v[`hours:${teamId}`] = est.hours;
  }
  return v;
}

const tagsKey = (tags: string[]) => [...tags].map((t) => t.trim()).filter(Boolean).sort().join(', ');

/** source values in the same comparable form (also stored as link.last_values after apply) */
export function sourceValues(type: string, payload: Record<string, any>): Record<string, unknown> {
  // fields whose column is absent in the sheet are `undefined` and never compared or overwritten
  const v: Record<string, unknown> = {
    title: payload.title,
    description: payload.description === undefined ? undefined : payload.description ?? '',
    category_id: payload.category_id,
    status_id: payload.status_id ?? null,
  };
  if (type === 'feature') {
    v.epic = payload.epic_ext;
    v.stage_id = payload.stage_id ?? null;
    v.requested_at = payload.requested_at;
    v.assignee_name = payload.assignee_name;
    v.planned_end = payload.planned_end;
    v.urgency = payload.urgency;
    v.fact_hours = payload.fact_hours;
    v.tags = payload.tags === undefined ? undefined : tagsKey(payload.tags);
    for (const [teamId, h] of Object.entries(payload.estimates ?? {})) v[`hours:${teamId}`] = h;
  }
  for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  return v;
}

const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim());
const eqField = (f: string, a: unknown, b: unknown) =>
  f === 'epic' && typeof a === 'string' && typeof b === 'string' ? lc(a) === lc(b) : eq(a, b);

function diffEntity(
  type: 'epic' | 'feature' | 'offer',
  target: SnapshotEntity,
  payload: Record<string, any>,
  last: Record<string, unknown> | null,
  L: Lookup,
  teamName: Map<string, string>,
  opts: { statusFollowsSource?: boolean } = {},
): DiffEntry[] {
  const local = localValues(type, target, L);
  const source = sourceValues(type, payload);
  const out: DiffEntry[] = [];
  const label = (field: string) => (field.startsWith('hours:') ? `Часы ${teamName.get(field.slice(6)) ?? field.slice(6)}` : FIELD_LABELS[field] ?? field);
  const display = (field: string, v: unknown): string | undefined => {
    if (v === null || v === undefined || v === '') return '—';
    if (field === 'category_id') return L.categoryName.get(String(v)) ?? String(v);
    if (field === 'status_id') return L.statusName.get(String(v)) ?? String(v);
    if (field === 'stage_id') return L.stageName.get(String(v)) ?? String(v);
    if (field === 'urgency') return ({ low: 'низкая', medium: 'средняя', high: 'высокая', critical: 'критическая' } as Record<string, string>)[String(v)] ?? String(v);
    if (field === 'epic') {
      const s = String(v);
      if (s.startsWith('id:')) return L.entities.epic.get(s.slice(3))?.title ?? s;
      const e = resolveEpicExt(L, s);
      return e ? `${s}: ${e.title}` : s;
    }
    return undefined;
  };

  const descriptive = ['title', 'description', 'category_id', ...(type === 'feature' ? ['epic', 'requested_at', 'assignee_name', 'planned_end', 'tags', 'urgency', 'fact_hours'] : [])];
  const protectedFields = ['status_id', ...(type === 'feature' ? ['stage_id'] : [])];

  for (const f of descriptive) {
    if (!(f in source)) continue; // column absent in this source
    const s = source[f];
    const l = local[f];
    if (f === 'category_id' && s === null && payload.category_id === null && l !== null) {
      // empty / unknown category in the sheet never clears a local category
      continue;
    }
    if (eqField(f, s, l)) continue;
    const lastV = last ? last[f] : undefined;
    if (last && eqField(f, s, lastV)) continue; // source did not change since last import → local edit wins silently
    const kind: DiffEntry['kind'] = last && eqField(f, l, lastV) ? 'update' : 'conflict';
    out.push({ field: f, label: label(f), local: l ?? null, source: s ?? null, last: lastV ?? null, localLabel: display(f, l), sourceLabel: display(f, s), kind });
  }

  for (const f of protectedFields) {
    const s = source[f];
    if (s === null || s === undefined) continue; // empty cell never clears protected values
    const l = local[f];
    if (eq(s, l)) continue;
    const lastV = last ? last[f] : undefined;
    if (last && eq(s, lastV)) continue;
    // a task-list sheet owns the status of its tasks («Сделано»): while nobody changed the status in the system
    // (local = last imported value) the new value is a plain update; a local change keeps the field protected
    const follows = f === 'status_id' && !!opts.statusFollowsSource && !!last && f in last && eq(l, lastV);
    out.push({ field: f, label: label(f), local: l ?? null, source: s, last: lastV ?? null, localLabel: display(f, l), sourceLabel: display(f, s), kind: follows ? 'update' : 'protected' });
  }

  if (type === 'feature') {
    for (const [teamId, h] of Object.entries(payload.estimates ?? {})) {
      const f = `hours:${teamId}`;
      const est = target.estimates?.[teamId];
      const l = est?.hours ?? null;
      if (eq(h, l)) continue;
      const lastV = last ? last[f] : undefined;
      if (last && eq(h, lastV)) continue;
      // manually refined estimates are protected; imported ones follow the 3-way rule
      const kind: DiffEntry['kind'] = !est ? 'update' : est.is_manual ? 'protected' : last && eq(l, lastV) ? 'update' : 'conflict';
      out.push({ field: f, label: label(f), local: l, source: h, last: lastV ?? null, kind });
    }
  }
  return out;
}

function relationItem(
  seq: number,
  sheet: string,
  rowNumber: number,
  row: string[],
  cell: (row: string[], col: string, max?: number) => string,
  L: Lookup,
  inRun: Record<'epic' | 'feature' | 'offer', Map<string, ItemDraft>>,
  snap: Snapshot,
): ItemDraft {
  const errors: string[] = [];
  const fromType = lc(cell(row, 'from_type', 50));
  const toType = lc(cell(row, 'to_type', 50));
  const relType = lc(cell(row, 'relation_type', 50));
  const fromExt = cell(row, 'from_external_id', 200);
  const toExt = cell(row, 'to_external_id', 200);
  const payload: Record<string, any> = { from_type: fromType, from_external_id: fromExt, relation_type: relType, to_type: toType, to_external_id: toExt };
  const base: ItemDraft = {
    seq, sheet, rowNumber, entityType: 'relation', externalId: `${fromExt} ${relType} ${toExt}`, action: 'error', targetId: null, targetVersion: null,
    candidates: [], payload, diff: [], errors, warnings: [], resolution: null,
  };
  if (!(RELATION_TYPES as readonly string[]).includes(relType)) {
    errors.push(`Неизвестный тип связи «${relType}». Допустимо: ${RELATION_TYPES.join(', ')}`);
    return base;
  }
  const expected: Record<string, [string, string]> = {
    blocks: ['feature', 'feature'],
    related_to: ['feature', 'feature'],
    duplicate_of: ['feature', 'feature'],
    affects_offer: ['feature', 'offer'],
    belongs_to_epic: ['feature', 'epic'],
  };
  const [ef, et] = expected[relType];
  if (fromType !== ef || toType !== et) {
    errors.push(`Для связи ${relType} ожидается ${ef} → ${et}, получено ${fromType || '—'} → ${toType || '—'}`);
    return base;
  }
  // resolve endpoints → existing entity id or "ext:<type>:<id>" for entities created in this run
  const resolve = (type: 'feature' | 'offer' | 'epic', ext: string): string | null => {
    if (!ext) return null;
    const run = inRun[type].get(lc(ext));
    if (run) {
      if (run.action === 'error') return null;
      if (run.targetId) return run.targetId;
      return `ext:${type}:${lc(ext)}`;
    }
    if (type === 'epic') return resolveEpicExt(L, ext)?.id ?? null;
    const link = L.linkOf.get(`${type}|${lc(ext)}`);
    if (link) return resolveMerged(L.entities[type], link.entity_id)?.id ?? null;
    return null;
  };
  const fromKey = resolve(ef as 'feature', fromExt);
  const toKey = resolve(et as 'feature' | 'offer' | 'epic', toExt);
  if (!fromKey) errors.push(`Ссылка на отсутствующую сущность ${ef} «${fromExt}»`);
  if (!toKey) errors.push(`Ссылка на отсутствующую сущность ${et} «${toExt}»`);
  if (errors.length) return base;
  if (fromKey === toKey) {
    errors.push('Связь сущности с самой собой');
    return base;
  }
  payload.from_key = fromKey;
  payload.to_key = toKey;

  // already present?
  let exists = false;
  if (!fromKey!.startsWith('ext:') && !toKey!.startsWith('ext:')) {
    if (relType === 'affects_offer') exists = snap.featureOffers.some((x) => x.feature_id === fromKey && x.offer_id === toKey);
    else if (relType === 'belongs_to_epic') exists = L.entities.feature.get(fromKey!)?.epic_id === toKey;
    else if (relType === 'related_to')
      exists = snap.relations.some((r) => r.type === 'related_to' && ((r.from_id === fromKey && r.to_id === toKey) || (r.from_id === toKey && r.to_id === fromKey)));
    else exists = snap.relations.some((r) => r.type === relType && r.from_id === fromKey && r.to_id === toKey);
  }
  return { ...base, action: exists ? 'unchanged' : 'create', resolution: exists ? null : { mode: 'create' } };
}

/** Items that still need a human decision before "Apply" is allowed. */
export function unresolvedReasons(items: ItemDraft[]): string[] {
  const out: string[] = [];
  const epicByExt = new Map(items.filter((i) => i.entityType === 'epic' && i.externalId).map((i) => [i.externalId!.trim().toLowerCase(), i]));
  for (const it of items) {
    if (it.entityType === 'feature' && it.resolution?.mode === 'create' && it.payload.epic_ext) {
      const ep = epicByExt.get(String(it.payload.epic_ext).trim().toLowerCase());
      if (ep && (ep.resolution?.mode === 'skip' || ep.action === 'error')) {
        out.push(`${it.sheet}, строка ${it.rowNumber}: эпик «${it.payload.epic_ext}» пропущен — выберите для него карточку или пропустите эту строку`);
      }
    }
    if (it.action === 'duplicate') {
      const r = it.resolution;
      if (!r || !['create', 'link', 'skip'].includes(r.mode) || (r.mode === 'link' && !r.targetId)) {
        out.push(`${it.sheet}, строка ${it.rowNumber}: выберите — новая карточка, существующая или пропуск`);
      }
    }
    if (it.action === 'update' && it.resolution?.mode === 'update') {
      for (const d of it.diff) {
        if (d.kind === 'conflict' && !it.resolution.fields?.[d.field]) {
          out.push(`${it.sheet}, строка ${it.rowNumber}: конфликт поля «${d.label}» — выберите значение`);
        }
      }
    }
  }
  return out;
}

export function countItems(items: { action: string; resolution: Resolution | null; entityType: string }[]) {
  const c = { create: 0, update: 0, unchanged: 0, duplicate: 0, error: 0, skipped: 0, total: items.length };
  for (const it of items) {
    if (it.resolution?.mode === 'skip') c.skipped++;
    else c[it.action as keyof typeof c]++;
  }
  return c;
}

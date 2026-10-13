// Import of external links from a sheet (vNext ТЗ §3, «Импорт ссылок»). Pure functions — no I/O.
//
// Rules (owner decisions 13.10):
//   • a link column of the source is mapped to a kind (Bitrix24 / Jira / Документация / Другое);
//     optionally URLs found in the task text / comment cells are imported too (kind guessed from the address);
//   • a cell may hold several URLs; the same URL is never stored twice on a task;
//   • hyperlinks hidden behind cell text come from the Google Sheets API metadata only (CSV has text only);
//   • manual links of a card are never changed or removed by an import;
//   • links created by THIS source are updated idempotently; a link edited by hand after the import is a conflict
//     (the preview shows both, the local version is kept unless the user picks the source);
//   • a link that disappeared from the source is NOT removed: the preview marks it «нет в источнике»,
//     and it is deleted only when the user ticks it.
import { checkUrl, extractUrls, guessKind, LINK_KINDS, type LinkKind } from './links';

export interface SourceLink {
  kind: LinkKind;
  url: string;
  /** sheet column the link came from */
  column: string;
}

export interface ExistingLink {
  id: string;
  feature_id: string;
  kind: string;
  url: string;
  origin: string;
  source_id: string | null;
  locally_edited: number | boolean;
}

export interface LinkPlan {
  add: SourceLink[];
  /** imported earlier by this source, not edited by hand, the kind changed in the source */
  update: { id: string; url: string; from: string; to: LinkKind; column: string }[];
  /** imported earlier, edited by hand, the source has another kind → user decides (default: keep local) */
  conflicts: { id: string; url: string; local: string; source: LinkKind; column: string }[];
  /** the URL already exists on the card as a manual link (or from another source) → left as is */
  kept: string[];
  /** imported earlier by this source, no longer in the source → kept unless the user removes it */
  missing: { id: string; url: string; kind: string }[];
  unchanged: number;
}

export interface LinkChoice {
  /** conflict URLs where the source value wins */
  source?: string[];
  /** missing URLs to delete */
  remove?: string[];
}

/** warnings about link cells start with this, so the preview can count them */
export const LINK_PROBLEM = 'Ссылка не импортирована';

export const emptyPlan = (): LinkPlan => ({ add: [], update: [], conflicts: [], kept: [], missing: [], unchanged: 0 });

/** anything for the preview to show (kept manual duplicates alone are not a change) */
export const planHasChanges = (p: LinkPlan | null | undefined) => !!p && (p.add.length + p.update.length + p.conflicts.length + p.missing.length) > 0;

export function planLinks(source: SourceLink[], existing: ExistingLink[], sourceId: string): LinkPlan {
  const plan = emptyPlan();
  const byUrl = new Map(existing.map((l) => [l.url, l]));
  const inSource = new Set<string>();
  for (const s of source) {
    if (inSource.has(s.url)) continue;
    inSource.add(s.url);
    const cur = byUrl.get(s.url);
    if (!cur) {
      plan.add.push(s);
      continue;
    }
    const mine = cur.origin === 'import' && cur.source_id === sourceId;
    if (!mine) {
      plan.kept.push(s.url);
      continue;
    }
    if (cur.kind === s.kind) {
      plan.unchanged++;
      continue;
    }
    if (cur.locally_edited) plan.conflicts.push({ id: cur.id, url: cur.url, local: cur.kind, source: s.kind, column: s.column });
    else plan.update.push({ id: cur.id, url: cur.url, from: cur.kind, to: s.kind, column: s.column });
  }
  for (const l of existing) {
    // a hand-edited imported link belongs to the user now: never reported as missing
    if (l.origin === 'import' && l.source_id === sourceId && !l.locally_edited && !inSource.has(l.url)) plan.missing.push({ id: l.id, url: l.url, kind: l.kind });
  }
  return plan;
}

// ───────────── reading link cells ─────────────

const KIND_ALIASES: Record<string, LinkKind> = {
  jira: 'jira', 'джира': 'jira',
  bitrix24: 'bitrix24', bitrix: 'bitrix24', 'битрикс': 'bitrix24', 'битрикс24': 'bitrix24', b24: 'bitrix24',
  docs: 'docs', doc: 'docs', 'документация': 'docs', confluence: 'docs', wiki: 'docs',
  other: 'other', 'другое': 'other',
};

export function parseKind(raw: string): LinkKind | null {
  const k = raw.trim().toLowerCase();
  if ((LINK_KINDS as readonly string[]).includes(k)) return k as LinkKind;
  return KIND_ALIASES[k] ?? null;
}

/**
 * One cell of a link column: every URL in its text plus hyperlinks hidden behind the text (Google metadata).
 * `kind` — the kind of the column; undefined → guessed per URL (URLs found in free text).
 * A non-empty cell without any URL is reported (never silently dropped); `strict` = the column is a link column.
 */
export function readLinkCell(text: string, hyperlinks: string[], column: string, kind: LinkKind | undefined, strict: boolean): { links: SourceLink[]; problems: string[] } {
  const links: SourceLink[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const push = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ kind: kind ?? guessKind(url), url, column });
  };
  for (const u of extractUrls(text)) push(u);
  for (const raw of hyperlinks) {
    const c = checkUrl(raw);
    if (c.ok) push(c.url);
    else if (strict) problems.push(`Ссылка не импортирована — колонка «${column}», гиперссылка: ${c.error}`);
  }
  const t = text.trim();
  if (strict && t && !links.length) {
    problems.push(`Ссылка не импортирована — колонка «${column}»: «${t.slice(0, 80)}» не адрес (нужна ссылка, начинающаяся с https:// или http://)`);
  } else if (strict && /(?:^|\s)(?!https?:)[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    problems.push(`Ссылка не импортирована — колонка «${column}»: часть адресов не https:// или http://`);
  }
  return { links, problems };
}

/** canonical `links` cell: one link per line, «kind<TAB>url<TAB>column» */
export function encodeLinks(links: SourceLink[]): string {
  return links.map((l) => `${l.kind}\t${l.url}\t${l.column}`).join('\n');
}

/**
 * canonical `links` cell back to links. Lines may also be written by hand in a template sheet:
 * «https://…» (kind guessed) or «jira https://…» / «Jira: https://…».
 */
export function decodeLinks(cell: string, column = 'links'): { links: SourceLink[]; problems: string[] } {
  const links: SourceLink[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const line of cell.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split('\t');
    let kind: LinkKind | null = null;
    let rest = line;
    let col = column;
    if (parts.length >= 2) {
      kind = parseKind(parts[0]);
      rest = parts[1];
      col = parts[2] || column;
    } else {
      const m = /^([^\s:]+)\s*:?\s+(\S.*)$/.exec(line);
      if (m && parseKind(m[1])) {
        kind = parseKind(m[1]);
        rest = m[2];
      }
    }
    const urls = extractUrls(rest);
    if (!urls.length) {
      problems.push(`Ссылка не импортирована — колонка «${col}»: «${line.slice(0, 80)}» не адрес`);
      continue;
    }
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      links.push({ kind: kind ?? guessKind(u), url: u, column: col });
    }
  }
  return { links, problems };
}

/** preview summary over all rows: what the import will do with external links */
export function linkSummary(items: { action: string; payload: Record<string, any>; warnings: string[]; resolution: { mode?: string; links?: LinkChoice } | null }[]) {
  const out = { add: 0, update: 0, conflicts: 0, missing: 0, remove: 0, invalid: 0, on_undecided_rows: 0, rows: 0 };
  for (const it of items) {
    out.invalid += it.warnings.filter((w) => w.startsWith(LINK_PROBLEM)).length;
    if (it.resolution?.mode === 'skip') continue;
    const p = it.payload.link_plan as LinkPlan | undefined;
    if (it.action === 'duplicate' && (it.payload.links?.length ?? 0) > 0) { out.on_undecided_rows += it.payload.links.length; continue; }
    if (!p) continue;
    if (planHasChanges(p)) out.rows++;
    out.add += p.add.length;
    out.update += p.update.length;
    out.conflicts += p.conflicts.length;
    out.missing += p.missing.length;
    out.remove += (it.resolution?.links?.remove ?? []).length;
  }
  return out;
}

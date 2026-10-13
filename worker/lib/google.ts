// Google Sheets client for Workers (service-account JWT signed with WebCrypto).
// Import uses only `spreadsheets.readonly`. The manual export (FR-08) requests the write scope separately,
// and writes only to the «Import» tab of the spreadsheet configured by an administrator.

import type { Env } from '../env';
import { parseCsv } from '../domain/csv';
import { b64url } from './crypto';
import { HttpError } from './http';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const enc = new TextEncoder();

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function serviceAccount(env: Env): ServiceAccount | null {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const tokenCache = new Map<string, { token: string; exp: number; email: string }>();

async function accessToken(env: Env, sa: ServiceAccount, scope = SCOPE): Promise<string> {
  const cached = tokenCache.get(scope);
  if (cached && cached.email === sa.client_email && cached.exp > Date.now() + 60_000) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope, aud, iat, exp: iat + 3600 })));
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const doFetch = env.__FETCH ?? fetch;
  const res = await doFetch(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!res.ok) throw new HttpError(502, 'google_auth', `Google отклонил ключ сервисного аккаунта (HTTP ${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(scope, { token: data.access_token, exp: Date.now() + data.expires_in * 1000, email: sa.client_email });
  return data.access_token;
}

export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(s);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null;
}

export interface SheetFetchResult {
  title: string | null;
  available: string[];
  data: Record<string, string[][]>; // sheet name → rows
  mode: 'service_account' | 'public_link';
  /** sheet name → grid of URLs hidden behind cell text (only the requested link columns; service account only) */
  hyperlinks?: Record<string, string[][]>;
}

const normHeader = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
function colLetter(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

interface GridCell {
  hyperlink?: string;
  textFormatRuns?: { format?: { link?: { uri?: string } } }[];
  chipRuns?: { chip?: { richLinkProperties?: { uri?: string } } }[];
}

/**
 * Hyperlinks hidden behind the text of the given columns (Google Sheets metadata only — nothing behind a link is
 * ever requested). Cell-level links, rich-text links and smart chips are read. Older API deployments may not know
 * `chipRuns`; then the request is repeated without it.
 */
async function fetchHyperlinks(env: Env, token: string, spreadsheetId: string, sheet: string, columns: number[]): Promise<string[][]> {
  const grid: string[][] = [];
  if (!columns.length) return grid;
  const ranges = columns.map((c) => `ranges=${encodeURIComponent(`'${sheet.replace(/'/g, "''")}'!${colLetter(c)}:${colLetter(c)}`)}`).join('&');
  const fields = (chips: boolean) =>
    `sheets(data(startRow,startColumn,rowData(values(hyperlink,textFormatRuns(format(link(uri)))${chips ? ',chipRuns(chip(richLinkProperties(uri)))' : ''}))))`;
  const url = (chips: boolean) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?${ranges}&includeGridData=true&fields=${encodeURIComponent(fields(chips))}`;
  let res = await googleGet(env, url(true), token);
  if (res.status === 400) res = await googleGet(env, url(false), token);
  if (!res.ok) throw new HttpError(502, 'google_unavailable', `Не удалось прочитать гиперссылки листа «${sheet}» (HTTP ${res.status}). Данные в системе не изменены.`);
  const body = (await res.json()) as { sheets?: { data?: { startRow?: number; startColumn?: number; rowData?: { values?: GridCell[] }[] }[] }[] };
  for (const d of body.sheets?.[0]?.data ?? []) {
    const r0 = d.startRow ?? 0;
    const c0 = d.startColumn ?? 0;
    (d.rowData ?? []).forEach((row, ri) => {
      (row.values ?? []).forEach((cell, ci) => {
        const uris = new Set<string>();
        if (cell.hyperlink) uris.add(cell.hyperlink);
        for (const run of cell.textFormatRuns ?? []) if (run.format?.link?.uri) uris.add(run.format.link.uri);
        for (const run of cell.chipRuns ?? []) if (run.chip?.richLinkProperties?.uri) uris.add(run.chip.richLinkProperties.uri);
        if (!uris.size) return;
        const r = r0 + ri;
        const c = c0 + ci;
        (grid[r] ??= [])[c] = [...uris].join('\n');
      });
    });
  }
  return grid;
}

async function googleGet(env: Env, url: string, token: string | null) {
  const doFetch = env.__FETCH ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new HttpError(502, 'google_unavailable', 'Google Sheets недоступен. Данные в системе не изменены — попробуйте позже.');
  }
  return res;
}

/**
 * Reads the given sheets. Missing sheets are reported in `available` (not an error by themselves).
 * Without a service account only spreadsheets shared "anyone with the link can view" can be read.
 */
export async function fetchSpreadsheet(env: Env, spreadsheetId: string, sheetNames: string[], opts: { linkColumns?: Record<string, string[]> } = {}): Promise<SheetFetchResult> {
  const sa = serviceAccount(env);
  if (sa) {
    const token = await accessToken(env, sa);
    const metaRes = await googleGet(env, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`, token);
    if (metaRes.status === 403 || metaRes.status === 404) {
      throw new HttpError(502, 'google_access', `Нет доступа к таблице. Откройте доступ «Читатель» для ${sa.client_email}`);
    }
    if (!metaRes.ok) throw new HttpError(502, 'google_unavailable', `Google Sheets вернул ошибку ${metaRes.status}. Данные в системе не изменены.`);
    const meta = (await metaRes.json()) as { properties?: { title?: string }; sheets?: { properties: { title: string } }[] };
    const available = (meta.sheets ?? []).map((s) => s.properties.title);
    const wanted = sheetNames.filter((n) => available.includes(n));
    const data: Record<string, string[][]> = {};
    if (wanted.length) {
      const qs = wanted.map((n) => `ranges=${encodeURIComponent(`'${n.replace(/'/g, "''")}'`)}`).join('&');
      const valRes = await googleGet(
        env,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
        token,
      );
      if (!valRes.ok) throw new HttpError(502, 'google_unavailable', `Не удалось прочитать листы (HTTP ${valRes.status}). Данные в системе не изменены.`);
      const vals = (await valRes.json()) as { valueRanges?: { values?: unknown[][] }[] };
      (vals.valueRanges ?? []).forEach((vr, i) => {
        data[wanted[i]] = (vr.values ?? []).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
      });
    }
    // URLs hidden behind cell text, only for the columns the source maps to links
    const hyperlinks: Record<string, string[][]> = {};
    for (const [sheet, headers] of Object.entries(opts.linkColumns ?? {})) {
      const head = (data[sheet]?.[0] ?? []).map((h) => normHeader(h));
      const wantedCols = [...new Set(headers.map(normHeader))].flatMap((h) => head.flatMap((x, i) => (x === h ? [i] : [])));
      if (wantedCols.length) hyperlinks[sheet] = await fetchHyperlinks(env, token, spreadsheetId, sheet, wantedCols);
    }
    return { title: meta.properties?.title ?? null, available, data, mode: 'service_account', hyperlinks };
  }

  // Public-link fallback (CSV export of each sheet)
  const data: Record<string, string[][]> = {};
  const available: string[] = [];
  for (const name of sheetNames) {
    const res = await googleGet(env, `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`, null);
    if (res.status === 401 || res.status === 403 || res.redirected) {
      throw new HttpError(502, 'google_access', 'Таблица закрыта. Настройте сервисный аккаунт (секрет GOOGLE_SERVICE_ACCOUNT_JSON) и откройте ему доступ на чтение.');
    }
    if (!res.ok) continue;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('csv')) {
      throw new HttpError(502, 'google_access', 'Таблица закрыта. Настройте сервисный аккаунт (секрет GOOGLE_SERVICE_ACCOUNT_JSON) и откройте ему доступ на чтение.');
    }
    const text = await res.text();
    const rows = parseCsv(text);
    // gviz returns the first sheet when the name does not exist — detect by header mismatch later
    available.push(name);
    data[name] = rows;
  }
  return { title: null, available, data, mode: 'public_link' };
}


export const EXPORT_SHEET = 'Import';

/**
 * Replaces the content of the «Import» tab in ONE spreadsheets.batchUpdate (atomic on Google's side):
 * clear the tab, then write the rows. Other tabs are never addressed. Values are written as literal
 * strings / numbers (userEnteredValue.stringValue), so nothing is interpreted as a formula.
 */
export async function writeImportTab(env: Env, spreadsheetId: string, rows: (string | number | null | undefined)[][]): Promise<{ sheetTitle: string }> {
  return writeTab(env, spreadsheetId, rows, EXPORT_SHEET, false);
}

/**
 * Same as writeImportTab for any tab title. With `create`, a missing tab is added in the same batchUpdate
 * (vNext export builder: a template writes to its own tab «Экспорт — <name>»). Other tabs are never addressed.
 */
export async function writeTab(env: Env, spreadsheetId: string, rows: (string | number | null | undefined)[][], title: string, create: boolean): Promise<{ sheetTitle: string }> {
  const sa = serviceAccount(env);
  if (!sa) throw new HttpError(400, 'no_service_account', 'Сервисный аккаунт Google не настроен (секрет GOOGLE_SERVICE_ACCOUNT_JSON)');
  const token = await accessToken(env, sa, WRITE_SCOPE);
  const doFetch = env.__FETCH ?? fetch;
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const meta = await doFetch(`${base}?fields=sheets.properties(sheetId,title,gridProperties)`, { headers: { authorization: `Bearer ${token}` } });
  if (meta.status === 403 || meta.status === 404) {
    throw new HttpError(400, 'google_no_access', `Нет доступа к таблице экспорта. Откройте её сервисному аккаунту ${sa.client_email} с ролью «Редактор».`);
  }
  if (!meta.ok) throw new HttpError(502, 'google_unavailable', `Google Sheets ответил HTTP ${meta.status}. Таблица не изменена.`);
  const info = (await meta.json()) as { sheets?: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] };
  const tab = (info.sheets ?? []).find((x) => x.properties.title === title);
  if (!tab && !create) throw new HttpError(400, 'google_no_import_tab', `В таблице нет вкладки «${title}». Создайте её — другие вкладки экспорт не трогает.`);
  const width = Math.max(1, ...rows.map((r) => r.length));
  const needRows = rows.length + 1;
  const requests: unknown[] = [];
  let sheetId: number;
  if (!tab) {
    const taken = new Set((info.sheets ?? []).map((x) => x.properties.sheetId));
    sheetId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    while (taken.has(sheetId)) sheetId++;
    requests.push({ addSheet: { properties: { sheetId, title, gridProperties: { rowCount: Math.max(1000, needRows), columnCount: Math.max(26, width), frozenRowCount: 1 } } } });
  } else sheetId = tab.properties.sheetId;
  const grid = tab?.properties.gridProperties ?? { rowCount: Math.max(1000, needRows), columnCount: Math.max(26, width) };
  if (tab && ((grid.rowCount ?? 0) < needRows || (grid.columnCount ?? 0) < width)) {
    requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(grid.rowCount ?? 0, needRows), columnCount: Math.max(grid.columnCount ?? 0, width) } }, fields: 'gridProperties(rowCount,columnCount)' } });
  }
  requests.push({ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } }); // clear the whole tab
  requests.push({
    updateCells: {
      start: { sheetId, rowIndex: 0, columnIndex: 0 },
      fields: 'userEnteredValue',
      rows: rows.map((r) => ({
        values: r.map((v) => (v === null || v === undefined || v === '' ? {} : typeof v === 'number' ? { userEnteredValue: { numberValue: v } } : { userEnteredValue: { stringValue: String(v) } })),
      })),
    },
  });
  const res = await doFetch(`${base}:batchUpdate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (res.status === 403) throw new HttpError(400, 'google_no_access', `Сервисному аккаунту ${sa.client_email} нужна роль «Редактор» в таблице экспорта.`);
  if (!res.ok) throw new HttpError(502, 'google_write_failed', `Google Sheets не принял данные (HTTP ${res.status}). Изменение отменено целиком.`);
  return { sheetTitle: title };
}

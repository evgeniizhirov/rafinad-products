// Google Sheets read-only client for Workers (service-account JWT signed with WebCrypto).
// Only the `spreadsheets.readonly` scope is ever requested.

import type { Env } from '../env';
import { parseCsv } from '../domain/csv';
import { b64url } from './crypto';
import { HttpError } from './http';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
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

let tokenCache: { token: string; exp: number; email: string } | null = null;

async function accessToken(env: Env, sa: ServiceAccount): Promise<string> {
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 })));
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
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000, email: sa.client_email };
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
export async function fetchSpreadsheet(env: Env, spreadsheetId: string, sheetNames: string[]): Promise<SheetFetchResult> {
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
    return { title: meta.properties?.title ?? null, available, data, mode: 'service_account' };
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

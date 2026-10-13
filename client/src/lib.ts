// API client, data hooks, router, formatting helpers.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Ошибка ${res.status}`, e?.details ?? null);
  }
  return data as T;
}

// ───── cache invalidation bus: every successful write refreshes visible data ─────
const bus = new EventTarget();
export function invalidate() {
  bus.dispatchEvent(new Event('invalidate'));
}

export function useApi<T = any>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const h = () => setTick((t) => t + 1);
    bus.addEventListener('invalidate', h);
    return () => bus.removeEventListener('invalidate', h);
  }, []);
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((d) => alive && setState({ data: d, error: null, loading: false }))
      .catch((e) => alive && setState((s) => ({ data: s.data, error: e, loading: false })));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ───── toasts ─────
export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}
const toastBus = new EventTarget();
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  toastBus.dispatchEvent(new CustomEvent('toast', { detail: { id: ++toastId, text, kind } }));
}
export function useToasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent).detail as Toast;
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.kind === 'error' ? 7000 : 3500);
    };
    toastBus.addEventListener('toast', h);
    return () => toastBus.removeEventListener('toast', h);
  }, []);
  return { list, dismiss: (id: number) => setList((l) => l.filter((x) => x.id !== id)) };
}

/** Runs a write; on success invalidates data and optionally toasts; on error shows the server message. */
export async function mutate<T = any>(path: string, method: string, body?: unknown, okText?: string): Promise<T | null> {
  try {
    const r = await api<T>(path, { method, body });
    invalidate();
    if (okText) toast(okText);
    return r;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && ['overload', 'approved'].includes(e.code)) throw e; // handled by caller
    toast(e instanceof Error ? e.message : 'Ошибка', 'error');
    if (e instanceof ApiError && e.code === 'version_conflict') invalidate();
    return null;
  }
}

// ───── router ─────
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const [loc, setLoc] = useState({ path: location.pathname, search: location.search });
  useEffect(() => {
    const h = () => setLoc({ path: location.pathname, search: location.search });
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  return loc;
}

export function useQueryParam(name: string): [string | null, (v: string | null) => void] {
  const { search } = useLocation();
  const value = new URLSearchParams(search).get(name);
  const set = useCallback(
    (v: string | null) => {
      const p = new URLSearchParams(location.search);
      if (v === null || v === '') p.delete(name);
      else p.set(name, v);
      const qs = p.toString();
      navigate(`${location.pathname}${qs ? `?${qs}` : ''}`);
    },
    [name],
  );
  return [value, set];
}

/** opens the feature card drawer on top of the current page */
export function openFeature(key: string) {
  const p = new URLSearchParams(location.search);
  p.set('f', key);
  navigate(`${location.pathname}?${p.toString()}`);
}

// ───── session & dictionaries ─────
export interface Me {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'product' | 'department_lead';
  department_ids: string[];
  must_change_password: boolean;
  permissions: { edit_catalog: boolean; plan: boolean; import: boolean; admin: boolean; comment: boolean };
}

export interface Meta {
  departments: any[];
  teams: any[];
  categories: any[];
  statuses: any[];
  stages: any[];
  settings: { public_show_estimates: boolean };
  viewer: 'guest' | 'employee' | 'editor';
}

export interface AppState {
  me: Me | null;
  meta: Meta;
  refreshMe: () => void;
}

export const AppCtx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppCtx);

export function useDict() {
  const { meta } = useApp();
  return {
    team: (id: string) => meta.teams.find((t) => t.id === id),
    dept: (id: string) => meta.departments.find((d) => d.id === id),
    activeTeams: meta.teams.filter((t) => t.is_active),
    activeDepts: meta.departments.filter((d) => d.is_active),
    statuses: (entity: string) => meta.statuses.filter((s) => s.entity === entity && s.is_active),
  };
}

// ───── formatting ─────
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function fmtDate(iso: string | null | undefined, withYear = true): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${s} ${d.getUTCFullYear()}` : s;
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export const fmtH = (h: number | null | undefined) => (h === null || h === undefined ? '—' : `${Math.round(h * 10) / 10} ч`);
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const today = () => new Date().toISOString().slice(0, 10);

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onOutside();
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onOutside]);
  return ref;
}

export const VISIBILITY_LABEL: Record<string, string> = { public: 'Опубликована', internal: 'Внутренняя', draft: 'Черновик' };
export const ROLE_LABEL: Record<string, string> = { admin: 'Администратор', product: 'Продуктовая команда', department_lead: 'Руководитель отдела' };

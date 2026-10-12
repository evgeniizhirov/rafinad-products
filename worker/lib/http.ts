import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { Env } from '../env';
import type { SessionUser } from './auth';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Требуется вход в систему') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав для этого действия') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Не найдено') => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  user: SessionUser | null;
  /** cookies to set on the response */
  setCookies: string[];
  waitUntil?: (p: Promise<unknown>) => void;
}

export type Handler = (ctx: Ctx) => Promise<Response | unknown> | Response | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }
  get(path: string, h: Handler) { return this.on('GET', path, h); }
  post(path: string, h: Handler) { return this.on('POST', path, h); }
  put(path: string, h: Handler) { return this.on('PUT', path, h); }
  patch(path: string, h: Handler) { return this.on('PATCH', path, h); }
  delete(path: string, h: Handler) { return this.on('DELETE', path, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = r.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.status);
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return json({ error: { code: 'validation', message: 'Некорректные данные запроса', details: issues } }, 400);
  }
  console.error('Unhandled error', err);
  return json({ error: { code: 'internal', message: 'Внутренняя ошибка сервера' } }, 500);
}

const MAX_BODY = 2_000_000; // 2 MB — enough for CSV uploads, protects the worker

export async function readJson<S extends ZodTypeAny>(ctx: Ctx, schema: S): Promise<z.infer<S>> {
  const ct = ctx.req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw badRequest('Ожидается JSON (Content-Type: application/json)');
  const len = Number(ctx.req.headers.get('content-length') || '0');
  if (len > MAX_BODY) throw new HttpError(413, 'too_large', 'Слишком большой запрос');
  const text = await ctx.req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large', 'Слишком большой запрос');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Некорректный JSON');
  }
  return schema.parse(raw);
}

export function queryParam(ctx: Ctx, name: string): string | undefined {
  const v = ctx.url.searchParams.get(name);
  return v === null || v === '' ? undefined : v;
}

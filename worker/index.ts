import type { Env } from './env';
import { loadSessionUser } from './lib/auth';
import { errorResponse, forbidden, HttpError, json, Router, type Ctx } from './lib/http';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerCalendarRoutes } from './routes/calendar';
import { registerCatalogRoutes } from './routes/catalog';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerFeatureRoutes } from './routes/features';
import { registerImportRoutes } from './routes/imports';
import { registerMergeRoutes } from './routes/merge';
import { registerPlanningRoutes } from './routes/planning';
import { registerPriorityRoutes } from './routes/priorities';
import { registerReleaseRoutes } from './routes/releases';

export const router = new Router();
registerAuthRoutes(router);
registerDashboardRoutes(router);
registerFeatureRoutes(router);
registerMergeRoutes(router);
registerPriorityRoutes(router);
registerCatalogRoutes(router);
registerReleaseRoutes(router);
registerCalendarRoutes(router);
registerPlanningRoutes(router);
registerImportRoutes(router);
registerAdminRoutes(router);

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function withHeaders(res: Response, extra: Record<string, string> = {}, cookies: string[] = []): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  for (const c of cookies) out.headers.append('set-cookie', c);
  return out;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const ctx: Ctx = { req, env, url, params: {}, user: null, setCookies: [] };
  try {
    // CSRF defence in depth (cookies are SameSite=Lax): cross-origin writes are rejected
    if (MUTATING.has(req.method)) {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) throw forbidden('Запрос с другого сайта отклонён');
    }
    const m = router.match(req.method, url.pathname);
    if (m === null) throw new HttpError(404, 'not_found', 'Неизвестный адрес API');
    if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Метод не поддерживается');
    ctx.params = m.params;
    ctx.user = await loadSessionUser(env, req);
    const out = await m.handler(ctx);
    const res = out instanceof Response ? out : json(out);
    return withHeaders(res, {}, ctx.setCookies);
  } catch (err) {
    return withHeaders(errorResponse(err), {}, ctx.setCookies);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
    if (!env.ASSETS) return new Response('Static assets are not configured', { status: 500 });
    const res = await env.ASSETS.fetch(req);
    const isHtml = (res.headers.get('content-type') || '').includes('text/html');
    return withHeaders(res, isHtml ? { 'cache-control': 'no-cache' } : {});
  },
};

import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticate, challenge, validateConfig, type Env } from './auth';
import { AuthError, classify, logAuthFailure } from './auth-policy';
import { Roadmap, type Fetch } from './roadmap';
import { createServer } from './tools';
import type { JWTVerifyGetKey } from 'jose';

const DISCOVERY = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
/** browser origins allowed to call the server (ChatGPT web); requests without Origin (server-to-server) are not CORS */
const CHATGPT_ORIGINS = ['https://chatgpt.com', 'https://chat.openai.com'];
const CORS_HEADERS = {
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '600',
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });

function withCors(response: Response, origin: string | null) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.append('vary', 'Origin');
  for (const [k, v] of Object.entries(CORS_HEADERS)) if (k !== 'access-control-max-age') headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Dependency injection is available only to local tests, never from Worker bindings or requests.
export async function handle(request: Request, env: Env, deps: { keys?: JWTVerifyGetKey; fetcher?: Fetch } = {}) {
  try { validateConfig(env); } catch { return json({ error: 'integration_not_configured' }, 503); }
  const url = new URL(request.url);
  const resource = new URL(env.MCP_RESOURCE);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!local && url.origin !== resource.origin) return json({ error: 'invalid_host' }, 403);
  const origin = request.headers.get('origin');
  const allowed = [resource.origin, ...CHATGPT_ORIGINS, ...(local ? [url.origin] : [])];
  if (origin && !allowed.includes(origin)) return json({ error: 'invalid_origin' }, 403);
  const known = url.pathname === '/mcp' || DISCOVERY.includes(url.pathname);

  // CORS preflight: never authenticated (browsers do not send credentials on it)
  if (request.method === 'OPTIONS') {
    if (!known) return json({ error: 'not_found' }, 404);
    return new Response(null, { status: 204, headers: { ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin', ...CORS_HEADERS } : {}), 'cache-control': 'no-store' } });
  }

  // OAuth protected resource metadata (RFC 9728): public, no bearer
  if (DISCOVERY.includes(url.pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return withCors(json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD, OPTIONS' }), origin);
    return withCors(json({
      resource: env.MCP_RESOURCE,
      authorization_servers: [env.OAUTH_ISSUER],
      scopes_supported: env.ENABLE_WRITES === 'true' ? ['roadmap:read', 'roadmap:write'] : ['roadmap:read'],
      bearer_methods_supported: ['header'],
    }), origin);
  }
  if (url.pathname !== '/mcp') return json({ error: 'not_found' }, 404);

  let auth;
  try { auth = await authenticate(request, env, deps.keys); } catch (e) {
    const reason = e instanceof AuthError ? e.reason : classify(e);
    logAuthFailure(env.AUTH_DIAGNOSTICS, reason);
    return withCors(json({ error: 'unauthorized' }, 401, { 'www-authenticate': challenge(env, reason !== 'missing_token') }), origin);
  }
  try {
    // Service binding avoids disallowed Worker-to-Worker fetches over workers.dev.
    // Tests may inject a stub fetcher, but production never falls back to global fetch.
    const fetcher = deps.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => env.ROADMAP_API.fetch(input, init));
    const api = new Roadmap(env.RAFINAD_API_KEY, fetcher);
    const handler = createMcpHandler(() => createServer(api, auth.canWrite));
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return withCors(new Response(response.body, { status: response.status, headers }), origin);
  } catch { return withCors(json({ error: 'integration_error' }, 500), origin); }
}
export default { fetch: (request: Request, env: Env) => handle(request, env) };

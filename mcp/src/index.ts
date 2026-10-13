import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticate, challenge, validateConfig, type Env } from './auth';
import { Roadmap, type Fetch } from './roadmap';
import { createServer } from './tools';
import type { JWTVerifyGetKey } from 'jose';

const json = (data: unknown, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
// Dependency injection is available only to local tests, never from Worker bindings or requests.
export async function handle(request: Request, env: Env, deps: { keys?: JWTVerifyGetKey; fetcher?: Fetch } = {}) {
  try { validateConfig(env); } catch { return json({ error: 'integration_not_configured' }, 503); }
  const url = new URL(request.url);
  const resource = new URL(env.MCP_RESOURCE);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!local && url.origin !== resource.origin) return json({ error: 'invalid_host' }, 403);
  const origin = request.headers.get('origin');
  if (origin && ![resource.origin, 'https://chatgpt.com', ...(local ? [url.origin] : [])].includes(origin)) return json({ error: 'invalid_origin' }, 403);
  if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
    return json({ resource: env.MCP_RESOURCE, authorization_servers: [env.OAUTH_ISSUER], scopes_supported: env.ENABLE_WRITES === 'true' ? ['roadmap:read', 'roadmap:write'] : ['roadmap:read'], bearer_methods_supported: ['header'] });
  }
  if (url.pathname !== '/mcp') return json({ error: 'not_found' }, 404);
  let auth;
  try { auth = await authenticate(request, env, deps.keys); } catch {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': challenge(env) });
  }
  try {
    const api = new Roadmap(env.RAFINAD_API_KEY, deps.fetcher);
    const handler = createMcpHandler(() => createServer(api, auth.canWrite));
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  } catch { return json({ error: 'integration_error' }, 500); }
}
export default { fetch: (request: Request, env: Env) => handle(request, env) };

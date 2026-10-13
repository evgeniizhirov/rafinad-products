#!/usr/bin/env node
// Transport diagnostics of the published MCP endpoint (no dependencies, Node ≥18):
//   node scripts/diagnose.mjs [https://…/mcp]
// Checks: OAuth protected-resource metadata, 401 + WWW-Authenticate without a token, CORS preflight from ChatGPT,
// and — only when MCP_ACCESS_TOKEN is set in the environment — initialize + tools/list with that token.
// The token is never printed; redirects are never followed.
const endpoint = new URL(process.argv[2] ?? process.env.MCP_URL ?? 'https://rafinad-roadmap-mcp.ezhirov-es.workers.dev/mcp');
const token = process.env.MCP_ACCESS_TOKEN;
let failed = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++; };
const req = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init });

const meta = await req(new URL('/.well-known/oauth-protected-resource/mcp', endpoint));
let body = null;
try { body = await meta.json(); } catch { /* reported below */ }
ok('discovery /.well-known/oauth-protected-resource/mcp', meta.status === 200 && body?.resource === endpoint.href, `HTTP ${meta.status}${meta.status === 503 ? ' (server not configured: check Cloudflare variables/secrets)' : ''}`);
if (body) ok('authorization_servers present', Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0, body.authorization_servers?.join(', '));

const anon = await req(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
const www = anon.headers.get('www-authenticate') ?? '';
ok('no token → 401', anon.status === 401, `HTTP ${anon.status}`);
ok('WWW-Authenticate points to resource metadata', /resource_metadata="[^"]+oauth-protected-resource\/mcp"/.test(www));

const pre = await req(endpoint, { method: 'OPTIONS', headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, mcp-protocol-version' } });
ok('CORS preflight from https://chatgpt.com', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://chatgpt.com', `HTTP ${pre.status}`);

if (!token) {
  console.log('SKIP  initialize / tools/list — set MCP_ACCESS_TOKEN in a local environment variable to check an authorized session');
} else {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  const rpc = async (id, method, params = {}, extra = {}) => {
    const r = await req(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const raw = await r.text();
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    let data = null;
    try { data = JSON.parse(line ? line.slice(6) : raw); } catch { /* not JSON */ }
    return { r, data };
  };
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rafinad-diagnose', version: '1' } });
  ok('initialize with token', init.r.status === 200 && !!init.data?.result, `HTTP ${init.r.status}${init.r.status === 401 ? ' — token refused; enable AUTH_DIAGNOSTICS=true and run `wrangler tail` to see the category' : ''}`);
  const session = init.r.headers.get('mcp-session-id');
  const list = await rpc(2, 'tools/list', {}, session ? { 'mcp-session-id': session } : {});
  ok('tools/list', list.r.status === 200 && Array.isArray(list.data?.result?.tools), `${list.data?.result?.tools?.length ?? 0} tools`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);

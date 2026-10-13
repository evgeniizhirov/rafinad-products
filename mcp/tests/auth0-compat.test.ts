// Auth0 compatibility: a real Auth0 custom-API access token lives 24 h, carries azp (no client_id), an audience array
// and openid scopes. Discovery and CORS preflight must work without a bearer token.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/index';
import { classify, maxTokenAge } from '../src/auth-policy';
import { env, keys, token } from './helpers';

const now = () => Math.floor(Date.now() / 1000);
const auth0 = (claims: Record<string, unknown> = {}) => token({
  client_id: undefined, azp: env.OAUTH_CLIENT_ID, aud: [env.MCP_RESOURCE, 'https://identity.test/userinfo'],
  scope: 'openid profile email roadmap:read', iat: now(), exp: now() + 86400, ...claims,
});
const call = async (bearer: string | undefined, override = {}) => handle(new Request(env.MCP_RESOURCE, {
  method: 'POST',
  headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
}), { ...env, ...override }, { keys, fetcher: async () => Response.json({}) });

test('a default Auth0 access token (24 h, azp, audience array, openid scopes) is accepted', async () => {
  const res = await call(await auth0());
  assert.equal(res.status, 200, await res.clone().text());
});

test('the lifetime ceiling stays bounded and configurable; longer or older tokens are refused', async () => {
  assert.equal(maxTokenAge(undefined), 86400);
  assert.equal(maxTokenAge(''), 86400);
  assert.equal(maxTokenAge('900'), 900);
  for (const bad of ['299', '86401', 'abc', '-5', '1e3']) assert.throws(() => maxTokenAge(bad));
  assert.equal((await call(await auth0({ exp: now() + 86400 * 7 }))).status, 401, 'a week-long token');
  assert.equal((await call(await auth0(), { OAUTH_MAX_TOKEN_AGE_SECONDS: '900' })).status, 401, 'stricter setting');
  assert.equal((await call(await auth0({ iat: now() - 86400 - 60, exp: now() + 60 }))).status, 401, 'issued too long ago');
  assert.equal((await call(await auth0(), { OAUTH_MAX_TOKEN_AGE_SECONDS: '5' })).status, 503, 'invalid setting fails closed');
});

test('failure categories are safe and specific; diagnostics log the category only', async () => {
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { logs.push(m); };
  try {
    const cases: [string | undefined, string][] = [
      [undefined, 'missing_token'],
      ['not-a-jwt', 'malformed_token'],
      [await auth0({ aud: 'https://other.test/mcp' }), 'audience_mismatch'],
      [await auth0({ iss: 'https://evil.test/' }), 'issuer_mismatch'],
      [await auth0({ azp: 'other-client' }), 'client_mismatch'],
      [await auth0({ sub: 'someone-else' }), 'owner_mismatch'],
      [await auth0({ scope: 'openid profile' }), 'missing_read_scope'],
      [await auth0({ iat: now() - 100, exp: now() - 50 }), 'expired'],
    ];
    for (const [bearer, reason] of cases) {
      logs.length = 0;
      const res = await call(bearer, { AUTH_DIAGNOSTICS: 'true' });
      assert.equal(res.status, 401, reason);
      assert.deepEqual(logs.map((l) => JSON.parse(l)), [{ event: 'mcp_auth_denied', reason }]);
      if (bearer) assert.ok(!logs.join().includes(bearer.slice(0, 20)), 'never logs the token');
      const www = res.headers.get('www-authenticate')!;
      assert.match(www, /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
      assert.equal(/error="invalid_token"/.test(www), reason !== 'missing_token');
    }
    logs.length = 0;
    await call(undefined);
    assert.equal(logs.length, 0, 'diagnostics are off by default');
  } finally { console.warn = warn; }
  assert.equal(classify({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'iat', reason: 'check_failed' }), 'token_too_old');
  assert.equal(classify(new Error('x')), 'invalid_token');
});

test('discovery without bearer and CORS for ChatGPT only', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const res = await handle(new Request(`https://mcp.test${path}`, { headers: { origin: 'https://chatgpt.com' } }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
    const body = await res.json() as any;
    assert.equal(body.resource, env.MCP_RESOURCE);
    assert.deepEqual(body.authorization_servers, [env.OAUTH_ISSUER]);
  }
  const pre = await handle(new Request(env.MCP_RESOURCE, { method: 'OPTIONS', headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, mcp-protocol-version' } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
  assert.match(pre.headers.get('access-control-allow-headers')!, /authorization/);
  assert.match(pre.headers.get('access-control-allow-headers')!, /mcp-protocol-version/);
  const denied = await handle(new Request(env.MCP_RESOURCE, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const unauth = await handle(new Request(env.MCP_RESOURCE, { method: 'POST', headers: { origin: 'https://chatgpt.com' } }), env);
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get('access-control-allow-origin'), 'https://chatgpt.com', 'the browser can read the 401 challenge');
  assert.match(unauth.headers.get('access-control-expose-headers')!, /www-authenticate/);
});

test('write scopes are only advertised when server writes are enabled', async () => {
  const endpoint = 'https://mcp.test/.well-known/oauth-protected-resource/mcp';
  for (const [enabled, expected] of [
    ['true', ['roadmap:read', 'roadmap:write']],
    ['false', ['roadmap:read']],
  ] as const) {
    const result = await handle(new Request(endpoint), { ...env, ENABLE_WRITES: enabled });
    assert.equal(result.status, 200);
    const metadata = await result.json() as { scopes_supported: string[] };
    assert.deepEqual(metadata.scopes_supported, expected);
  }
});

test('write-enabled OAuth challenge advertises both scopes for fresh connections', async () => {
  for (const [enabled, requiredScopes] of [
    ['true', 'roadmap:read roadmap:write'],
    ['false', 'roadmap:read'],
  ] as const) {
    const response = await handle(new Request(env.MCP_RESOURCE, { method: 'POST' }), { ...env, ENABLE_WRITES: enabled });
    assert.equal(response.status, 401);
    const challenge = response.headers.get('www-authenticate')!;
    assert.ok(challenge.includes(`scope="${requiredScopes}"`));
    assert.ok(!challenge.includes('error="invalid_token"'), 'initial authorization must not claim a missing token was invalid');
  }
});


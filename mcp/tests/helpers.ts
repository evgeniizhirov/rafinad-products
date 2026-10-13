import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import { handle } from '../src/index';
import type { Env } from '../src/auth';
import type { Fetch } from '../src/roadmap';

export const env: Env = {
  MCP_RESOURCE: 'https://mcp.test/mcp', OAUTH_ISSUER: 'https://identity.test/',
  OAUTH_JWKS_URL: 'https://identity.test/jwks', OAUTH_CLIENT_ID: 'chatgpt-test',
  OWNER_SUBJECT: 'owner', RAFINAD_API_KEY: 'fake-local-key', ENABLE_WRITES: 'true',
};
const pair = await generateKeyPair('ES256');
export const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'ES256' }] });
export async function token(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: env.OAUTH_ISSUER, aud: env.MCP_RESOURCE, sub: env.OWNER_SUBJECT, client_id: env.OAUTH_CLIENT_ID, scope: 'roadmap:read roadmap:write', iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' }).sign(pair.privateKey);
}
export async function harness(fetcher: Fetch, override: Partial<Env> = {}, claims: JWTPayload = {}) {
  const bearer = await token(claims);
  const config = { ...env, ...override };
  const request = (body: unknown, path = '/mcp') => handle(new Request(`https://mcp.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(body),
  }), config, { keys, fetcher });
  let sequence = 0;
  async function rpc(method: string, params: any = {}) {
    const response = await request({ jsonrpc: '2.0', id: ++sequence, method, params });
    const raw = await response.text();
    const data = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(raw.split('\n').find(x => x.startsWith('data: '))!.slice(6)) : JSON.parse(raw);
    return data;
  }
  async function call(name: string, args: any = {}) {
    const data = await rpc('tools/call', { name, arguments: args });
    if (!data.result) return { error: data.error, isError: true, value: data };
    let value;
    try { value = JSON.parse(data.result.content[0].text); } catch { value = data.result.content[0].text; }
    return { ...data.result, value };
  }
  return { rpc, call, request };
}

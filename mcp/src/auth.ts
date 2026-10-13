import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Env {
  MCP_RESOURCE: string;
  OAUTH_ISSUER: string;
  OAUTH_JWKS_URL: string;
  OAUTH_CLIENT_ID: string;
  OWNER_SUBJECT: string;
  RAFINAD_API_KEY: string;
  ENABLE_WRITES?: string;
}

export function validateConfig(env: Env) {
  for (const key of ['MCP_RESOURCE', 'OAUTH_ISSUER', 'OAUTH_JWKS_URL', 'OAUTH_CLIENT_ID', 'OWNER_SUBJECT', 'RAFINAD_API_KEY'] as const) {
    if (!env[key]?.trim()) throw new Error('Integration not configured');
  }
  for (const value of [env.MCP_RESOURCE, env.OAUTH_ISSUER, env.OAUTH_JWKS_URL]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('HTTPS configuration required');
  }
  if (new URL(env.MCP_RESOURCE).pathname !== '/mcp') throw new Error('Resource must end in /mcp');
}

const keySets = new Map<string, JWTVerifyGetKey>();
export async function authenticate(request: Request, env: Env, keys?: JWTVerifyGetKey) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match || match[1].length > 16384) throw new Error('Authentication required');
  if (!keys) {
    keys = keySets.get(env.OAUTH_JWKS_URL);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(env.OAUTH_JWKS_URL), { timeoutDuration: 5000 });
      keySets.set(env.OAUTH_JWKS_URL, keys);
    }
  }
  const { payload } = await jwtVerify(match[1], keys, {
    issuer: env.OAUTH_ISSUER, audience: env.MCP_RESOURCE,
    algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'],
    maxTokenAge: '15m', clockTolerance: 5,
  });
  if (payload.sub !== env.OWNER_SUBJECT) throw new Error('Owner access only');
  // Accept common access-token client claims, but never an ID token without scopes.
  const client = payload.client_id ?? payload.azp;
  if (client !== env.OAUTH_CLIENT_ID || (payload.azp !== undefined && payload.azp !== env.OAUTH_CLIENT_ID)) throw new Error('Invalid client');
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 900) throw new Error('Token lifetime too long');
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
  if (!scopes.includes('roadmap:read')) throw new Error('Read scope required');
  return { scopes, canWrite: env.ENABLE_WRITES === 'true' && scopes.includes('roadmap:write') };
}

export function challenge(env: Env) {
  return `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', env.MCP_RESOURCE)}", scope="roadmap:read", error="invalid_token"`;
}

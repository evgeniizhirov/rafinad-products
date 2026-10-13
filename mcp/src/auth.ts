import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AuthError, classify, maxTokenAge } from './auth-policy';

export interface Env {
  MCP_RESOURCE: string;
  OAUTH_ISSUER: string;
  OAUTH_JWKS_URL: string;
  OAUTH_CLIENT_ID: string;
  OWNER_SUBJECT: string;
  RAFINAD_API_KEY: string;
  ENABLE_WRITES?: string;
  /** optional, 300..86400; default 86400 (Auth0 custom API default access-token lifetime) */
  OAUTH_MAX_TOKEN_AGE_SECONDS?: string;
  /** optional; "true" logs only the category of a refused token (no token, claims or subject) */
  AUTH_DIAGNOSTICS?: string;
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
  maxTokenAge(env.OAUTH_MAX_TOKEN_AGE_SECONDS);
}

const keySets = new Map<string, JWTVerifyGetKey>();
export async function authenticate(request: Request, env: Env, keys?: JWTVerifyGetKey) {
  const header = request.headers.get('authorization');
  if (!header) throw new AuthError('missing_token');
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match || match[1].length > 16384) throw new AuthError('malformed_token');
  if (!keys) {
    keys = keySets.get(env.OAUTH_JWKS_URL);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(env.OAUTH_JWKS_URL), { timeoutDuration: 5000 });
      keySets.set(env.OAUTH_JWKS_URL, keys);
    }
  }
  const maxAge = maxTokenAge(env.OAUTH_MAX_TOKEN_AGE_SECONDS);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(match[1], keys, {
      issuer: env.OAUTH_ISSUER, audience: env.MCP_RESOURCE,
      algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'],
      maxTokenAge: maxAge, clockTolerance: 5,
    }));
  } catch (e) { throw new AuthError(classify(e)); }
  if (payload.sub !== env.OWNER_SUBJECT) throw new AuthError('owner_mismatch');
  // Accept common access-token client claims (Auth0: azp), but never an ID token without scopes.
  const client = payload.client_id ?? payload.azp;
  if (client !== env.OAUTH_CLIENT_ID || (payload.azp !== undefined && payload.azp !== env.OAUTH_CLIENT_ID)) throw new AuthError('client_mismatch');
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') throw new AuthError('missing_claim');
  if (payload.exp - payload.iat > maxAge) throw new AuthError('lifetime_too_long');
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  if (!scopes.includes('roadmap:read')) throw new AuthError('missing_read_scope');
  return { scopes, canWrite: env.ENABLE_WRITES === 'true' && scopes.includes('roadmap:write') };
}

/** RFC 6750 / RFC 9728: no error code when no token was sent; invalid_token when one was refused */
export function challenge(env: Env, tokenSent = true) {
  return `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', env.MCP_RESOURCE)}", scope="roadmap:read"${tokenSent ? ', error="invalid_token"' : ''}`;
}

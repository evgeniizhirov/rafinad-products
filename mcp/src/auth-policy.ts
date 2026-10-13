// OAuth token policy and safe classification of authorization failures.
// Auth0 custom APIs issue access tokens for 86400 s by default; a fixed 15-minute ceiling rejected every real token.
// The ceiling is bounded: 300…86400 s (OAUTH_MAX_TOKEN_AGE_SECONDS), default 86400. Every other check stays.

export const DEFAULT_MAX_TOKEN_AGE = 86400;
export const MIN_MAX_TOKEN_AGE = 300;
export const MAX_MAX_TOKEN_AGE = 86400;

/** seconds; an invalid setting is a configuration error (the server fails closed), never a silent default */
export function maxTokenAge(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_TOKEN_AGE;
  if (!/^\d+$/.test(raw.trim())) throw new Error('OAUTH_MAX_TOKEN_AGE_SECONDS must be an integer');
  const n = Number(raw.trim());
  if (n < MIN_MAX_TOKEN_AGE || n > MAX_MAX_TOKEN_AGE) throw new Error(`OAUTH_MAX_TOKEN_AGE_SECONDS must be ${MIN_MAX_TOKEN_AGE}..${MAX_MAX_TOKEN_AGE}`);
  return n;
}

export type AuthFailure =
  | 'missing_token' | 'malformed_token' | 'invalid_signature' | 'jwks_unavailable' | 'expired' | 'not_yet_valid'
  | 'token_too_old' | 'lifetime_too_long' | 'issuer_mismatch' | 'audience_mismatch' | 'missing_claim'
  | 'owner_mismatch' | 'client_mismatch' | 'missing_read_scope' | 'invalid_token';

/** carries only a category — never the token, claims or subject */
export class AuthError extends Error {
  constructor(public reason: AuthFailure) { super('Unauthorized'); }
}

/** maps a jose / verification error to a category without reading anything sensitive from it */
export function classify(e: unknown): AuthFailure {
  if (e instanceof AuthError) return e.reason;
  const err = e as { code?: string; claim?: string; reason?: string; name?: string };
  switch (err?.code) {
    case 'ERR_JWT_EXPIRED': return 'expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JOSE_ALG_NOT_ALLOWED': return 'invalid_signature';
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_INVALID': return 'jwks_unavailable';
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID': return 'malformed_token';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (err.claim === 'iss') return 'issuer_mismatch';
      if (err.claim === 'aud') return 'audience_mismatch';
      if (err.claim === 'nbf') return 'not_yet_valid';
      if (err.claim === 'iat') return err.reason === 'missing' ? 'missing_claim' : 'token_too_old';
      return err.reason === 'missing' ? 'missing_claim' : 'invalid_token';
    default: return 'invalid_token';
  }
}

/** opt-in diagnostics: one line with the category only (no token, claims, subject or headers) */
export function logAuthFailure(enabled: string | undefined, reason: AuthFailure) {
  if (enabled === 'true') console.warn(JSON.stringify({ event: 'mcp_auth_denied', reason }));
}

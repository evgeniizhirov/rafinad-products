// Password hashing and token helpers built on WebCrypto (works in Workers and Node ≥ 20).
//
// Hash format: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
// Cloudflare Workers cap PBKDF2 at 100 000 iterations; the format is versioned so the
// algorithm can be upgraded later (re-hash on next successful login).

const enc = new TextEncoder();
export const PBKDF2_ITERATIONS = 100_000;

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, iterStr, saltB64, hashB64] = stored.split('$');
  if (algo !== 'pbkdf2-sha256') return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 100_000) return false;
  const hash = new Uint8Array(await pbkdf2(password, unb64(saltB64), iterations));
  return timingSafeEqual(hash, unb64(hashB64));
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Human-friendly temporary password: 4 groups, no ambiguous characters. */
export function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return 'Пароль должен содержать не менее 10 символов';
  if (pw.length > 200) return 'Пароль слишком длинный';
  if (!/[A-Za-zА-Яа-я]/.test(pw) || !/[0-9]/.test(pw)) return 'Пароль должен содержать буквы и цифры';
  return null;
}

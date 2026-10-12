// Text normalisation, similarity and untrusted-cell sanitising.

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(s: string): Set<string> {
  const n = ` ${normalizeTitle(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < n.length - 2; i++) out.add(n.slice(i, i + 3));
  return out;
}

/** Sørensen–Dice coefficient over character trigrams, 0..1 */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Cells from spreadsheets are untrusted: strip control characters, trim, cap length.
 * The value is only ever stored and rendered as text (never as HTML, never evaluated).
 */
export function sanitizeCell(v: unknown, maxLen = 20000): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '');
  s = s.replace(/\r\n?/g, '\n').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function parseHours(raw: string): { value: number | null; error?: string } {
  const s = raw.replace(/\s/g, '').replace(',', '.');
  if (!s) return { value: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { value: null, error: `«${raw}» — не число` };
  const n = Number(s);
  if (n > 10000) return { value: null, error: `${n} ч — слишком большое значение (максимум 10000)` };
  return { value: Math.round(n * 10) / 10 };
}

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return null;
}

function validDate(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

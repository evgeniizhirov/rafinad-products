// External links of a task (ТЗ §3). Pure helpers: validation, kind detection, URL extraction from text.
// Nothing here fetches a URL — links are stored and shown, never followed by the server.

export const LINK_KINDS = ['bitrix24', 'jira', 'docs', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const LINK_KIND_LABEL: Record<LinkKind, string> = { bitrix24: 'Bitrix24', jira: 'Jira', docs: 'Документация', other: 'Другое' };
export const MAX_URL = 2000;
export const MAX_LINKS_PER_TASK = 50;

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** http(s) only, absolute, no spaces or control characters; returned trimmed, otherwise as entered */
export function checkUrl(raw: string): UrlCheck {
  const url = String(raw ?? '').trim();
  if (!url) return { ok: false, error: 'Пустой адрес' };
  if (url.length > MAX_URL) return { ok: false, error: `Адрес длиннее ${MAX_URL} символов` };
  if (/[\s\u0000-\u001f\u007f<>"`]/.test(url)) return { ok: false, error: 'В адресе есть пробелы или недопустимые символы' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `«${url.slice(0, 80)}» — не адрес. Нужна полная ссылка, начинающаяся с https:// или http://` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: `Протокол ${u.protocol} не поддерживается — только https:// или http://` };
  if (!u.hostname || !u.hostname.includes('.')) return { ok: false, error: `«${url.slice(0, 80)}» — нет домена` };
  if (u.username || u.password) return { ok: false, error: 'Адрес не должен содержать логин или пароль' };
  return { ok: true, url };
}

/** a best guess of the kind from the address (the user / source mapping can always override it) */
export function guessKind(url: string): LinkKind {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  // Bitrix24 on its own domain (e.g. my.company.ru/workgroups/group/1/tasks/task/view/2/) is recognised by the path
  if (host.includes('bitrix') || /\/(workgroups|company\/personal)\/.*\/tasks?\//.test(path)) return 'bitrix24';
  if (host.includes('jira') || /^\/browse\/[a-z][a-z0-9]+-\d+/.test(path)) return 'jira';
  if (host.includes('confluence') || host.includes('wiki') || host === 'docs.google.com' || host.includes('notion.') || /\/(wiki|display|pages)\//.test(path)) return 'docs';
  return 'other';
}

/** every http(s) URL found in free text, in order, without duplicates; trailing punctuation is not part of a URL */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`«»]+/gi)) {
    let u = m[0];
    // strip punctuation that usually ends a sentence or wraps the link
    while (/[.,;:!?)\]}]$/.test(u)) {
      if (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) >= (u.match(/\)/g)?.length ?? 0)) break;
      u = u.slice(0, -1);
    }
    if (checkUrl(u).ok && !out.includes(u)) out.push(u);
  }
  return out;
}

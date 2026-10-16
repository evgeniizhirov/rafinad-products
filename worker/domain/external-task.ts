/** A portal task is identified by host + task ID, regardless of group/personal URL form. */
export function bitrixTaskKey(raw: string): string | null {
  try {
    const u=new URL(raw);
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password) return null;
    const id=/\/tasks\/task\/view\/(\d+)\/?$/.exec(u.pathname)?.[1];
    return id ? `${u.hostname.toLowerCase()}:bitrix:${id}` : null;
  } catch { return null; }
}

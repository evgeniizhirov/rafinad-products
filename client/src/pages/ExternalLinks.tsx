// «Внешние ссылки» block of a task card (vNext ТЗ §3): Bitrix24 / Jira / documentation / other.
// Plain URLs: shown as links opening in a new tab; the app never reads what is behind them.
import { useState } from 'react';
import { I } from '../icons';
import { ApiError, api, invalidate, toast } from '../lib';

export const LINK_KIND_LABEL: Record<string, string> = { jira: 'Jira', bitrix24: 'Bitrix24', docs: 'Документация', other: 'Другое' };
const ORDER = ['jira', 'bitrix24', 'docs', 'other'];

/** same rule as the server: an absolute http(s) address */
function urlError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Укажите адрес';
  if (/\s/.test(v)) return 'В адресе не должно быть пробелов';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Только адреса https:// или http://';
  } catch {
    return 'Нужна полная ссылка, начинающаяся с https://';
  }
  return null;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** readable name of an untitled link: a Jira key (XG-3286), otherwise host + short path */
function shortLabel(url: string) {
  try {
    const u = new URL(url);
    const key = /\/browse\/([A-Z][A-Z0-9]+-\d+)/i.exec(u.pathname)?.[1];
    if (key) return key.toUpperCase();
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    return path && path !== '/' ? `${u.hostname}${path.length > 40 ? `${path.slice(0, 40)}…` : path}` : u.hostname;
  } catch {
    return url;
  }
}

export function ExternalLinks({ f, canEdit }: { f: any; canEdit: boolean }) {
  const links: any[] = f.links ?? [];
  const [editing, setEditing] = useState<any | null>(null); // {} = new link
  const groups = ORDER.map((k) => ({ kind: k, items: links.filter((l) => l.kind === k) })).filter((g) => g.items.length);
  return (
    <section className="stack tight" aria-label="Внешние ссылки">
      <div className="row">
        <h3 className="grow" style={{ fontSize: 15 }}>Внешние ссылки</h3>
        {canEdit && !editing && <button className="btn ghost sm" onClick={() => setEditing({})}>+ Ссылка</button>}
      </div>
      {!links.length && !editing && <p className="small muted" style={{ margin: 0 }}>Ссылок на Jira, Bitrix24 и документацию пока нет.</p>}
      {groups.map((g) => (
        <div key={g.kind} className="stack tight">
          <div className="small muted">{LINK_KIND_LABEL[g.kind]}</div>
          {g.items.map((l) => (editing?.id === l.id
            ? <LinkForm key={l.id} task={f} link={l} onDone={() => setEditing(null)} />
            : (
              <div key={l.id} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <a className="grow ellipsis" href={l.url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--info)' }} title={l.url}>
                  {l.title || shortLabel(l.url)}<span className="muted small"> · {hostOf(l.url)}</span>
                </a>
                {l.origin === 'import' && <span className="pill outline" title={l.locally_edited ? 'Создана импортом и изменена вручную — импорт её не перезапишет без вашего решения' : 'Создана импортом из таблицы'}>{l.locally_edited ? 'импорт, изменена' : 'из импорта'}</span>}
                {canEdit && (
                  <>
                    <button className="btn ghost sm" onClick={() => setEditing(l)} aria-label="Изменить ссылку">Изменить</button>
                    <button className="btn ghost sm" aria-label="Удалить ссылку" onClick={async () => {
                      if (!window.confirm(`Удалить ссылку ${l.title || l.url}?`)) return;
                      try { await api(`/links/${l.id}`, { method: 'DELETE' }); invalidate(); toast('Ссылка удалена'); } catch (e) { toast((e as Error).message, 'error'); }
                    }}><I.x style={{ width: 14, height: 14 }} /></button>
                  </>
                )}
              </div>
            )))}
        </div>
      ))}
      {editing && !editing.id && <LinkForm task={f} onDone={() => setEditing(null)} />}
    </section>
  );
}

function LinkForm({ task, link, onDone }: { task: any; link?: any; onDone: () => void }) {
  const [url, setUrl] = useState(link?.url ?? '');
  const [kind, setKind] = useState(link?.kind ?? '');
  const [title, setTitle] = useState(link?.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const e = urlError(url);
    if (e) return setError(e);
    setBusy(true);
    try {
      const body = { url: url.trim(), title: title.trim() || null, ...(kind ? { kind } : {}) };
      if (link) await api(`/links/${link.id}`, { method: 'PATCH', body: { ...body, version: link.version } });
      else await api(`/features/${task.id}/links`, { method: 'POST', body });
      invalidate();
      toast(link ? 'Ссылка изменена' : 'Ссылка добавлена');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack tight" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input grow" style={{ minWidth: 240 }} autoFocus placeholder="https://…" value={url} aria-label="Адрес ссылки"
          onChange={(e) => { setUrl(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <select className="select" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Тип ссылки">
          <option value="">{link ? LINK_KIND_LABEL[link.kind] : 'Тип — определить по адресу'}</option>
          {ORDER.map((k) => <option key={k} value={k}>{LINK_KIND_LABEL[k]}</option>)}
        </select>
      </div>
      <input className="input" placeholder="Название (необязательно), например «Спецификация»" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Название ссылки" maxLength={200} />
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm primary" disabled={busy} onClick={save}>{link ? 'Сохранить' : 'Добавить'}</button>
        <button className="btn ghost sm" onClick={onDone}>Отмена</button>
      </div>
    </div>
  );
}

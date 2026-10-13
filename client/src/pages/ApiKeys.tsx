// Personal API keys (FR-01): create with scopes and expiry, the token is shown once; admin list with forced revocation.
import { useState } from 'react';
import { I } from '../icons';
import { api, fmtDate, fmtDateTime, invalidate, mutate, toast, useApi } from '../lib';
import { Empty, Field, Loading, Modal, Notice, ReasonModal } from '../ui';

export const SCOPE_LABEL: Record<string, string> = {
  'tasks:read': 'Читать задачи, релизы, спринты',
  'tasks:create': 'Создавать задачи',
  'tasks:update': 'Изменять задачи, связи, комментарии, блокеры',
  'priorities:write-own': 'Ставить оценки за свои отделы',
  'exports:read': 'Выгружать задачи',
};

export function MyApiKeys() {
  const { data } = useApi<any>('/me/api-keys');
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2 className="grow">API-ключи для Claude Code, Codex и интеграций</h2>
        <button className="btn sm" onClick={() => setCreating(true)}><I.plus />Новый ключ</button>
      </div>
      <div className="panel-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          Ключ действует от вашего имени и не даёт больше прав, чем у вас есть: эффективные права = ваша роль ∩ разрешения ключа. Пароль агенту передавать не нужно.
          Запросы: заголовок <code>Authorization: Bearer rr_…</code>, адрес <code>{location.origin}/api/…</code>. Подробнее — <code>docs/API_KEYS.md</code> в репозитории.
        </p>
        {!data ? <Loading rows={2} /> : data.keys.length === 0 ? <Empty title="Ключей пока нет" /> : (
          <table className="data">
            <thead><tr><th>Ключ</th><th>Разрешения</th><th>Действует до</th><th>Последнее использование</th><th /></tr></thead>
            <tbody>
              {data.keys.map((k: any) => (
                <tr key={k.id} style={k.active ? undefined : { opacity: 0.55 }}>
                  <td><b>{k.name}</b><div className="small muted"><code>{k.prefix}</code></div></td>
                  <td className="small">{k.scopes.map((s: string) => SCOPE_LABEL[s] ?? s).join('; ')}</td>
                  <td className="small nowrap">{k.revoked_at ? `отозван ${fmtDate(k.revoked_at.slice(0, 10))}` : fmtDate(k.expires_at.slice(0, 10))}</td>
                  <td className="small nowrap">{k.last_used_at ? `${fmtDateTime(k.last_used_at)} (${k.use_count})` : 'не использовался'}</td>
                  <td>{k.active && <button className="btn ghost sm" onClick={async () => { if (window.confirm(`Отозвать ключ «${k.name}»? Он перестанет работать сразу.`)) await mutate(`/me/api-keys/${k.id}`, 'DELETE', undefined, 'Ключ отозван'); }}>Отозвать</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <NewKey scopes={data?.scopes ?? Object.keys(SCOPE_LABEL)} onClose={() => setCreating(false)} onCreated={(name, token) => { setCreating(false); setShown({ name, token }); }} />}
      {shown && (
        <Modal title={`Ключ «${shown.name}» создан`} onClose={() => setShown(null)} footer={<button className="btn primary" onClick={() => setShown(null)}>Я сохранил ключ</button>}>
          <div className="stack">
            <Notice kind="warn">Скопируйте ключ сейчас — он показывается один раз и нигде не хранится в открытом виде.</Notice>
            <div className="row">
              <input className="input" readOnly value={shown.token} onFocus={(e) => e.target.select()} style={{ fontFamily: 'monospace' }} />
              <button className="btn" onClick={() => { navigator.clipboard?.writeText(shown.token).then(() => toast('Скопировано')); }}>Копировать</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Для Claude Code или Codex положите ключ в переменную окружения, например <code>RAFINAD_API_KEY</code>, а не в код и не в чат.</p>
          </div>
        </Modal>
      )}
    </section>
  );
}

function NewKey({ scopes, onClose, onCreated }: { scopes: string[]; onClose: () => void; onCreated: (name: string, token: string) => void }) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState<string[]>(['tasks:read']);
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api<any>('/me/api-keys', { method: 'POST', body: { name, scopes: sel, expires_in_days: days } });
      invalidate();
      onCreated(name, r.token);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };
  return (
    <Modal title="Новый API-ключ" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={busy || !name.trim() || !sel.length} onClick={create}>Создать</button></>}>
      <div className="stack">
        <Field label="Название"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code на рабочем ноутбуке" autoFocus /></Field>
        <Field label="Разрешения" hint="Выдавайте минимально нужные">
          <div className="stack tight">
            {scopes.map((s) => (
              <label key={s} className="check"><input type="checkbox" checked={sel.includes(s)} onChange={(e) => setSel((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} />{SCOPE_LABEL[s] ?? s} <code className="small muted">{s}</code></label>
            ))}
          </div>
        </Field>
        <Field label="Срок действия">
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option><option value={180}>180 дней</option><option value={365}>1 год</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export function AdminApiKeys() {
  const { data } = useApi<any>('/admin/api-keys');
  const [revoking, setRevoking] = useState<any | null>(null);
  if (!data) return <div className="panel"><Loading rows={4} /></div>;
  return (
    <section className="panel flush">
      {data.keys.length === 0 ? <Empty title="Ключей нет" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Владелец</th><th>Ключ</th><th>Разрешения</th><th>Создан</th><th>Действует до</th><th>Использование</th><th /></tr></thead>
            <tbody>
              {data.keys.map((k: any) => (
                <tr key={k.id} style={k.active ? undefined : { opacity: 0.55 }}>
                  <td>{k.owner.name}<div className="small muted">{k.owner.email}</div></td>
                  <td><b>{k.name}</b><div className="small muted"><code>{k.prefix}</code></div></td>
                  <td className="small">{k.scopes.join(', ')}</td>
                  <td className="small nowrap">{fmtDate(k.created_at.slice(0, 10))}</td>
                  <td className="small nowrap">{k.revoked_at ? `отозван ${fmtDate(k.revoked_at.slice(0, 10))}` : fmtDate(k.expires_at.slice(0, 10))}</td>
                  <td className="small nowrap">{k.last_used_at ? `${fmtDateTime(k.last_used_at)} (${k.use_count})` : '—'}</td>
                  <td>{k.active && <button className="btn ghost sm" onClick={() => setRevoking(k)}>Отозвать</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoking && (
        <ReasonModal title={`Отозвать ключ «${revoking.name}» (${revoking.owner.name})`} confirmText="Отозвать" onClose={() => setRevoking(null)}
          onConfirm={async (reason) => { await mutate(`/admin/api-keys/${revoking.id}/revoke`, 'POST', { reason }, 'Ключ отозван'); setRevoking(null); }}>
          <p>Ключ перестанет работать сразу. Причина попадёт в журнал.</p>
        </ReasonModal>
      )}
    </section>
  );
}

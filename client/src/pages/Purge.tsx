// «Удалить навсегда» (vNext ТЗ §5): administrator only, one record at a time. The dialog shows what will disappear
// with the record (server preview), asks for the key of the record to be typed in, and only then deletes it.
// To hide a record without deleting it, use the ordinary ways: status «Отменена», visibility «Черновик», «Отклонено».
import { useEffect, useState } from 'react';
import { api, invalidate, toast, useApi, useApp } from '../lib';
import { ErrorBox, Loading, Modal, Notice } from '../ui';

type Kind = 'feature' | 'epic' | 'proposal';
const WHAT: Record<Kind, string> = { feature: 'задачу', epic: 'эпик', proposal: 'предложение' };
const HIDE: Record<Kind, string> = {
  feature: 'Чтобы просто убрать задачу из работы, достаточно статуса «Отменена» или видимости «Черновик» — история сохранится.',
  epic: 'Чтобы просто убрать эпик из работы, достаточно видимости «Черновик» — история сохранится.',
  proposal: 'Чтобы просто закрыть предложение, достаточно статуса «Отклонено» с причиной — история сохранится.',
};

export function PurgeButton({ kind, refKey, onDone, small }: { kind: Kind; refKey: string; onDone?: () => void; small?: boolean }) {
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  if (!me?.permissions.admin || me.must_change_password) return null;
  return (
    <>
      <button className={`btn ghost danger ${small ? 'sm' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>Удалить навсегда</button>
      {open && <PurgeDialog kind={kind} refKey={refKey} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />}
    </>
  );
}

function PurgeDialog({ kind, refKey, onClose, onDone }: { kind: Kind; refKey: string; onClose: () => void; onDone: () => void }) {
  const { data, error } = useApi<any>(`/admin/purge/${kind}/${encodeURIComponent(refKey)}`);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTyped(''); }, [data?.preview_revision]);
  const ok = !!data && typed.trim().toUpperCase() === data.confirm.toUpperCase();
  const run = async () => {
    setBusy(true);
    try {
      const r = await api(`/admin/purge/${kind}/${encodeURIComponent(refKey)}`, { method: 'POST', body: { confirm: typed.trim(), version: data.version, preview_revision: data.preview_revision, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      toast(`Удалено навсегда: ${r.deleted.join(', ')}`);
      onDone();
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
      setTyped('');
      invalidate();
      setBusy(false);
    }
  };
  return (
    <Modal wide title={data ? `Удалить навсегда ${data.key}` : `Удалить ${WHAT[kind]} навсегда`} onClose={onClose} dirty={!!typed || !!reason}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary danger-fill" disabled={!ok || busy} onClick={run}>{busy ? 'Удаляем…' : 'Удалить навсегда'}</button></>}>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Loading rows={5} />}
      {data && (
        <div className="stack">
          <div><b>{data.key}</b> {data.title}</div>
          <Notice kind="warn">{data.backup}</Notice>
          <p className="small muted" style={{ margin: 0 }}>{HIDE[kind]}</p>
          {data.warnings.map((w: string, i: number) => <Notice key={i} kind="warn">{w}</Notice>)}
          <div className="stack tight">
            <div className="small muted">Что удалится или изменится вместе с записью</div>
            <ul className="purge-effects">
              {data.effects.map((e: any) => (
                <li key={e.label}>
                  <b>{e.label}</b>{e.count ? <span className="muted"> · {e.count}</span> : null}
                  {e.items?.length > 0 && <div className="small">{e.items.slice(0, 8).join('; ')}{e.items.length > 8 ? ` и ещё ${e.items.length - 8}` : ''}</div>}
                  {e.note && <div className="small muted">{e.note}</div>}
                </li>
              ))}
            </ul>
          </div>
          <label className="field">
            <span>Для подтверждения введите <b>{data.confirm}</b></span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Ключ записи для подтверждения" />
          </label>
          <label className="field">
            <span>Причина <span className="muted">(попадёт в запись журнала о факте удаления)</span></span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Например: тестовая запись" />
          </label>
        </div>
      )}
    </Modal>
  );
}

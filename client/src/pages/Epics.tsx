import { useState } from 'react';
import { I } from '../icons';
import { fmtDate, fmtH, mutate, openFeature, useApi, useApp, useDict } from '../lib';
import { Cubes, Empty, ErrorBox, Field, GuestNote, Loading, Modal, PageHead, Progress, StatusPill, VisBadge } from '../ui';

export function Epics() {
  const { me } = useApp();
  const d = useDict();
  const { data, error } = useApi<any>('/epics');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  const toggle = (id: string) => setOpen((s) => ({ ...s, [id]: !s[id] }));
  return (
    <>
      <PageHead title="Эпики" sub="Крупные инициативы. Часы и прогресс считаются по входящим задачам — без повторного учёта.">
        {canEdit && <button className="btn primary" onClick={() => setEdit({})}><I.plus />Новый эпик</button>}
      </PageHead>
      <GuestNote />
      <ErrorBox error={error} />
      {!data ? <div className="panel"><Loading rows={6} /></div> : (
        <div className="panel">
          {data.epics.length === 0 && <Empty title="Эпиков пока нет" />}
          {data.epics.map((e: any) => (
            <div key={e.id} className={`epic ${open[e.id] ? 'open' : ''}`}>
              <div className="epic-row" onClick={() => toggle(e.id)} role="button" aria-expanded={!!open[e.id]} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && toggle(e.id)}>
                <I.chevron className="chev" />
                <div style={{ minWidth: 0 }}>
                  <div className="row wrap">
                    <span className="key">{e.key}</span>
                    <b>{e.title}</b>
                    <StatusPill status={e.status} />
                    <VisBadge v={e.visibility !== 'public' ? e.visibility : undefined} />
                  </div>
                  <div className="small muted ellipsis" style={{ marginTop: 2 }}>
                    {[e.category?.name, e.owner_name && `владелец ${e.owner_name}`, (e.start_date || e.end_date) && `${fmtDate(e.start_date, false)} — ${fmtDate(e.end_date)}`].filter(Boolean).join(', ')}
                  </div>
                </div>
                <div>
                  <Progress value={e.progress} label={`${e.done_count}/${e.feature_count}`} />
                </div>
                <div className="hide-md">
                  {e.hours ? (
                    <div className="row" title={d.activeTeams.map((t) => `${t.name}: ${e.hours[t.id] ?? 0} ч`).join('\n')}>
                      <div className="hours-bars">
                        {d.activeTeams.map((t) => {
                          const max = Math.max(1, ...Object.values(e.hours as Record<string, number>));
                          return <i key={t.id} style={{ height: `${((e.hours[t.id] ?? 0) / max) * 100}%`, ['--c' as any]: t.color ?? 'var(--ink-3)' }} />;
                        })}
                      </div>
                      <span className="num small">{fmtH(e.total_hours)}</span>
                    </div>
                  ) : <span className="muted small">оценки скрыты</span>}
                </div>
                <div className="hide-md" style={{ textAlign: 'right' }}>
                  {canEdit && <button className="btn sm" onClick={(ev) => { ev.stopPropagation(); setEdit(e); }}>Изменить</button>}
                </div>
              </div>
              {open[e.id] && (
                <div className="epic-children">
                  {e.description && <p className="muted small pre" style={{ margin: '0 10px 10px' }}>{e.description}</p>}
                  {e.features.length === 0 && <p className="muted small" style={{ padding: '6px 10px' }}>В эпике пока нет задач.</p>}
                  {e.features.map((f: any) => (
                    <div key={f.id} className="mini-feature" onClick={() => openFeature(f.key)}>
                      <span className="key">{f.key}</span>
                      <span className="ellipsis">{f.title}</span>
                      <span className="hide-sm"><StatusPill status={f.status} /></span>
                      <span className="hide-sm"><Cubes score={f.priority.score} /></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {data.without_epic.length > 0 && (
            <div className={`epic ${open.__none ? 'open' : ''}`}>
              <div className="epic-row" onClick={() => toggle('__none')} role="button" tabIndex={0}>
                <I.chevron className="chev" />
                <div><b>Без эпика</b><div className="small muted">Задачи, не входящие в инициативы</div></div>
                <div className="small muted">{data.without_epic.length} задач</div>
              </div>
              {open.__none && (
                <div className="epic-children">
                  {data.without_epic.map((f: any) => (
                    <div key={f.id} className="mini-feature" onClick={() => openFeature(f.key)}>
                      <span className="key">{f.key}</span>
                      <span className="ellipsis">{f.title}</span>
                      <span className="hide-sm"><StatusPill status={f.status} /></span>
                      <span className="hide-sm"><Cubes score={f.priority.score} /></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {edit && <EpicForm epic={edit.id ? edit : null} onClose={() => setEdit(null)} />}
    </>
  );
}

function EpicForm({ epic, onClose }: { epic: any | null; onClose: () => void }) {
  const { meta } = useApp();
  const d = useDict();
  const [v, setV] = useState({
    title: epic?.title ?? '', description: epic?.description ?? '', category_id: epic?.category?.id ?? '', owner_name: epic?.owner_name ?? '',
    status_id: epic?.status?.id ?? d.statuses('epic')[0]?.id ?? '', start_date: epic?.start_date ?? '', end_date: epic?.end_date ?? '',
    visibility: epic?.visibility ?? 'internal', external_ref: epic?.external_ref ?? '',
  });
  const set = (k: string) => (e: any) => setV((s) => ({ ...s, [k]: e.target.value }));
  const n = (x: string) => (x === '' ? null : x);
  const submit = async () => {
    const body = { ...v, category_id: n(v.category_id), owner_name: n(v.owner_name), start_date: n(v.start_date), end_date: n(v.end_date), external_ref: n(v.external_ref) };
    const r = epic ? await mutate(`/epics/${epic.id}`, 'PATCH', { ...body, version: epic.version }, 'Эпик сохранён') : await mutate('/epics', 'POST', body, 'Эпик создан');
    if (r) onClose();
  };
  return (
    <Modal title={epic ? `Эпик ${epic.key}` : 'Новый эпик'} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!v.title.trim()} onClick={submit}>Сохранить</button></>}>
      <div className="form-grid">
        <Field label="Название" span2><input className="input" value={v.title} onChange={set('title')} autoFocus /></Field>
        <Field label="Описание" span2><textarea className="textarea" value={v.description} onChange={set('description')} /></Field>
        <Field label="Категория">
          <select className="select" value={v.category_id} onChange={set('category_id')}>
            <option value="">Без категории</option>
            {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Статус">
          <select className="select" value={v.status_id} onChange={set('status_id')}>
            {d.statuses('epic').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Владелец"><input className="input" value={v.owner_name} onChange={set('owner_name')} /></Field>
        <Field label="Публикация">
          <select className="select" value={v.visibility} onChange={set('visibility')}>
            <option value="draft">Черновик</option><option value="internal">Внутренний</option><option value="public">Опубликован</option>
          </select>
        </Field>
        <Field label="Начало"><input type="date" className="input" value={v.start_date} onChange={set('start_date')} /></Field>
        <Field label="Окончание"><input type="date" className="input" value={v.end_date} onChange={set('end_date')} /></Field>
        <Field label="Внешний ID"><input className="input" value={v.external_ref} onChange={set('external_ref')} /></Field>
      </div>
    </Modal>
  );
}

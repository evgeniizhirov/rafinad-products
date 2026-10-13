import { useState } from 'react';
import { I } from '../icons';
import { FeaturePicker, FeatureTitle } from '../features';
import { api, ApiError, fmtDate, fmtDateTime, invalidate, mutate, navigate, openFeature, toast, useApi, useApp, useDict } from '../lib';
import { Cubes, Empty, ErrorBox, Field, GuestNote, Loading, Modal, PageHead, Progress, ReasonModal, Seg, StatusPill, VisBadge, useDirty } from '../ui';

export function Releases() {
  const { me } = useApp();
  const { data, error } = useApi<any>('/releases');
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [creating, setCreating] = useState(false);
  const canPlan = !!me?.permissions.plan && !me.must_change_password;
  return (
    <>
      <PageHead title="Релизы" sub="Состав выпусков, плановые даты, готовность и критические блокировки.">
        <Seg value={view} onChange={setView} items={[{ id: 'list', label: 'Список' }, { id: 'calendar', label: 'Календарь' }]} />
        {canPlan && <button className="btn primary" onClick={() => setCreating(true)}><I.plus />Новый релиз</button>}
      </PageHead>
      <GuestNote />
      <ErrorBox error={error} />
      {!data ? <div className="panel"><Loading rows={6} /></div> : data.releases.length === 0 ? <div className="panel"><Empty title="Релизов пока нет" /></div> : view === 'list' ? (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Релиз</th><th>Статус</th><th>Плановый выпуск</th><th>Факт</th><th style={{ width: 200 }}>Готовность</th><th>Блокировки</th></tr></thead>
              <tbody>
                {data.releases.map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => navigate(`/releases/${r.id}`)}>
                    <td className="title-cell">
                      <div className="row wrap"><span className="t">{r.name}</span>{r.version_label && <span className="muted small">{r.version_label}</span>}</div>
                      <div className="row" style={{ marginTop: 3 }}>{r.approved ? <span className="pill ok"><I.lock style={{ width: 11, height: 11 }} />утверждён</span> : <span className="pill outline">не утверждён</span>}<VisBadge v={r.visibility !== 'public' ? r.visibility : undefined} /></div>
                    </td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="nowrap">{fmtDate(r.planned_date)}{r.overdue && <div className="small" style={{ color: 'var(--danger)' }}>срок прошёл</div>}</td>
                    <td className="nowrap">{fmtDate(r.actual_date)}</td>
                    <td><Progress value={r.readiness} label={`${r.done_count}/${r.feature_count}`} /></td>
                    <td className="small">{r.blockers.length ? <span style={{ color: 'var(--danger)' }}>{r.blockers.map((b: any) => b.feature.key).join(', ')}</span> : <span className="muted">нет</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <ReleaseCalendar releases={data.releases} />}
      {creating && <ReleaseForm onClose={() => setCreating(false)} />}
    </>
  );
}

function ReleaseCalendar({ releases }: { releases: any[] }) {
  const dated = releases.filter((r) => r.planned_date || r.actual_date);
  const dates = dated.map((r) => r.actual_date ?? r.planned_date).sort();
  if (!dates.length) return <Empty title="У релизов нет дат" />;
  const start = new Date(`${dates[0].slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${dates[dates.length - 1].slice(0, 7)}-01T00:00:00Z`);
  const months: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(new Date(d));
  const name = (d: Date) => d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <div className="timeline" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(220px, 1fr))` }}>
      {months.map((m) => {
        const key = m.toISOString().slice(0, 7);
        const inMonth = dated.filter((r) => (r.actual_date ?? r.planned_date).startsWith(key));
        return (
          <section key={key} className="period-col">
            <div className="period-head"><h3 style={{ textTransform: 'capitalize' }}>{name(m)}</h3></div>
            <div className="period-cards">
              {inMonth.length === 0 && <span className="small muted">Нет выпусков</span>}
              {inMonth.map((r) => (
                <div key={r.id} className="card" onClick={() => navigate(`/releases/${r.id}`)}>
                  <div className="row"><I.releases style={{ width: 15, height: 15, color: 'var(--beet)' }} /><b className="grow">{r.version_label ?? r.name}</b><span className="small muted">{fmtDate(r.actual_date ?? r.planned_date, false)}</span></div>
                  <div className="small">{r.name}</div>
                  <Progress value={r.readiness} />
                  <div className="meta"><StatusPill status={r.status} />{r.approved && <span className="pill ok">утверждён</span>}</div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function ReleaseDetail({ id }: { id: string }) {
  const { me } = useApp();
  const { data, error } = useApi<any>(`/releases/${id}`);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pendingChange, setPendingChange] = useState<string[] | null>(null);
  const r = data?.release;
  if (!r) return <><PageHead title="Релиз" />{error ? <ErrorBox error={error} /> : <Loading />}</>;
  const canPlan = !!me?.permissions.plan && !me.must_change_password;
  const setComposition = async (ids: string[], reason?: string) => {
    try {
      await api(`/releases/${r.id}/features`, { method: 'PUT', body: { feature_ids: ids, version: r.version, ...(reason ? { confirm_approved_change: true, reason } : {}) } });
      invalidate();
      toast('Состав релиза обновлён');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'approved') setPendingChange(ids);
      else { toast((e as Error).message, 'error'); invalidate(); }
    }
  };
  return (
    <>
      <div className="small" style={{ marginBottom: 8 }}><a href="/releases" onClick={(e) => { e.preventDefault(); navigate('/releases'); }} className="muted">Все релизы</a></div>
      <PageHead
        title={r.name}
        sub={<span className="row wrap">{r.version_label && <b>{r.version_label}</b>}<StatusPill status={r.status} /><span>выпуск {fmtDate(r.planned_date)}</span>{r.actual_date && <span>выпущен {fmtDate(r.actual_date)}</span>}{r.approved ? <span className="pill ok">утверждён</span> : <span className="pill outline">не утверждён</span>}<VisBadge v={r.visibility} /></span>}
      >
        {canPlan && (
          <>
            <button className="btn" onClick={() => setEditing(true)}>Изменить</button>
            <button className="btn" onClick={() => mutate(`/releases/${r.id}/approve`, 'POST', { version: r.version, approved: !r.approved }, r.approved ? 'Утверждение снято' : 'Релиз утверждён')}>
              {r.approved ? 'Снять утверждение' : 'Утвердить состав'}
            </button>
          </>
        )}
      </PageHead>
      {r.description && <p className="pre" style={{ maxWidth: '72ch', marginBottom: 16 }}>{r.description}</p>}
      <div className="kpis">
        <div className="kpi"><b className="num">{r.readiness}%</b><span>готовность</span></div>
        <div className="kpi"><b className="num">{r.done_count}/{r.feature_count}</b><span>задач завершено</span></div>
        <div className={`kpi ${r.blockers.length ? 'alert' : ''}`}><b className="num">{r.blockers.length}</b><span>с блокировками</span></div>
      </div>
      {r.blockers.length > 0 && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head"><h2>Что блокирует выпуск</h2></div>
          <div className="list">
            {r.blockers.map((b: any) => (
              <div key={b.feature.id} className="list-item" onClick={() => openFeature(b.feature.key)}>
                <I.alert style={{ width: 16, height: 16, color: 'var(--danger)', flex: 'none' }} />
                <span className="key">{b.feature.key}</span>
                <span className="grow">{b.feature.title}</span>
                <span className="small muted">{b.status_blocked ? 'статус «Заблокирована»' : `ждёт ${b.blocked_by.map((x: any) => (x.hidden ? 'внутреннюю задачу' : `${x.key} (${x.status})`)).join(', ')}`}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="panel flush" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="grow">Состав релиза</h2>
          {canPlan && <button className="btn sm" onClick={() => setAdding(true)}><I.plus />Добавить задачу</button>}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Задача</th><th>Статус</th><th>Приоритет</th><th>Спринт</th>{canPlan && <th />}</tr></thead>
            <tbody>
              {r.features.length === 0 && <tr><td colSpan={5}><Empty title="В релизе пока нет задач" /></td></tr>}
              {r.features.map((f: any) => (
                <tr key={f.id} className="click" onClick={() => openFeature(f.key)}>
                  <td><div className="row top"><span className="key">{f.key}</span><FeatureTitle f={f} /></div></td>
                  <td><StatusPill status={f.status} /></td>
                  <td><Cubes score={f.priority.score} /></td>
                  <td className="small">{f.sprint && !f.sprint.hidden ? f.sprint.code : <span className="muted">—</span>}</td>
                  {canPlan && <td className="r"><button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setComposition(r.feature_ids.filter((x: string) => x !== f.id)); }}>Исключить</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {r.history && (
        <section className="panel">
          <div className="panel-head"><h2>История релиза</h2></div>
          <div className="panel-body history">
            {r.history.length === 0 && <span className="muted">Изменений нет</span>}
            {r.history.map((h: any, i: number) => (
              <div key={i} className="history-item">
                <span className="muted small">{fmtDateTime(h.at)}</span>
                <span><b>{h.actor_name}</b> {({ created: 'создал(а)', updated: 'изменил(а)', approved: 'утвердил(а)', unapproved: 'снял(а) утверждение', composition_changed: 'изменил(а) состав', feature_moved_out: 'перенёс(ла) задачу в другой релиз' } as Record<string, string>)[h.action] ?? h.action}
                  {(h.changes ?? []).filter((c: any) => c.field === 'features').map((c: any, j: number) => <span key={j} className="small"> {c.new ? `+${c.new}` : `−${c.old}`}</span>)}
                  {h.reason && <span className="small muted"> Причина: {h.reason}</span>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {editing && <ReleaseForm release={r} onClose={() => setEditing(false)} />}
      {adding && (
        <Modal title="Добавить задачу в релиз" onClose={() => setAdding(false)}>
          <p className="small muted" style={{ marginBottom: 10 }}>Если задача уже в другом релизе, она будет перенесена.</p>
          <FeaturePicker exclude={r.feature_ids} onPick={(f) => { setAdding(false); setComposition([...r.feature_ids, f.id]); }} />
        </Modal>
      )}
      {pendingChange && (
        <ReasonModal title="Изменить утверждённый релиз" confirmText="Изменить состав" onClose={() => setPendingChange(null)} onConfirm={async (reason) => { const ids = pendingChange; setPendingChange(null); await setComposition(ids, reason); }}>
          <p>Состав «{r.name}» утверждён. Изменение будет записано в историю релиза вместе с причиной.</p>
        </ReasonModal>
      )}
    </>
  );
}

function ReleaseForm({ release, onClose }: { release?: any; onClose: () => void }) {
  const d = useDict();
  const [v, setV] = useState({
    name: release?.name ?? '', version_label: release?.version_label ?? '', description: release?.description ?? '', status_id: release?.status?.id ?? d.statuses('release')[0]?.id ?? '',
    planned_date: release?.planned_date ?? '', actual_date: release?.actual_date ?? '', visibility: release?.visibility ?? 'internal',
  });
  const dirty = useDirty(v);
  const set = (k: string) => (e: any) => setV((s) => ({ ...s, [k]: e.target.value }));
  const n = (x: string) => (x === '' ? null : x);
  const submit = async () => {
    const body = { ...v, version_label: n(v.version_label), planned_date: n(v.planned_date), actual_date: n(v.actual_date) };
    const r = release ? await mutate(`/releases/${release.id}`, 'PATCH', { ...body, version: release.version }, 'Релиз сохранён') : await mutate<any>('/releases', 'POST', body, 'Релиз создан');
    if (r) { onClose(); if (!release && r.id) navigate(`/releases/${r.id}`); }
  };
  return (
    <Modal title={release ? 'Релиз' : 'Новый релиз'} onClose={onClose} wide dirty={dirty} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!v.name.trim()} onClick={submit}>Сохранить</button></>}>
      <div className="form-grid">
        <Field label="Название"><input className="input" value={v.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Версия"><input className="input" value={v.version_label} onChange={set('version_label')} placeholder="v3.7" /></Field>
        <Field label="Описание" span2><textarea className="textarea" value={v.description} onChange={set('description')} /></Field>
        <Field label="Статус">
          <select className="select" value={v.status_id} onChange={set('status_id')}>
            {d.statuses('release').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Публикация">
          <select className="select" value={v.visibility} onChange={set('visibility')}>
            <option value="draft">Черновик</option><option value="internal">Внутренний</option><option value="public">Опубликован</option>
          </select>
        </Field>
        <Field label="Плановая дата выпуска"><input type="date" className="input" value={v.planned_date} onChange={set('planned_date')} /></Field>
        <Field label="Фактическая дата" hint="Проставляется автоматически при статусе «Выпущен»"><input type="date" className="input" value={v.actual_date} onChange={set('actual_date')} /></Field>
      </div>
    </Modal>
  );
}

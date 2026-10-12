import { useEffect, useState } from 'react';
import { I } from '../icons';
import { FeatureForm, FeaturePicker, KIND_LABEL, usePlacement, VoteControl } from '../features';
import { api, ApiError, fmtDate, fmtDateTime, fmtH, invalidate, mutate, navigate, openFeature, toast, useApi, useApp, useDict, useQueryParam } from '../lib';
import { Cubes, Empty, ErrorBox, Loading, Modal, ReasonModal, RichText, StatusPill, Tabs, VisBadge } from '../ui';

type Tab = 'about' | 'priority' | 'resources' | 'links' | 'history';

export function FeatureDrawer() {
  const [key, setKey] = useQueryParam('f');
  const [tab, setTab] = useState<Tab>('about');
  useEffect(() => {
    setTab('about');
  }, [key]);
  useEffect(() => {
    if (!key) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && setKey(null);
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [key, setKey]);
  if (!key) return null;
  return (
    <>
      <div className="scrim" onClick={() => setKey(null)} />
      <aside className="drawer" role="dialog" aria-label="Карточка задачи">
        <DrawerContent featureKey={key} tab={tab} setTab={setTab} close={() => setKey(null)} />
      </aside>
    </>
  );
}

function DrawerContent({ featureKey, tab, setTab, close }: { featureKey: string; tab: Tab; setTab: (t: Tab) => void; close: () => void }) {
  const { me } = useApp();
  const { data, error, loading } = useApi<any>(`/features/${encodeURIComponent(featureKey)}`);
  const [editing, setEditing] = useState(false);
  const f = data?.feature;
  if (!f) {
    return (
      <div className="drawer-body">
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn ghost icon" onClick={close} aria-label="Закрыть"><I.x /></button></div>
        {loading ? <Loading rows={6} /> : <ErrorBox error={error} />}
      </div>
    );
  }
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  return (
    <>
      <div className="drawer-head">
        <div className="row">
          <span className="key">{f.key}</span>
          <StatusPill status={f.status} />
          {f.stage && <span className="pill outline">Этап: {f.stage.name}</span>}
          <VisBadge v={f.visibility} />
          <span className="grow" />
          {canEdit && <button className="btn sm" onClick={() => setEditing(true)}>Редактировать</button>}
          <button className="btn ghost icon sm" onClick={close} aria-label="Закрыть"><I.x /></button>
        </div>
        <h2 className="drawer-title">{f.title}</h2>
        {f.merged_from && <div className="notice info" style={{ marginBottom: 10 }}><I.merge /><span>{f.merged_from.key} объединена с этой карточкой — показана основная.</span></div>}
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { id: 'about', label: 'Описание' },
            { id: 'priority', label: 'Приоритеты', n: f.priority.voters },
            { id: 'resources', label: 'Ресурсы' },
            { id: 'links', label: 'Связи', n: Object.values(f.relations).flat().length + f.offers.length || null },
            ...(f.history ? [{ id: 'history' as Tab, label: 'История' }] : []),
          ]}
        />
      </div>
      <div className="drawer-body">
        {tab === 'about' && <About f={f} />}
        {tab === 'priority' && <Priority f={f} />}
        {tab === 'resources' && <Resources f={f} />}
        {tab === 'links' && <Links f={f} />}
        {tab === 'history' && <History f={f} />}
      </div>
      {editing && <FeatureForm feature={f} onClose={() => setEditing(false)} />}
    </>
  );
}

function About({ f }: { f: any }) {
  const { me } = useApp();
  const [comment, setComment] = useState('');
  return (
    <div className="stack loose">
      <RichText text={f.description} />
      <dl className="dl">
        <dt>Приоритет</dt>
        <dd><Cubes score={f.priority.score} /> <span className="muted small">{f.priority.voters ? `оценили ${f.priority.voters}` : 'отделы ещё не голосовали'}</span></dd>
        <dt>Эпик</dt>
        <dd>{f.epic ? (f.epic.hidden ? <span className="muted">Внутренний эпик</span> : f.epic.title) : <span className="muted">Без эпика</span>}</dd>
        <dt>Категория</dt>
        <dd>{f.category?.name ?? <span className="muted">—</span>}</dd>
        {f.tags.length > 0 && (<><dt>Теги</dt><dd className="row wrap">{f.tags.map((t: string) => <span key={t} className="tag">{t}</span>)}</dd></>)}
        <dt>Плановый период</dt>
        <dd>{f.period ? <>{f.period.name}{f.placement_locked && <span className="muted small"> (утверждено)</span>}</> : <span className="muted">Не запланирована</span>}</dd>
        <dt>Релиз → спринт</dt>
        <dd>
          {f.release ? <a className="link" href={`/releases/${f.release.id}`} onClick={(e) => { e.preventDefault(); navigate(`/releases/${f.release.id}`); }} style={{ color: 'var(--info)' }}>{f.release.name}</a> : <span className="muted">Не включена</span>}
          {f.sprint && <> → спринт <b>{f.sprint.code}</b> <span className="muted small">({fmtDate(f.sprint.start_date, false)} — {fmtDate(f.sprint.end_date)}){f.task_kind !== 'planned' ? ', справочно' : ''}</span></>}
          {f.is_focus && <span className="pill beet" style={{ marginLeft: 6 }}>фокус релиза</span>}
        </dd>
        {f.task_kind === 'planned' && (<><dt>Плановая выкладка</dt><dd>{f.planned_production_date ? fmtDate(f.planned_production_date) : <span className="muted">—</span>}{f.baseline_production_date && f.baseline_production_date !== f.planned_production_date && <span className="muted small"> (обещали {fmtDate(f.baseline_production_date)})</span>}</dd></>)}
        <dt>Тип работы</dt>
        <dd>{KIND_LABEL[f.task_kind ?? 'planned']}{f.is_product_internal && <span className="pill outline" style={{ marginLeft: 6 }}>Внутренняя задача продукта</span>}</dd>
        {f.initiator !== undefined && (
          <>
            <dt>Инициатор</dt>
            <dd>
              {f.initiator ? <>{f.initiator.name}<span className="muted small"> {f.initiator.type === 'department' ? '(отдел)' : f.initiator.type === 'user' ? '(пользователь)' : ''}{f.initiator.inactive ? ', неактивен' : ''}</span></> : <span className="muted">Не указан</span>}
            </dd>
          </>
        )}
        {f.author_name !== undefined && (<><dt>Автор запроса</dt><dd>{f.author_name || '—'}</dd><dt>Ответственный</dt><dd>{f.assignee_name || '—'}</dd></>)}
        <dt>Поставлена</dt>
        <dd>{fmtDate(f.requested_at)}</dd>
        {(f.planned_start || f.planned_end) && (<><dt>План</dt><dd>{fmtDate(f.planned_start)} — {fmtDate(f.planned_end)}</dd></>)}
        {f.closed_at && (<><dt>Завершена</dt><dd>{fmtDate(f.closed_at)}</dd></>)}
        {f.external_ref && (<><dt>Внешний ID</dt><dd>{f.external_ref}</dd></>)}
        {f.sources?.length > 0 && (<><dt>Источники импорта</dt><dd>{f.sources.map((s: any) => <div key={s.source_id + s.external_id}>{s.source_name}: {s.external_id}</div>)}</dd></>)}
      </dl>
      {f.private_notes && (
        <div className="notice warn"><I.lock /><div><b>Приватная заметка.</b> <span className="pre">{f.private_notes}</span></div></div>
      )}
      {f.comments && (
        <section className="stack">
          <h3 style={{ fontSize: 15 }}>Комментарии</h3>
          {f.comments.length === 0 && <p className="muted">Комментариев пока нет.</p>}
          {f.comments.map((c: any) => (
            <div key={c.id} className="comment">
              <div className="row small"><b>{c.author_name}</b><span className="muted">{fmtDateTime(c.created_at)}</span>{c.moved_from && <span className="muted">перенесён при объединении</span>}</div>
              <p className="pre" style={{ marginTop: 4 }}>{c.body}</p>
            </div>
          ))}
          {me && !me.must_change_password && (
            <div className="stack tight">
              <textarea className="textarea" rows={2} placeholder="Добавить комментарий" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} />
              <div><button className="btn" disabled={!comment.trim()} onClick={async () => { if (await mutate(`/features/${f.id}/comments`, 'POST', { body: comment.trim() })) setComment(''); }}>Отправить</button></div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Priority({ f }: { f: any }) {
  const d = useDict();
  const { me } = useApp();
  const votes = new Map(f.votes.map((v: any) => [v.department_id, v]));
  return (
    <div className="stack loose">
      <div className="row" style={{ gap: 18 }}>
        <Cubes score={f.priority.score} size="lg" />
        <div className="small muted">
          {f.priority.voters ? <>Взвешенная оценка {f.priority.voters} отделов.<br />Последний голос: {fmtDateTime(f.priority.lastVotedAt)}</> : 'Отделы ещё не голосовали. Отсутствие голоса не считается низкой оценкой.'}
        </div>
      </div>
      <div className="panel flush">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Отдел</th><th className="r">Вес</th><th className="c">Оценка</th><th>Обновлено</th></tr></thead>
            <tbody>
              {d.activeDepts.map((dep) => {
                const v: any = votes.get(dep.id);
                const mine = me?.department_ids.includes(dep.id);
                return (
                  <tr key={dep.id}>
                    <td>{dep.name}{dep.is_product && <span className="muted small"> (решает при равенстве)</span>}{mine && <span className="pill beet" style={{ marginLeft: 8 }}>ваш отдел</span>}</td>
                    <td className="r num">{dep.weight}</td>
                    <td className="c"><VoteControl feature={f} dept={dep} vote={v} /></td>
                    <td className="muted small">{v ? fmtDate(v.voted_at) : 'не голосовал'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted">Шкала: 1 — почти не важно, 5 — критично. Формула: сумма (оценка × вес отдела) / сумма весов проголосовавших отделов.</p>
    </div>
  );
}

function Resources({ f }: { f: any }) {
  const { me, meta } = useApp();
  const d = useDict();
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  const canPlan = !!me?.permissions.plan && !me.must_change_password;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { move, modal } = usePlacement();
  useEffect(() => {
    setDraft({});
  }, [f.version, JSON.stringify(f.estimates)]);
  if (f.estimates === undefined) return <Empty title="Оценки трудозатрат не опубликованы">Они доступны сотрудникам после входа.</Empty>;
  const teams = d.activeTeams;
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    const estimates: Record<string, number | null> = {};
    const versions: Record<string, number | null> = {};
    for (const [t, val] of Object.entries(draft)) {
      estimates[t] = val.trim() === '' ? null : Number(val.replace(',', '.'));
      versions[t] = f.estimate_versions?.[t] ?? null;
    }
    if (Object.values(estimates).some((x) => x !== null && (Number.isNaN(x) || x < 0))) {
      toast('Часы должны быть неотрицательным числом', 'error');
      return;
    }
    const r = await mutate(`/features/${f.id}/estimates`, 'PUT', { estimates, versions }, 'Оценки сохранены');
    if (r) setDraft({});
  };
  return (
    <div className="stack loose">
      <div className="panel flush">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Команда</th><th className="r">Часы</th><th>Источник оценки</th></tr></thead>
            <tbody>
              {teams.map((t) => {
                const has = f.estimates[t.id] !== undefined;
                return (
                  <tr key={t.id}>
                    <td><span className="row"><span className="cube" style={{ background: t.color ?? 'var(--ink-3)' }} />{t.name}</span></td>
                    <td className="r" style={{ width: 140 }}>
                      {canEdit ? (
                        <input
                          className="input sm num"
                          inputMode="decimal"
                          aria-label={`Часы ${t.name}`}
                          placeholder="не оценено"
                          value={draft[t.id] ?? (has ? String(f.estimates[t.id]) : '')}
                          onChange={(e) => setDraft((s) => ({ ...s, [t.id]: e.target.value }))}
                        />
                      ) : has ? fmtH(f.estimates[t.id]) : <span className="muted">не оценено</span>}
                    </td>
                    <td className="small muted">{has ? (f.estimate_manual?.[t.id] === false ? 'из импорта' : 'уточнено вручную') : ''}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr><td><b>Итого</b></td><td className="r num"><b>{fmtH(f.estimate_total)}</b></td><td className="small muted">{f.estimate_missing?.length ? `не оценено: ${f.estimate_missing.length} ${f.estimate_missing.length === 1 ? 'команда' : 'команды'}` : ''}</td></tr>
            </tfoot>
          </table>
        </div>
      </div>
      {canEdit && (
        <div className="row">
          <button className="btn primary" disabled={!dirty} onClick={save}>Сохранить оценки</button>
          {dirty && <button className="btn ghost" onClick={() => setDraft({})}>Отменить</button>}
          <span className="small muted">Пустое поле — «не оценено», а не ноль. Ноль — команда не нужна.</span>
        </div>
      )}
      <ScheduleSection f={f} canEdit={canEdit} />
      <section className="stack">
        <h3 style={{ fontSize: 15 }}>Плановый период</h3>
        {canPlan ? (
          <div className="row wrap">
            <select className="select" style={{ maxWidth: 260 }} value={f.period?.id ?? ''} onChange={(e) => move(f, e.target.value || null)}>
              <option value="">Не запланирована</option>
              {meta.periods.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {f.period && (
              <label className="check">
                <input type="checkbox" checked={f.placement_locked} onChange={(e) => move(f, f.period.id, { lock: e.target.checked })} />
                Размещение утверждено (планировщик его не двигает)
              </label>
            )}
          </div>
        ) : (
          <p>{f.period ? f.period.name : <span className="muted">Не запланирована</span>}</p>
        )}
      </section>
      {modal}
    </div>
  );
}

/** Release → sprint → planned production date (FR-06). Bugs keep a sprint only as a reference. */
function ScheduleSection({ f, canEdit }: { f: any; canEdit: boolean }) {
  const releases = useApi<any>(canEdit ? '/releases' : null);
  const sprintsQ = useApi<any>(canEdit ? '/sprints' : null);
  const planned = f.task_kind === 'planned';
  const [v, setV] = useState({ release_id: f.release?.id ?? '', sprint_id: f.sprint?.id ?? '', date: '' });
  const [pending, setPending] = useState<any | null>(null);
  useEffect(() => {
    setV({ release_id: f.release?.id ?? '', sprint_id: f.sprint?.id ?? '', date: '' });
  }, [f.id, f.version]);
  if (!canEdit || f.is_product_internal) return null;
  const sprints = (sprintsQ.data?.sprints ?? []).filter((s: any) => s.status !== 'closed' || s.id === f.sprint?.id);
  const ofRelease = planned && v.release_id ? sprints.filter((s: any) => s.release_id === v.release_id) : sprints;
  const sprint = sprints.find((s: any) => s.id === v.sprint_id);
  const send = async (extra: Record<string, unknown> = {}) => {
    const body: Record<string, unknown> = { sprint_id: v.sprint_id || null, version: f.version, ...extra };
    if (planned) body.release_id = v.release_id || null;
    if (planned && v.date) body.planned_production_date = v.date;
    try {
      await api(`/features/${f.id}/schedule`, { method: 'PATCH', body });
      invalidate();
      toast('План задачи обновлён');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'approved') setPending(body);
      else { toast((e as Error).message, 'error'); invalidate(); }
    }
  };
  const changed = v.release_id !== (f.release?.id ?? '') || v.sprint_id !== (f.sprint?.id ?? '') || !!v.date;
  return (
    <section className="stack">
      <h3 style={{ fontSize: 15 }}>{planned ? 'Релиз, спринт и выкладка' : 'Спринт (справочно)'}</h3>
      {!planned && <p className="small muted">Баги и оперативные доработки не входят в план спринта и релиза — спринт указывает, в ходе какого спринта идёт исправление.</p>}
      <div className="row wrap">
        {planned && (
          <select className="select" style={{ maxWidth: 220 }} value={v.release_id} onChange={(e) => setV({ release_id: e.target.value, sprint_id: '', date: '' })} aria-label="Релиз">
            <option value="">Без релиза</option>
            {(releases.data?.releases ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <select className="select" style={{ maxWidth: 260 }} value={v.sprint_id} onChange={(e) => {
          const s = sprints.find((x: any) => x.id === e.target.value);
          setV((x) => ({ ...x, sprint_id: e.target.value, release_id: planned && s ? s.release_id : x.release_id }));
        }} aria-label="Спринт">
          <option value="">Без спринта</option>
          {ofRelease.map((s: any) => <option key={s.id} value={s.id}>Спринт {s.code} · {fmtDate(s.start_date, false)} — {fmtDate(s.end_date)}</option>)}
        </select>
        {planned && (
          <label className="row small" title="Пусто — срок выкладки спринта">
            выкладка
            <input type="date" className="input sm" value={v.date} placeholder={sprint?.production_due ?? ''} onChange={(e) => setV((x) => ({ ...x, date: e.target.value }))} />
          </label>
        )}
        <button className="btn primary sm" disabled={!changed} onClick={() => send()}>Сохранить</button>
      </div>
      {planned && sprint && <div className="small muted">Разработка {fmtDate(sprint.start_date, false)} — {fmtDate(sprint.end_date)}, тестирование с {fmtDate(sprint.testing_start)}, выкладка до {fmtDate(sprint.production_due)}.</div>}
      {pending && (
        <ReasonModal title="Релиз утверждён" confirmText="Изменить состав" onClose={() => setPending(null)} onConfirm={async (reason) => { const p = pending; setPending(null); await send({ ...p, confirm_approved_change: true, reason }); }}>
          <p>Задача меняет состав утверждённого релиза. Укажите причину — она попадёт в журнал.</p>
        </ReasonModal>
      )}
    </section>
  );
}

function RefList({ title, items, onRemove }: { title: string; items: any[]; onRemove?: (relationId: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="stack tight">
      <div className="small muted">{title}</div>
      {items.map((x, i) =>
        x.hidden ? (
          <div key={i} className="row small muted" style={{ padding: '6px 0' }}><I.eyeOff style={{ width: 15, height: 15 }} /> Внутренняя задача</div>
        ) : (
          <div key={x.id + i} className="row" style={{ padding: '4px 0' }}>
            <a href={`?f=${x.key}`} onClick={(e) => { e.preventDefault(); openFeature(x.key); }} className="row grow" style={{ minWidth: 0 }}>
              <span className="key">{x.key}</span>
              <span className="ellipsis grow">{x.title}</span>
            </a>
            <StatusPill status={x.status} />
            {onRemove && x.relation_id && <button className="btn ghost sm icon" title="Удалить связь" aria-label="Удалить связь" onClick={() => onRemove(x.relation_id)}><I.x /></button>}
          </div>
        ),
      )}
    </div>
  );
}

function Links({ f }: { f: any }) {
  const { me } = useApp();
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  const [adding, setAdding] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const remove = canEdit ? (id: string) => mutate(`/relations/${id}`, 'DELETE', undefined, 'Связь удалена') : undefined;
  const r = f.relations;
  const empty = !Object.values(r).flat().length && !f.offers.length;
  return (
    <div className="stack loose">
      {empty && <Empty title="Связей нет">{canEdit ? 'Добавьте блокировку, связанную задачу или оффер.' : null}</Empty>}
      <RefList title="Блокирует" items={r.blocks} onRemove={remove} />
      <RefList title="Заблокирована задачами" items={r.blocked_by} onRemove={remove} />
      <RefList title="Связанные задачи" items={r.related} onRemove={remove} />
      <RefList title="Дубль задачи" items={r.duplicate_of} onRemove={remove} />
      <RefList title="Дубли этой задачи" items={r.duplicates} onRemove={remove} />
      {f.merged_duplicates?.length > 0 && (
        <div className="stack tight">
          <div className="small muted">Объединённые дубли</div>
          {f.merged_duplicates.map((m: any) => <div key={m.id} className="row small"><span className="key">{m.key}</span>{m.title}</div>)}
        </div>
      )}
      {f.offers.length > 0 && (
        <div className="stack tight">
          <div className="small muted">Влияет на офферы</div>
          {f.offers.map((o: any) => (
            <a key={o.id} href={`/offers/${o.id}`} onClick={(e) => { e.preventDefault(); navigate(`/offers/${o.id}`); }} className="row" style={{ padding: '4px 0' }}>
              <I.offers style={{ width: 15, height: 15, color: 'var(--ink-3)' }} />
              <span>{o.external_code && <span className="key">{o.external_code} </span>}{o.name}</span>
            </a>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="row wrap" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <button className="btn sm" onClick={() => setAdding('blocks')}>Блокирует…</button>
          <button className="btn sm" onClick={() => setAdding('blocked_by')}>Заблокирована…</button>
          <button className="btn sm" onClick={() => setAdding('related_to')}>Связать</button>
          <button className="btn sm" onClick={() => setAdding('duplicate_of')}>Отметить дублем</button>
          <span className="grow" />
          <button className="btn sm" onClick={() => setMerging(true)}><I.merge /> Объединить с…</button>
        </div>
      )}
      {adding && (
        <Modal title={{ blocks: `${f.key} блокирует задачу`, blocked_by: `${f.key} заблокирована задачей`, related_to: 'Связанная задача', duplicate_of: `${f.key} — дубль задачи` }[adding]} onClose={() => setAdding(null)}>
          <FeaturePicker exclude={[f.id]} onPick={async (t) => { if (await mutate(`/features/${f.id}/relations`, 'POST', { type: adding, target_id: t.id }, 'Связь добавлена')) setAdding(null); }} />
        </Modal>
      )}
      {merging && <MergeDialog f={f} onClose={() => setMerging(false)} />}
    </div>
  );
}

function MergeDialog({ f, onClose }: { f: any; onClose: () => void }) {
  const [target, setTarget] = useState<any>(null);
  const preview = useApi<any>(target ? `/features/${f.id}/merge-preview?target_id=${target.id}` : null);
  const [choices, setChoices] = useState<Record<string, 'source' | 'target'>>({});
  const p = preview.data;
  const ready = p && !p.cycle && p.vote_conflicts.every((c: any) => choices[c.department_id]);
  return (
    <Modal
      wide
      title={`Объединить ${f.key} с основной карточкой`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button
            className="btn primary"
            disabled={!ready}
            onClick={async () => {
              const r = await mutate(`/features/${f.id}/merge`, 'POST', { target_id: p.target.id, source_version: p.source.version, target_version: p.target.version, vote_choices: choices, confirm: true }, `${f.key} объединена с ${p.target.key}`);
              if (r) { onClose(); openFeature(p.target.key); }
            }}
          >
            Объединить
          </button>
        </>
      }
    >
      {!target ? (
        <div className="stack">
          <p>Выберите основную карточку. {f.key} станет её дублем: связи, офферы, комментарии, источники импорта и история перейдут в основную, старая ссылка продолжит работать.</p>
          <FeaturePicker exclude={[f.id]} onPick={setTarget} />
        </div>
      ) : !p ? (
        preview.error ? <ErrorBox error={preview.error} /> : <Loading />
      ) : (
        <div className="stack loose">
          <p><b>{p.source.key}</b> {p.source.title}<br />будет объединена с <b>{p.target.key}</b> {p.target.title}</p>
          {p.cycle && <div className="notice danger"><I.alert /><span>После объединения появится циклическая зависимость. Сначала удалите лишние блокировки.</span></div>}
          {p.vote_conflicts.length > 0 && (
            <section className="stack">
              <h4>Оценки отделов расходятся — выберите итоговую</h4>
              {p.vote_conflicts.map((c: any) => (
                <div key={c.department_id} className="row">
                  <span className="grow">{c.department}</span>
                  <div className="choice">
                    <button className={choices[c.department_id] === 'source' ? 'on' : ''} onClick={() => setChoices((s) => ({ ...s, [c.department_id]: 'source' }))}>{p.source.key}: {c.source_score}</button>
                    <button className={choices[c.department_id] === 'target' ? 'on' : ''} onClick={() => setChoices((s) => ({ ...s, [c.department_id]: 'target' }))}>{p.target.key}: {c.target_score}</button>
                  </div>
                </div>
              ))}
            </section>
          )}
          {p.estimates.length > 0 && (
            <section className="stack tight">
              <h4>Трудозатраты не суммируются</h4>
              {p.estimates.map((e: any) => (
                <div key={e.team_id} className="small">{e.team}: {e.action === 'move' ? `перейдёт из ${p.source.key} (${e.source} ч)` : `останется ${e.target} ч основной карточки (у дубля ${e.source} ч)`}</div>
              ))}
            </section>
          )}
          <p className="small muted">Перейдут: комментарии ({p.counts.comments}), офферы ({p.counts.offers}), источники импорта ({p.counts.sources}), связи ({p.counts.relations_moved}). Повторяющиеся связи будут убраны ({p.counts.relations_dropped}).</p>
          <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTarget(null)}>Выбрать другую карточку</button>
        </div>
      )}
    </Modal>
  );
}

const ACTIONS: Record<string, string> = {
  created: 'создал(а) карточку', updated: 'изменил(а)', estimates_changed: 'изменил(а) оценки', vote: 'проголосовал(а)', vote_admin_override: 'изменил(а) оценку отдела (админ)',
  moved: 'перенёс(ла) в другой период', moved_over_capacity: 'перенёс(ла) с превышением лимита', plan_approved: 'утвердил(а) размещение по плану',
  relation_added: 'добавил(а) связь', relation_removed: 'удалил(а) связь', comment_added: 'оставил(а) комментарий', merged_into: 'объединил(а) с другой карточкой',
  merged_from: 'присоединил(а) дубль', import_created: 'создано импортом', import_updated: 'обновлено импортом', import_linked: 'привязан источник импорта', import_relation: 'связь из импорта',
};

const FIELD: Record<string, string> = {
  title: 'название', description: 'описание', status_id: 'статус', stage_id: 'этап', category_id: 'категория', epic_id: 'эпик', visibility: 'публикация',
  period_id: 'период', placement_locked: 'фиксация', closed_at: 'дата завершения', tags: 'теги', offers: 'офферы', author_name: 'автор', assignee_name: 'ответственный',
  requested_at: 'дата постановки', planned_start: 'плановое начало', planned_end: 'плановое завершение', private_notes: 'заметки', external_ref: 'внешний ID',
  task_kind: 'тип работы', is_product_internal: 'внутренняя задача продукта', initiator: 'инициатор', initiator_type: 'вид инициатора', initiator_name: 'инициатор',
  initiator_user_id: 'инициатор (пользователь)', initiator_department_id: 'инициатор (отдел)',
  blocks: 'блокирует', related_to: 'связана', duplicate_of: 'дубль', merged_into: 'объединена с', merged_from: 'дубль', source: 'строка источника',
};

function History({ f }: { f: any }) {
  const { meta } = useApp();
  const label = (field: string, v: any): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (field === 'status_id') return meta.statuses.find((s) => s.id === v)?.name ?? v;
    if (field === 'stage_id') return meta.stages.find((s) => s.id === v)?.name ?? v;
    if (field === 'category_id') return meta.categories.find((s) => s.id === v)?.name ?? v;
    if (field === 'period_id') return meta.periods.find((s) => s.id === v)?.name ?? v;
    if (field === 'placement_locked') return v ? 'да' : 'нет';
    if (field === 'description' || field === 'private_notes') return String(v).length > 80 ? `${String(v).slice(0, 80)}…` : String(v);
    if (Array.isArray(v)) return v.join(', ') || '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  if (!f.history.length) return <Empty title="История пуста" />;
  return (
    <div className="history">
      {f.history.map((h: any) => (
        <div key={h.id} className="history-item">
          <div className="muted small">{fmtDateTime(h.at)}</div>
          <div className="stack tight">
            <div><b>{h.actor_name}</b> {ACTIONS[h.action] ?? h.action}{h.is_override && <span className="pill warn" style={{ marginLeft: 6 }}>с подтверждением</span>}</div>
            {(h.changes ?? []).map((c: any, i: number) => (
              <div key={i} className="change small">
                <span className="muted">{FIELD[c.field] ?? c.field.replace(/^hours:/, 'часы ').replace(/^vote:/, 'оценка ')}:</span>
                {c.old !== null && c.old !== undefined && <span className="old">{label(c.field, c.old)}</span>}
                <span>{label(c.field, c.new)}</span>
              </div>
            ))}
            {h.reason && <div className="small muted">Причина: {h.reason}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}


import { useEffect, useState } from 'react';
import { I } from '../icons';
import { FeatureCard, FeatureForm, FeatureTitle } from '../features';
import { fmtH, mutate, navigate, openFeature, useApi, useApp, useDebounced, useDict, useLocation } from '../lib';
import { Cubes, Empty, ErrorBox, GuestNote, Loading, PageHead, Seg, StatusPill, VisBadge } from '../ui';

const FILTERS = ['status', 'category', 'epic', 'department', 'offer', 'release', 'period'] as const;
const FLAG_LABEL: Record<string, string> = { open: 'Открытые задачи', blocked: 'С блокировками', unvoted: 'Без голосов отделов', unestimated: 'Без оценки часов' };
const SEMANTIC_LABEL: Record<string, string> = { new: 'новые', analysis: 'на проработке', ready: 'готовы к планированию', planned: 'запланированы', in_progress: 'в работе', blocked: 'заблокированы', postponed: 'отложены', done: 'завершены', cancelled: 'отменены' };

export function Backlog() {
  const { me, meta } = useApp();
  const d = useDict();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q, 250);
  const [creating, setCreating] = useState(false);
  const view = (params.get('view') as 'table' | 'board') ?? 'table';
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`/backlog${p.toString() ? `?${p}` : ''}`, true);
  };
  useEffect(() => {
    if ((params.get('q') ?? '') !== dq) setParam('q', dq || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const apiQs = new URLSearchParams();
  for (const k of [...FILTERS, 'q', 'sort', 'hide_closed', 'visibility', 'flag', 'tag']) {
    const v = params.get(k);
    if (v) apiQs.set(k, v);
  }
  const { data, error, loading } = useApi<any>(`/features?${apiQs}`);
  const epics = useApi<any>('/epics');
  const offers = useApi<any>('/offers');
  const releases = useApi<any>('/releases');
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  const showHours = meta.viewer !== 'guest' || meta.settings.public_show_estimates;
  const activeFilters = FILTERS.filter((k) => params.get(k)).length + (params.get('q') ? 1 : 0) + (params.get('flag') ? 1 : 0) + (params.get('tag') ? 1 : 0);
  // quick filters coming from the overview tiles / tags (not represented by the selects)
  const statusParam = params.get('status');
  const semanticStatus = statusParam && !d.statuses('feature').some((s) => s.id === statusParam) ? SEMANTIC_LABEL[statusParam] ?? statusParam : null;
  const chips: { key: string; label: string }[] = [
    ...(params.get('flag') ? [{ key: 'flag', label: FLAG_LABEL[params.get('flag')!] ?? params.get('flag')! }] : []),
    ...(semanticStatus ? [{ key: 'status', label: `Статус: ${semanticStatus}` }] : []),
    ...(params.get('tag') ? [{ key: 'tag', label: `Тег: ${params.get('tag')}` }] : []),
  ];

  const sel = (k: string, label: string, options: { id: string; name: string }[], extra?: { id: string; name: string }[]) => (
    <select className="select" aria-label={label} value={params.get(k) ?? ''} onChange={(e) => setParam(k, e.target.value || null)}>
      <option value="">{label}</option>
      {extra?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );

  return (
    <>
      <PageHead title="Бэклог" sub="Все известные продуктовые доработки с приоритетами отделов, оценками и планом.">
        <Seg value={view} onChange={(v) => setParam('view', v === 'table' ? null : v)} items={[{ id: 'table', label: <I.table />, title: 'Таблица' }, { id: 'board', label: <I.board />, title: 'Канбан по статусам' }]} />
        {canEdit && <button className="btn primary" onClick={() => setCreating(true)}><I.plus />Новая задача</button>}
      </PageHead>
      <GuestNote />
      <div className="toolbar">
        <div className="search" style={{ width: 260 }}>
          <I.search />
          <input className="input" placeholder="Поиск по названию, номеру, тегам" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" />
        </div>
        {sel('status', 'Все статусы', d.statuses('feature').map((s) => ({ id: s.id, name: s.name })))}
        {sel('category', 'Все категории', meta.categories.map((c) => ({ id: c.id, name: c.name })))}
        {sel('epic', 'Все эпики', (epics.data?.epics ?? []).map((e: any) => ({ id: e.id, name: e.title })), [{ id: 'none', name: 'Без эпика' }])}
        {sel('department', 'Интерес отдела', d.activeDepts.map((x) => ({ id: x.id, name: x.name })))}
        {sel('offer', 'Все офферы', (offers.data?.offers ?? []).map((o: any) => ({ id: o.id, name: o.name })))}
        {sel('release', 'Все релизы', (releases.data?.releases ?? []).map((r: any) => ({ id: r.id, name: r.name })), [{ id: 'none', name: 'Вне релизов' }])}
        {sel('period', 'Все периоды', d.activePeriods.map((p) => ({ id: p.id, name: p.name })), [{ id: 'none', name: 'Не запланированы' }])}
        <select className="select" aria-label="Сортировка" value={params.get('sort') ?? 'priority'} onChange={(e) => setParam('sort', e.target.value === 'priority' ? null : e.target.value)}>
          <option value="priority">По приоритету</option>
          <option value="number">По номеру</option>
          <option value="newest">Сначала новые</option>
          <option value="status">По статусу</option>
          <option value="title">По названию</option>
        </select>
        <label className="check small">
          <input type="checkbox" checked={params.get('hide_closed') === '1'} onChange={(e) => setParam('hide_closed', e.target.checked ? '1' : null)} />
          Скрыть завершённые
        </label>
        {activeFilters > 0 && <button className="btn ghost sm" onClick={() => { setQ(''); navigate(`/backlog${view === 'board' ? '?view=board' : ''}`, true); }}>Сбросить фильтры</button>}
        <span className="grow" />
        {data && <span className="muted small">{data.total} {data.total === 1 ? 'задача' : 'задач'}</span>}
      </div>
      {chips.length > 0 && (
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <span className="small muted">Показаны:</span>
          {chips.map((c) => (
            <button key={c.key} className="pill beet" style={{ border: 0, cursor: 'pointer' }} onClick={() => setParam(c.key, null)} title="Снять фильтр">
              {c.label} ✕
            </button>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      {!data && loading && <div className="panel"><Loading rows={8} /></div>}
      {data && view === 'table' && (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 40 }} className="r">#</th>
                  <th>Приоритет</th>
                  <th>Задача</th>
                  <th>Статус</th>
                  <th className="hide-sm">Этап</th>
                  <th className="c">Отделов</th>
                  {showHours && <th className="r">Часы</th>}
                  <th className="hide-sm">Период</th>
                  <th className="hide-sm">Релиз</th>
                </tr>
              </thead>
              <tbody>
                {data.features.length === 0 && (
                  <tr><td colSpan={9}><Empty title="Ничего не найдено">Измените фильтры или поисковый запрос.</Empty></td></tr>
                )}
                {data.features.map((f: any, i: number) => (
                  <tr key={f.id} className="click" onClick={() => openFeature(f.key)}>
                    <td className="r muted small">{(params.get('sort') ?? 'priority') === 'priority' ? i + 1 : ''}</td>
                    <td><Cubes score={f.priority.score} /></td>
                    <td>
                      <div className="row top">
                        <span className="key" style={{ paddingTop: 1 }}>{f.key}</span>
                        <FeatureTitle f={f} />
                      </div>
                    </td>
                    <td><div className="stack tight" style={{ alignItems: 'flex-start' }}><StatusPill status={f.status} />{f.visibility && f.visibility !== 'public' && <VisBadge v={f.visibility} />}</div></td>
                    <td className="hide-sm small">{f.stage?.name ?? <span className="muted">—</span>}</td>
                    <td className="c num">{f.priority.voters || <span className="muted">—</span>}</td>
                    {showHours && <td className="r num nowrap">{f.estimate_total ? fmtH(f.estimate_total) : <span className="muted">не оценено</span>}</td>}
                    <td className="hide-sm small nowrap">{f.period ? <>{f.period.name}{f.placement_locked && <I.lock style={{ width: 12, height: 12, marginLeft: 4, verticalAlign: '-1px' }} />}</> : <span className="muted">—</span>}</td>
                    <td className="hide-sm small">{f.release ? (f.release.version_label ?? f.release.name) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data && view === 'board' && <Board features={data.features} canEdit={canEdit} />}
      {creating && <FeatureForm onClose={() => setCreating(false)} />}
    </>
  );
}

function Board({ features, canEdit }: { features: any[]; canEdit: boolean }) {
  const d = useDict();
  const [over, setOver] = useState<string | null>(null);
  const statuses = d.statuses('feature');
  const drop = async (statusId: string, featureId: string) => {
    setOver(null);
    const f = features.find((x) => x.id === featureId);
    if (!f || f.status.id === statusId) return;
    await mutate(`/features/${f.id}`, 'PATCH', { status_id: statusId, version: f.version }, `${f.key}: статус изменён`);
  };
  return (
    <div className="board">
      {statuses.map((s) => {
        const items = features.filter((f) => f.status.id === s.id);
        return (
          <section
            key={s.id}
            className={`lane ${over === s.id ? 'drop' : ''}`}
            onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(s.id); } : undefined}
            onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
            onDrop={canEdit ? (e) => { e.preventDefault(); drop(s.id, e.dataTransfer.getData('text/plain')); } : undefined}
            aria-label={s.name}
          >
            <div className="lane-head">
              <StatusPill status={s} />
              <span className="n">{items.length}</span>
            </div>
            <div className="lane-cards">
              {items.map((f) => <FeatureCard key={f.id} f={f} draggable={canEdit} />)}
              {items.length === 0 && <div className="small muted" style={{ padding: '8px 4px' }}>{canEdit ? 'Перетащите карточку сюда' : 'Пусто'}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

import { useState } from 'react';
import { I } from '../icons';
import { FeatureTitle } from '../features';
import { fmtDate, mutate, navigate, openFeature, useApi, useApp, useDict } from '../lib';
import { Cubes, Empty, ErrorBox, Field, GuestNote, Loading, Modal, PageHead, RichText, StatusPill, VisBadge } from '../ui';

export function Offers() {
  const { me } = useApp();
  const { data, error } = useApi<any>('/offers');
  const [q, setQ] = useState('');
  const [dir, setDir] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  const offers = (data?.offers ?? []).filter((o: any) =>
    (!q || `${o.external_code ?? ''} ${o.name}`.toLowerCase().includes(q.toLowerCase())) && (!dir || o.direction === dir));
  const directions = [...new Set((data?.offers ?? []).map((o: any) => o.direction).filter(Boolean))] as string[];
  return (
    <>
      <PageHead title="Офферы" sub="Бизнес-офферы платформы и доработки, которые на них влияют.">
        {canEdit && <button className="btn primary" onClick={() => setEdit({})}><I.plus />Новый оффер</button>}
      </PageHead>
      <GuestNote />
      <div className="toolbar">
        <div className="search" style={{ width: 280 }}><I.search /><input className="input" placeholder="Поиск по ID и названию" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" /></div>
        <select className="select" value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Направление">
          <option value="">Все направления</option>
          {directions.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      {!data ? <div className="panel"><Loading rows={6} /></div> : (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>ID</th><th>Оффер</th><th>Направление</th><th>Статус</th><th className="c">Доработок</th><th>Релизы</th></tr></thead>
              <tbody>
                {offers.length === 0 && <tr><td colSpan={6}><Empty title="Офферы не найдены" /></td></tr>}
                {offers.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => navigate(`/offers/${o.id}`)}>
                    <td className="key">{o.external_code ?? '—'}</td>
                    <td className="title-cell"><div className="t">{o.name}</div><div className="sub ellipsis" style={{ maxWidth: 420 }}>{o.description}</div></td>
                    <td className="small">{o.direction ?? '—'}</td>
                    <td><div className="stack tight" style={{ alignItems: 'flex-start' }}><StatusPill status={o.status} /><VisBadge v={o.visibility !== 'public' ? o.visibility : undefined} /></div></td>
                    <td className="c num">{o.open_feature_count}<span className="muted"> / {o.feature_count}</span></td>
                    <td className="small">{o.releases.map((r: any) => r.version_label ?? r.name).join(', ') || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {edit && <OfferForm offer={edit.id ? edit : null} onClose={() => setEdit(null)} />}
    </>
  );
}

export function OfferDetail({ id }: { id: string }) {
  const { me } = useApp();
  const { data, error } = useApi<any>(`/offers/${id}`);
  const [edit, setEdit] = useState(false);
  const o = data?.offer;
  if (!o) return <><PageHead title="Оффер" />{error ? <ErrorBox error={error} /> : <Loading />}</>;
  const canEdit = !!me?.permissions.edit_catalog && !me.must_change_password;
  return (
    <>
      <div className="small" style={{ marginBottom: 8 }}><a href="/offers" onClick={(e) => { e.preventDefault(); navigate('/offers'); }} className="muted">Все офферы</a></div>
      <PageHead title={o.name} sub={<span className="row wrap">{o.external_code && <span className="key">{o.external_code}</span>}<StatusPill status={o.status} />{o.direction && <span>{o.direction}</span>}<VisBadge v={o.visibility} /></span>}>
        {canEdit && <button className="btn" onClick={() => setEdit(true)}>Изменить</button>}
      </PageHead>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2 className="grow">Доработки, влияющие на оффер</h2><span className="muted small">{o.features.length}</span></div>
          <div className="list">
            {o.features.length === 0 && <Empty title="Связанных доработок нет">Свяжите задачу с оффером в её карточке.</Empty>}
            {o.features.map((f: any) => (
              <div key={f.id} className="list-item" onClick={() => openFeature(f.key)}>
                <span className="key">{f.key}</span>
                <div className="grow" style={{ minWidth: 0 }}><FeatureTitle f={f} /></div>
                <StatusPill status={f.status} />
                <span className="hide-sm"><Cubes score={f.priority.score} /></span>
              </div>
            ))}
          </div>
        </section>
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Описание</h2></div>
            <div className="panel-body"><RichText text={o.description} /></div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Планируемые релизы</h2></div>
            <div className="list">
              {o.releases.length === 0 && <Empty title="Доработки оффера пока не включены в релизы" />}
              {o.releases.map((r: any) => (
                <div key={r.id} className="list-item" onClick={() => navigate(`/releases/${r.id}`)}>
                  <I.releases style={{ width: 16, height: 16, color: 'var(--beet)' }} />
                  <span className="grow">{r.name}</span>
                  <span className="small muted">{fmtDate(r.planned_date)}</span>
                  {r.approved && <span className="pill ok">утверждён</span>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      {edit && <OfferForm offer={o} onClose={() => setEdit(false)} />}
    </>
  );
}

function OfferForm({ offer, onClose }: { offer: any | null; onClose: () => void }) {
  const { meta } = useApp();
  const d = useDict();
  const [v, setV] = useState({
    name: offer?.name ?? '', external_code: offer?.external_code ?? '', description: offer?.description ?? '', direction: offer?.direction ?? '',
    category_id: offer?.category?.id ?? '', status_id: offer?.status?.id ?? d.statuses('offer')[0]?.id ?? '', visibility: offer?.visibility ?? 'internal',
  });
  const set = (k: string) => (e: any) => setV((s) => ({ ...s, [k]: e.target.value }));
  const n = (x: string) => (x === '' ? null : x);
  const submit = async () => {
    const body = { ...v, external_code: n(v.external_code), direction: n(v.direction), category_id: n(v.category_id) };
    const r = offer ? await mutate(`/offers/${offer.id}`, 'PATCH', { ...body, version: offer.version }, 'Оффер сохранён') : await mutate('/offers', 'POST', body, 'Оффер создан');
    if (r) onClose();
  };
  return (
    <Modal title={offer ? 'Оффер' : 'Новый оффер'} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!v.name.trim()} onClick={submit}>Сохранить</button></>}>
      <div className="form-grid">
        <Field label="Название" span2><input className="input" value={v.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Внешний ID оффера"><input className="input" value={v.external_code} onChange={set('external_code')} placeholder="OF-1024" /></Field>
        <Field label="Направление"><input className="input" value={v.direction} onChange={set('direction')} placeholder="МФО, Банки…" /></Field>
        <Field label="Описание" span2><textarea className="textarea" value={v.description} onChange={set('description')} /></Field>
        <Field label="Категория">
          <select className="select" value={v.category_id} onChange={set('category_id')}>
            <option value="">Без категории</option>
            {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Статус">
          <select className="select" value={v.status_id} onChange={set('status_id')}>
            {d.statuses('offer').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Публикация">
          <select className="select" value={v.visibility} onChange={set('visibility')}>
            <option value="draft">Черновик</option><option value="internal">Внутренний</option><option value="public">Опубликован</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

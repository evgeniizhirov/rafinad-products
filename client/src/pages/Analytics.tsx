// Analytics (FR-11): a separate section, not the overview. Every figure opens the tasks behind it in the backlog
// (/backlog?ids=…), where the server re-applies all access rules. Hidden Product tasks never enter the figures.
import { useState } from 'react';
import { navigate, useApi, useApp } from '../lib';
import { Empty, ErrorBox, Loading, Notice, PageHead } from '../ui';

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => day(new Date(Date.now() - n * 86_400_000));
const MAX_IDS = 400; // keeps the drill-down URL reasonable
const KIND = [
  { id: '', name: 'Все типы задач' },
  { id: 'planned', name: 'Плановые' },
  { id: 'bug', name: 'Баги' },
  { id: 'operational_improvement', name: 'Оперативные доработки' },
];
const SEM: Record<string, string> = {
  new: 'Новые', analysis: 'Анализ', ready: 'Готовы', planned: 'Запланированы', in_progress: 'В работе',
  blocked: 'Заблокированы', postponed: 'Отложены', done: 'Сделаны', cancelled: 'Отменены',
};

function drill(ids: string[] | undefined) {
  if (!ids?.length) return undefined;
  return () => navigate(`/backlog?ids=${ids.slice(0, MAX_IDS).join(',')}`);
}

function Tile({ value, label, ids, suffix, alert, hint }: { value: number | null | undefined; label: string; ids?: string[]; suffix?: string; alert?: boolean; hint?: string }) {
  const go = drill(ids);
  const body = (
    <>
      <b className="num">{value === null || value === undefined ? '—' : `${value}${suffix ?? ''}`}</b>
      <span>{label}</span>
      {hint && <span className="small muted" style={{ display: 'block' }}>{hint}</span>}
    </>
  );
  return go
    ? <a className={`kpi ${alert ? 'alert' : ''}`} href="#" onClick={(e) => { e.preventDefault(); go(); }} title={ids!.length > MAX_IDS ? `Откроются первые ${MAX_IDS} задач` : 'Показать эти задачи списком'}>{body}</a>
    : <div className={`kpi ${alert ? 'alert' : ''}`}>{body}</div>;
}

function MetricTile({ m, label, suffix, alert }: { m: any; label: string; suffix?: string; alert?: boolean }) {
  return <Tile value={m?.value} label={label} ids={m?.ids} suffix={suffix} alert={alert} hint={m?.insufficient} />;
}

export function Analytics() {
  const { me } = useApp();
  const [from, setFrom] = useState(daysAgo(89));
  const [to, setTo] = useState(day(new Date()));
  const [kind, setKind] = useState('');
  const qs = new URLSearchParams({ from, to, ...(kind ? { kind } : {}) });
  const { data: a, error } = useApi<any>(me ? `/analytics/summary?${qs}` : null);
  if (!me) return <Empty title="Аналитика доступна после входа" />;
  const preset = (n: number) => { setFrom(daysAgo(n - 1)); setTo(day(new Date())); };
  return (
    <>
      <PageHead title="Аналитика" sub="Объём и сроки работ, блокировки, кто создаёт задачи и на что есть спрос. Каждая цифра открывает список задач, из которых она получена.">
        <select className="select" aria-label="Тип задач" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
          {KIND.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <input className="input" type="date" aria-label="С" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={{ width: 'auto' }} />
        <input className="input" type="date" aria-label="По" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} style={{ width: 'auto' }} />
        <button className="btn ghost sm" onClick={() => preset(30)}>30 дней</button>
        <button className="btn ghost sm" onClick={() => preset(90)}>90 дней</button>
      </PageHead>
      <ErrorBox error={error} />
      {!a ? <div className="panel"><Loading rows={8} /></div> : (
        <div className="stack loose">
          <Notice kind="info">
            Статусы считаются по их смыслу (новая, в работе, сделана…), поэтому переименование статуса не меняет цифры.
            Сроки и время цикла берутся из журнала изменений: у задач, созданных до его появления, истории нет — такие задачи не попадают в эти показатели, а не считаются «нулём».
            Внутренние задачи Product в аналитику не входят.
          </Notice>

          <section>
            <h2 className="section-h">Объём и операционка</h2>
            <div className="kpis">
              <MetricTile m={a.volume.received} label="поступило за период" />
              <MetricTile m={a.volume.open} label="открыто сейчас" />
              <MetricTile m={a.volume.in_progress} label="в работе" />
              <MetricTile m={a.volume.done_in_period} label="сделано за период" />
              <MetricTile m={a.volume.postponed} label="отложено" />
              <MetricTile m={a.volume.cancelled} label="отменено" />
              <MetricTile m={a.volume.overdue} label="просрочено" alert={a.volume.overdue.value > 0} />
              <MetricTile m={a.volume.blocked} label="заблокировано" alert={a.volume.blocked.value > 0} />
            </div>
            <div className="kpis">
              <MetricTile m={a.volume.bugs_new} label="новых багов" />
              <MetricTile m={a.volume.bugs_active} label="активных багов" />
              <MetricTile m={a.volume.bugs_resolved} label="исправлено багов" />
              <MetricTile m={a.volume.improvements} label="оперативных доработок" />
            </div>
          </section>

          <section>
            <h2 className="section-h">Сроки</h2>
            <div className="kpis">
              <MetricTile m={a.timeliness} label="сделано к первоначальному сроку" suffix="%" />
              <Tile value={a.timeliness.extra?.without_baseline?.length ?? 0} label="сделано без зафиксированного срока" ids={a.timeliness.extra?.without_baseline} />
              <MetricTile m={a.cycle_time.bugs} label="медиана цикла багов и доработок, дн." />
              <MetricTile m={a.cycle_time.planned} label="медиана цикла плановых, дн." />
              <MetricTile m={a.release_discipline} label="фокусных задач сдано в релиз" suffix="%" />
            </div>
            <p className="small muted">
              Срок сравнивается с первым обещанным (baseline), а не с последней перенесённой датой.
              {a.cycle_time.bugs.extra && ` Баги: p75 ${a.cycle_time.bugs.extra.p75} дн., p90 ${a.cycle_time.bugs.extra.p90} дн., n = ${a.cycle_time.bugs.extra.n}.`}
              {a.cycle_time.planned.extra && ` Плановые: p75 ${a.cycle_time.planned.extra.p75} дн., p90 ${a.cycle_time.planned.extra.p90} дн., n = ${a.cycle_time.planned.extra.n}.`}
            </p>
          </section>

          <div className="grid-2">
            <section className="panel">
              <div className="panel-head"><h2 className="grow">Кто создаёт задачи</h2></div>
              <div className="panel-body"><Creators by_author={a.creators.by_author} by_initiator={a.creators.by_initiator} /></div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2 className="grow">Блокировки по владельцам</h2></div>
              <div className="panel-body">
                {!a.blockers.length ? <p className="small muted">Открытых бизнес-блокировок нет.</p> : (
                  <div className="table-wrap"><table className="data">
                    <thead><tr><th>Владелец</th><th>Блокировок</th><th title="Сумма дней с начала каждой блокировки">Дней</th><th>Просрочено</th></tr></thead>
                    <tbody>{a.blockers.map((b: any) => (
                      <tr key={b.owner} className="click" onClick={drill(b.ids)}>
                        <td>{b.owner}</td><td className="num">{b.count}</td><td className="num">{b.days}</td>
                        <td className="num" style={{ color: b.overdue ? 'var(--danger)' : undefined }}>{b.overdue}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </div>
            </section>
          </div>

          <section className="panel">
            <div className="panel-head"><h2 className="grow">Спрос (плановые задачи с голосами отделов)</h2></div>
            <div className="panel-body stack">
              <div className="kpis">
                <MetricTile m={a.demand.voted} label="с оценками отделов" />
                <Tile value={a.demand.high.value} label={`высокий приоритет (≥ ${a.demand.threshold})`} ids={a.demand.high.ids}
                  hint={a.demand.high.extra?.share !== null && a.demand.high.extra?.share !== undefined ? `${a.demand.high.extra.share}% от оценённых` : undefined} />
                <MetricTile m={a.demand.strictly_5} label="строго 5" />
                <MetricTile m={a.demand.high_unresolved} label="высокий приоритет не решён" alert={a.demand.high_unresolved.value > 0} />
                <MetricTile m={a.demand.demanded_delivered} label="востребованные сделаны без переносов" />
              </div>
              {a.demand.demanded_delivered.extra?.no_history > 0 && (
                <p className="small muted">Ещё {a.demand.demanded_delivered.extra.no_history} сделанных задач с высоким приоритетом без истории статусов — не учитываются.</p>
              )}
              <Funnel title="Высокий приоритет по статусам" counts={a.demand.high.extra?.by_semantic ?? {}} />
              <Funnel title={`Поступившие за период по статусам (${a.demand.conversion.received})`} counts={a.demand.conversion} />
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Creators({ by_author, by_initiator }: { by_author: any[]; by_initiator: any[] }) {
  const [mode, setMode] = useState<'author' | 'initiator'>('initiator');
  const rows = mode === 'author' ? by_author : by_initiator;
  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="Группировка" style={{ alignSelf: 'flex-start' }}>
        <button className={mode === 'initiator' ? 'on' : ''} onClick={() => setMode('initiator')}>Инициатор</button>
        <button className={mode === 'author' ? 'on' : ''} onClick={() => setMode('author')}>Кто завёл в системе</button>
      </div>
      {!rows.length ? <p className="small muted">За период задач не поступало.</p> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>{mode === 'author' ? 'Автор' : 'Инициатор'}</th><th>Всего</th><th>Плановые</th><th>Баги</th><th>Доработки</th><th>Сделано</th>{mode === 'author' && <th>Через API</th>}</tr></thead>
          <tbody>{rows.map((r: any) => (
            <tr key={r.name} className="click" onClick={drill(r.ids)}>
              <td>{r.name}</td><td className="num">{r.count}</td>
              <td className="num">{r.by_kind.planned}</td><td className="num">{r.by_kind.bug}</td><td className="num">{r.by_kind.operational_improvement}</td>
              <td className="num">{r.done}</td>{mode === 'author' && <td className="num">{r.via_api_key}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function Funnel({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(SEM).map(([k, label]) => ({ label, n: counts[k] ?? 0 })).filter((e) => e.n > 0);
  const max = Math.max(1, ...entries.map((e) => e.n));
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 6 }}>{title}</div>
      {!entries.length ? <p className="small muted">Нет задач.</p> : entries.map((e) => (
        <div key={e.label} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span className="small" style={{ width: 120, flex: 'none' }}>{e.label}</span>
          <div className="meter grow"><i style={{ width: `${Math.round((e.n / max) * 100)}%`, background: 'var(--beet)' }} /></div>
          <span className="num small" style={{ width: 32, textAlign: 'right' }}>{e.n}</span>
        </div>
      ))}
    </div>
  );
}

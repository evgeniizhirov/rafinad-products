// Product planner (vNext ТЗ §2, §6): the product team's own working section, separate from the shared «Обзор».
// «Очередь и спринты» — open planned tasks by priority on the left, the next sprints with team hours against capacity
// on the right, the monthly budget on top; a task moves by drag-and-drop or by the «В спринт» menu. Every move goes
// through the ordinary schedule API, so approved releases, budget and capacity ask for a reason exactly as in the card.
// «Гант» — the same diagram as in «Обзор», but with every task (hidden Product tasks included and marked).
// «Внутренние задачи» — hidden Product tasks: never in sprints, planned by their own dates.
import { useMemo, useState } from 'react';
import { Gantt } from '../Gantt';
import { api, ApiError, fmtDate, invalidate, navigate, openFeature, plural, toast, useApi, useApp, useQueryParam } from '../lib';
import { Empty, ErrorBox, LoadRow, Loading, PageHead, ReasonModal, StatusPill, Tabs } from '../ui';

type Tab = 'queue' | 'gantt' | 'internal';
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hrs = (n: number) => `${Math.round(n * 10) / 10} ч`;

export function Planner() {
  const { me } = useApp();
  const [tabQ, setTab] = useQueryParam('tab');
  const tab = (['queue', 'gantt', 'internal'].includes(tabQ ?? '') ? tabQ : 'queue') as Tab;
  if (!me?.permissions.plan) {
    return <><PageHead title="Планировщик" /><div className="panel"><Empty title="Раздел продуктовой команды">Общий план релизов — в разделе «Обзор».</Empty></div></>;
  }
  return (
    <>
      <PageHead title="Планировщик" sub="Рабочий раздел продуктовой команды: все задачи, включая скрытые, очередь по приоритету, спринты, часы команд и бюджет. Общая картина для бизнеса — в «Обзоре»." />
      <Tabs boxed value={tab} onChange={(v) => setTab(v === 'queue' ? null : v)} items={[
        { id: 'queue', label: 'Очередь и спринты' },
        { id: 'gantt', label: 'Гант всех задач' },
        { id: 'internal', label: 'Внутренние задачи' },
      ]} />
      {tab === 'queue' && <QueueBoard />}
      {tab === 'gantt' && <Gantt scope="planner" height="74vh" />}
      {tab === 'internal' && <InternalTasks />}
    </>
  );
}

interface Pending { t: any; sprint: any | null; code: string; over: any[] }

function QueueBoard() {
  const [count, setCount] = useState(4);
  const { data, error } = useApi<any>(`/planner?sprints=${count}`);
  const [q, setQ] = useState('');
  const [onlyReady, setOnlyReady] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const byId = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of data?.queue ?? []) m.set(t.id, { ...t, sprint_id: null });
    for (const s of data?.sprints ?? []) for (const t of s.tasks) m.set(t.id, { ...t, sprint_id: s.id });
    return m;
  }, [data]);
  const teamName = (id: string) => data?.teams.find((t: any) => t.id === id)?.name ?? id;

  const move = async (t: any, sprint: any | null, extra: Record<string, unknown> = {}) => {
    if ((t.sprint_id ?? null) === (sprint?.id ?? null)) return;
    setBusy(t.id);
    try {
      await api(`/features/${t.id}/schedule`, { method: 'PATCH', body: { sprint_id: sprint?.id ?? null, release_id: sprint?.release?.id ?? null, version: t.version, ...extra } });
      toast(sprint ? `${t.key} → спринт ${sprint.code}` : `${t.key} возвращена в очередь`);
      invalidate();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'approved' || e.code === 'over_budget')) setPending({ t, sprint, code: e.code, over: e.details?.over ?? [] });
      else { toast((e as Error).message, 'error'); invalidate(); }
    } finally {
      setBusy(null);
    }
  };
  const drop = (sprint: any | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const t = byId.get(e.dataTransfer.getData('text/plain') || drag || '');
    setDrag(null);
    if (t) move(t, sprint);
  };
  const dragOver = (key: string) => (e: React.DragEvent) => { if (drag) { e.preventDefault(); setOver(key); } };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="panel"><Loading rows={8} /></div>;
  const needle = q.trim().toLowerCase();
  const queue = data.queue.filter((t: any) => (!onlyReady || t.status?.semantic === 'ready') && (!needle || `${t.key} ${t.title}`.toLowerCase().includes(needle)));
  const queueHours = data.queue.reduce((a: number, t: any) => a + t.hours, 0);

  return (
    <div className="stack">
      {data.budget.length > 0 && (
        <div className="kpis planner-budget">
          {data.budget.map((m: any) => (
            <a key={m.month} className={`kpi ${m.over_budget ? 'alert' : ''}`} href="/budget" onClick={(e) => { e.preventDefault(); navigate('/budget'); }} title="Бюджет и ставки команд">
              <b className="num">{rub(m.cost)}</b>
              <span>{monthName(m.month)}{m.budget_limit_rub !== null ? ` · лимит ${rub(m.budget_limit_rub)}` : ' · лимит не задан'}{m.status === 'closed' ? ' · закрыт' : ''}</span>
            </a>
          ))}
        </div>
      )}
      <div className="planner">
        <section className={`panel planner-queue ${over === 'queue' ? 'drop-on' : ''}`} onDragOver={dragOver('queue')} onDragLeave={() => setOver(null)} onDrop={drop(null)} aria-label="Очередь">
          <div className="panel-head">
            <h2 className="grow">Очередь <span className="muted small">{data.queue.length} · {hrs(queueHours)}</span></h2>
          </div>
          <div className="panel-body stack tight">
            <input className="input sm" placeholder="Поиск по ID или названию" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск в очереди" />
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} />только «Готова к планированию»</label>
            <p className="small muted" style={{ margin: 0 }}>По приоритету отделов. Перетащите задачу в спринт или выберите его в меню. Баги, доработки и внутренние задачи в очередь спринтов не входят.</p>
          </div>
          <div className="list">
            {queue.length === 0 && <Empty title="Очередь пуста">{needle || onlyReady ? 'Нет задач под фильтр.' : 'Все открытые плановые задачи распределены по спринтам.'}</Empty>}
            {queue.map((t: any) => (
              <TaskRow key={t.id} t={t} teamName={teamName} busy={busy === t.id}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDrag(t.id); }}
                onDragEnd={() => { setDrag(null); setOver(null); }}
                action={(
                  <select className="select sm" value="" aria-label={`${t.key}: в спринт`} onClick={(e) => e.stopPropagation()} onChange={(e) => { const s = data.sprints.find((x: any) => x.id === e.target.value); if (s) move(t, s); }}>
                    <option value="">В спринт…</option>
                    {data.sprints.map((s: any) => <option key={s.id} value={s.id}>{s.code}{s.release?.approved ? ' (утв.)' : ''}</option>)}
                  </select>
                )} />
            ))}
          </div>
        </section>

        <div className="planner-sprints">
          {data.sprints.length === 0 && <div className="panel"><Empty title="Нет открытых спринтов">Создайте следующие периоды в разделе «Спринты».</Empty></div>}
          {data.sprints.map((s: any) => {
            const teams = [...new Set([...Object.keys(s.capacity), ...Object.keys(s.load)])];
            const total = s.tasks.reduce((a: number, t: any) => a + t.hours, 0);
            return (
              <section key={s.id} className={`panel sprint-card ${over === s.id ? 'drop-on' : ''}`} onDragOver={dragOver(s.id)} onDragLeave={() => setOver(null)} onDrop={drop(s)} aria-label={`Спринт ${s.code}`}>
                <div className="panel-head" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <h2 className="grow">Спринт {s.code}{s.current && <span className="pill info" style={{ marginLeft: 6 }}>текущий</span>}</h2>
                  {s.release && <span className="small muted">{s.release.name}</span>}
                  {s.release && (s.release.approved ? <span className="pill ok">утверждён</span> : <span className="pill outline">не утверждён</span>)}
                </div>
                <div className="panel-body stack tight">
                  <div className="small muted">разработка {fmtDate(s.start_date, false)} – {fmtDate(s.end_date, false)} · тест до {fmtDate(s.production_due, false)}</div>
                  {teams.length === 0 ? <div className="small muted">Часов нет, ёмкость команд не задана.</div> : teams.map((id) => (
                    s.capacity[id] !== undefined
                      ? <LoadRow key={id} name={teamName(id)} capacity={s.capacity[id]} planned={s.load[id] ?? 0} color={data.teams.find((x: any) => x.id === id)?.color} />
                      : <div key={id} className="load-row"><span className="ellipsis">{teamName(id)}</span><span className="small muted nowrap">нет ёмкости</span><span className="v num">{hrs(s.load[id] ?? 0)}</span></div>
                  ))}
                  {s.release?.approved && <div className="small muted">Изменение состава утверждённого релиза попросит причину и попадёт в журнал.</div>}
                </div>
                <div className="list">
                  {s.tasks.length === 0 && <div className="small muted" style={{ padding: '10px 16px' }}>Перетащите сюда задачи из очереди.</div>}
                  {s.tasks.map((t: any) => (
                    <TaskRow key={t.id} t={{ ...t, sprint_id: s.id }} teamName={teamName} busy={busy === t.id}
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDrag(t.id); }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                      action={(
                        <select className="select sm" value="" aria-label={`${t.key}: перенести`} onClick={(e) => e.stopPropagation()} onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'queue') move({ ...t, sprint_id: s.id }, null);
                          else { const x = data.sprints.find((y: any) => y.id === v); if (x) move({ ...t, sprint_id: s.id }, x); }
                        }}>
                          <option value="">Перенести…</option>
                          {data.sprints.filter((x: any) => x.id !== s.id).map((x: any) => <option key={x.id} value={x.id}>в {x.code}</option>)}
                          <option value="queue">в очередь</option>
                        </select>
                      )} />
                  ))}
                </div>
                <div className="small muted" style={{ padding: '8px 16px' }}>
                  {s.tasks.length} {plural(s.tasks.length, 'задача', 'задачи', 'задач')} · {hrs(total)}
                  {s.reference.length > 0 && <> · справочно багов и доработок: {s.reference.length}</>}
                </div>
              </section>
            );
          })}
          {(data.more_sprints > 0 || data.later > 0) && (
            <div className="row wrap small muted" style={{ gap: 8 }}>
              {data.later > 0 && <span>В следующих спринтах ещё {data.later} {plural(data.later, 'задача', 'задачи', 'задач')}.</span>}
              {data.more_sprints > 0 && <button className="btn ghost sm" onClick={() => setCount(Math.min(8, count + 4))} disabled={count >= 8}>Показать ещё спринты</button>}
            </div>
          )}
        </div>
      </div>

      {pending && (
        <ReasonModal
          title={pending.code === 'over_budget' ? 'Превышение бюджета или ёмкости' : 'Релиз утверждён'}
          confirmText={pending.code === 'over_budget' ? 'Включить с превышением' : 'Изменить состав'}
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            const p = pending;
            setPending(null);
            await move(p.t, p.sprint, { reason, ...(p.code === 'over_budget' ? { confirm_over_budget: true } : { confirm_approved_change: true }) });
          }}
        >
          {pending.code === 'over_budget' ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {pending.over.map((o: any, i: number) => <li key={i}>{o.kind === 'budget' ? `${o.month}: бюджет ${rub(o.value)} при лимите ${rub(o.limit)}` : `Спринт ${o.sprint}, ${o.team}: ${o.value} ч при доступных ${o.limit} ч`}</li>)}
            </ul>
          ) : <p>{pending.t.key} меняет состав утверждённого релиза. Укажите причину — она попадёт в журнал, исходный план задачи сохранится.</p>}
        </ReasonModal>
      )}
    </div>
  );
}

function TaskRow({ t, action, busy, teamName, onDragStart, onDragEnd }: { t: any; action: React.ReactNode; busy: boolean; teamName: (id: string) => string; onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void }) {
  const est = Object.entries(t.estimates as Record<string, number>).map(([id, h]) => `${teamName(id)} ${hrs(h)}`).join(', ');
  return (
    <div className={`list-item planner-task ${busy ? 'busy' : ''}`} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={() => openFeature(t.key)} title="Перетащите в спринт или в очередь">
      <span className="rank num small muted">{t.rank ? `#${t.rank}` : ''}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6, minWidth: 0 }}>
          <span className="key">{t.key}</span>
          <span className="ellipsis" style={{ fontWeight: 500 }}>{t.title}</span>
        </div>
        <div className="row wrap small" style={{ gap: 6, marginTop: 2 }}>
          <StatusPill status={t.status} />
          {t.unestimated ? <span className="pill warn">без оценки</span> : <span className="muted" title={est}>{hrs(t.hours)}</span>}
          {t.score !== null && <span className="muted" title={`Приоритет отделов, голосов: ${t.voters}`}>★ {t.score}</span>}
          {t.is_focus && <span className="pill beet">фокус</span>}
          {t.blocked && t.status?.semantic !== 'blocked' && <span className="pill danger">блокировка</span>}
          {t.carry_from && <span className="pill outline" title="Не завершена в прошлом спринте">перенос из {t.carry_from}</span>}
        </div>
      </div>
      {action}
    </div>
  );
}

function InternalTasks() {
  const { data, error } = useApi<any>('/planner?sprints=1');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="panel"><Loading rows={6} /></div>;
  return (
    <section className="panel flush">
      <div className="panel-head">
        <h2 className="grow">Внутренние задачи продукта <span className="muted small">{data.internal.length}</span></h2>
        <a className="btn ghost sm" href="/backlog?internal=1" onClick={(e) => { e.preventDefault(); navigate('/backlog?internal=1'); }}>В бэклоге</a>
      </div>
      <p className="small muted" style={{ margin: '0 16px 10px' }}>Скрытые задачи видны только продуктовой команде, не входят в спринты, релизы и бюджет и не попадают на общий Гант. На Ганте планировщика они рисуются по своим датам.</p>
      {data.internal.length === 0 ? <Empty title="Открытых внутренних задач нет" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Задача</th><th>Статус</th><th>Ответственный</th><th>Сроки</th><th>Теги</th></tr></thead>
            <tbody>
              {data.internal.map((t: any) => (
                <tr key={t.id} className="click" onClick={() => openFeature(t.key)}>
                  <td className="title-cell"><span className="key">{t.key}</span> <span className="t">{t.title}</span></td>
                  <td><StatusPill status={t.status} /></td>
                  <td className="small">{t.assignee ?? <span className="muted">—</span>}</td>
                  <td className="small nowrap">{t.planned_start || t.planned_end ? `${t.planned_start ? fmtDate(t.planned_start, false) : '…'} – ${t.planned_end ? fmtDate(t.planned_end, false) : '…'}` : <span className="muted">без дат</span>}</td>
                  <td className="small">{t.tags.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

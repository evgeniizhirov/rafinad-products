// Main dashboard (FR-03), strictly in this order: KPI → Gantt → release focus → blockers → upcoming releases.
// Team load lives in planning (Roadmap), not here.
import { useMemo, useState } from 'react';
import { I } from '../icons';
import { KIND_LABEL } from '../features';
import { fmtDate, navigate, openFeature, plural, useApi, useApp } from '../lib';
import { Empty, ErrorBox, GuestNote, Loading, Notice, PageHead, Progress, StatusPill } from '../ui';

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const KIND_COLOR: Record<string, string> = { planned: 'var(--beet, #8c1e50)', bug: 'var(--danger, #c4473b)', operational_improvement: 'var(--warn, #d08a1e)' };

export function Overview() {
  const { me } = useApp();
  const { data, error } = useApi<any>('/overview');
  if (!data) return <><PageHead title="Обзор" />{error ? <ErrorBox error={error} /> : <Loading rows={8} />}</>;
  const k = data.kpi;
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
  return (
    <>
      <PageHead title="Обзор" sub="Текущая работа, обязательства ближайшего релиза, блокировки и релизы." />
      <GuestNote />
      {me && data.alerts > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind="warn">
            Утверждённый план требует повторной проверки: {data.alerts} {plural(data.alerts, 'изменение', 'изменения', 'изменений')} ёмкости, весов или оценок.{' '}
            <a href="/roadmap?tab=plan" onClick={go('/roadmap?tab=plan')} style={{ fontWeight: 600, textDecoration: 'underline' }}>Открыть план</a>
          </Notice>
        </div>
      )}
      {/* 1. KPI */}
      <div className="kpis">
        {[
          { to: '/backlog?flag=open', n: k.open, label: 'открытых задач' },
          { to: '/backlog?status=in_progress', n: k.in_progress, label: 'в работе' },
          { to: '/backlog?status=ready', n: k.ready, label: 'готовы к планированию' },
          { to: '/backlog?flag=blocked', n: k.blocked, label: 'с блокировками', alert: k.blocked > 0 },
          { to: '/backlog?flag=unestimated', n: k.unestimated, label: 'без оценки часов' },
          { to: '/backlog?flag=unvoted', n: k.unvoted, label: 'без голосов отделов' },
        ].map((t) => (
          <a key={t.to} className={`kpi ${t.alert ? 'alert' : ''}`} href={t.to} onClick={go(t.to)} title="Показать эти задачи списком">
            <b className="num">{t.n}</b>
            <span>{t.label}</span>
          </a>
        ))}
      </div>

      {/* 2. Gantt */}
      <Gantt items={data.gantt ?? []} today={data.today} />

      {/* 3. Release focus */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="grow">Цели спринта{data.focus ? ` — ${data.focus.release.name}` : ''}</h2>
          {data.focus && <span className="small muted">{data.focus.release.sprints.map((s: any) => `выкладка ${s.code} до ${fmtDate(s.production_due, false)}`).join(' · ')}</span>}
          {data.focus && <a className="btn ghost sm" href={`/backlog?focus=1&release=${data.focus.release.id}`} onClick={go(`/backlog?focus=1&release=${data.focus.release.id}`)}>Все</a>}
        </div>
        <div className="list">
          {!data.focus && <Empty title="Нет открытых релизов">Создайте спринты в разделе «Спринты».</Empty>}
          {data.focus && data.focus.items.length === 0 && <Empty title="Фокусные задачи не отмечены">Отметьте обязательства релиза флажком «Фокусная задача релиза» в карточке.</Empty>}
          {data.focus?.items.map((x: any) => (
            <div key={x.feature.id} className="list-item" onClick={() => openFeature(x.feature.key)}>
              <span className="key">{x.feature.key}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 500 }}>{x.feature.title}</div>
                <div className="small muted">
                  {[x.sprint && `спринт ${x.sprint.code}`, x.planned_production_date && `выкладка ${fmtDate(x.planned_production_date)}`, x.feature.assignee_name].filter(Boolean).join(' · ')}
                  {x.overdue && <span style={{ color: 'var(--danger)' }}> · срок прошёл</span>}
                </div>
                {x.epic && x.epic.total > 1 && (
                  <div className="small" style={{ maxWidth: 360, marginTop: 4 }}><Progress value={Math.round((x.epic.done / x.epic.total) * 100)} label={`${x.epic.title}: ${x.epic.done}/${x.epic.total}`} /></div>
                )}
              </div>
              <StatusPill status={x.feature.status} />
            </div>
          ))}
        </div>
      </section>

      {/* 4. Blockers */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2 className="grow">Блокирующие задачи</h2>
          {k.blocked > 0 && <a className="btn ghost sm" href="/backlog?flag=blocked" onClick={go('/backlog?flag=blocked')}>Все ({k.blocked})</a>}
        </div>
        <div className="list">
          {(data.business_blockers ?? []).length === 0 && <Empty title="Блокировок нет" />}
          {(data.business_blockers ?? []).slice(0, 12).map((b: any, i: number) => (
            <div key={`${b.feature.id}-${i}`} className="list-item" onClick={() => openFeature(b.feature.key)} style={{ alignItems: 'flex-start' }}>
              <span className="key">{b.feature.key}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 500 }}>{b.feature.title}</div>
                <div className="small">
                  {b.kind === 'business' ? (
                    <>Ждём: <b>{b.waiting_for ?? 'ответ'}</b>{b.owner && <> от <b>{b.owner}</b></>}{b.since && <span className="muted"> · с {fmtDate(b.since)} ({b.days} {plural(b.days, 'день', 'дня', 'дней')})</span>}{b.overdue && <span style={{ color: 'var(--danger)' }}> · ответ просрочен</span>}</>
                  ) : b.kind === 'dependency' ? (
                    <span className="muted">Ждёт {b.waiting_for}</span>
                  ) : (
                    <span className="muted">Статус «Заблокирована», причина не указана</span>
                  )}
                </div>
                {b.unblocks.length > 1 && <div className="small muted">Разблокирует: {b.unblocks.join(', ')}</div>}
              </div>
              <StatusPill status={b.feature.status} />
            </div>
          ))}
        </div>
      </section>

      {/* 5. Upcoming releases */}
      <section className="panel flush">
        <div className="panel-head">
          <h2 className="grow">Ближайшие релизы</h2>
          <a className="btn ghost sm" href="/releases" onClick={go('/releases')}>Все релизы</a>
        </div>
        {data.releases.length === 0 ? <Empty title="Нет запланированных релизов" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Релиз</th><th>Выкладка спринта 1</th><th>Финальная выкладка</th><th style={{ width: 200 }}>Готовность</th><th>Ожидаемый функционал</th></tr></thead>
              <tbody>
                {data.releases.map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => navigate(`/releases/${r.id}`)}>
                    <td className="title-cell"><span className="t">{r.name}</span>{r.approved && <span className="pill ok" style={{ marginLeft: 6 }}>утверждён</span>}{r.overdue && <span className="pill danger" style={{ marginLeft: 6 }}>срок прошёл</span>}</td>
                    <td className="nowrap">{r.sprints?.[0] ? <>{fmtDate(r.sprints[0].production_due)} <span className="muted small">({r.sprints[0].code}, промежуточная)</span></> : <span className="muted">—</span>}</td>
                    <td className="nowrap"><b>{fmtDate(r.sprints?.[1]?.production_due ?? r.planned_date)}</b></td>
                    <td><Progress value={r.readiness} label={`${r.done_count}/${r.feature_count}`} /></td>
                    <td className="small">{r.focus_count ? `${r.focus_count} ${plural(r.focus_count, 'обязательство', 'обязательства', 'обязательств')}, готово ${r.focus_done}` : <span className="muted">{r.feature_count} {plural(r.feature_count, 'задача', 'задачи', 'задач')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ───────────────── Gantt ─────────────────
function Gantt({ items, today }: { items: any[]; today: string }) {
  const [weeks, setWeeks] = useState(8);
  const [assignee, setAssignee] = useState('');
  const [kind, setKind] = useState('');
  const [release, setRelease] = useState('');
  const assignees = useMemo(() => [...new Set(items.map((x) => x.feature.assignee_name).filter(Boolean))].sort() as string[], [items]);
  const releases = useMemo(() => [...new Map(items.filter((x) => x.release).map((x) => [x.release.id, x.release])).values()], [items]);
  const rows = items.filter((x) => (!assignee || x.feature.assignee_name === assignee) && (!kind || x.feature.task_kind === kind) && (!release || x.release?.id === release));
  const from = ms(today) - 14 * DAY;
  const to = from + weeks * 7 * DAY;
  const pct = (d: string) => ((ms(d) - from) / (to - from)) * 100;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const ticks: string[] = [];
  for (let t = from; t <= to; t += 7 * DAY) ticks.push(iso(t));
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 className="grow">Задачи в работе</h2>
        <select className="select sm" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Тип работы">
          <option value="">Все типы</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {assignees.length > 0 && (
          <select className="select sm" style={{ width: "auto" }} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Ответственный">
            <option value="">Все ответственные</option>
            {assignees.map((a) => <option key={a}>{a}</option>)}
          </select>
        )}
        {releases.length > 0 && (
          <select className="select sm" style={{ width: "auto" }} value={release} onChange={(e) => setRelease(e.target.value)} aria-label="Релиз">
            <option value="">Все релизы</option>
            {releases.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <select className="select sm" style={{ width: "auto" }} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Масштаб">
          <option value={4}>4 недели</option><option value={8}>8 недель</option><option value={13}>квартал</option><option value={26}>полгода</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <Empty title="Нет задач в работе со сроком">На диаграмме — только задачи в работе или на проработке, у которых указан срок окончания работ.</Empty>
      ) : (
        <div className="gantt" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 760 }}>
            <div className="gantt-row gantt-head">
              <div className="gantt-label small muted">Задача</div>
              <div className="gantt-track">
                {ticks.map((t) => <span key={t} className="gantt-tick" style={{ left: `${pct(t)}%` }}>{fmtDate(t, false)}</span>)}
              </div>
            </div>
            {rows.map((x) => {
              const color = KIND_COLOR[x.feature.task_kind] ?? KIND_COLOR.planned;
              const end = clamp(pct(x.end) + 100 / (weeks * 7));
              const start = x.start ? clamp(pct(x.start)) : null;
              const title = `${x.feature.key} ${x.feature.title}\n${KIND_LABEL[x.feature.task_kind]} · ${x.feature.status?.name ?? ''}\n${x.start ? `${fmtDate(x.start)} — ` : 'срок '}${fmtDate(x.end)}${x.end_source === 'sprint' ? ' (конец разработки спринта)' : ''}${x.production_date ? `\nвыкладка ${fmtDate(x.production_date)}` : ''}`;
              return (
                <div key={x.feature.id} className="gantt-row" onClick={() => openFeature(x.feature.key)} title={title}>
                  <div className="gantt-label">
                    <span className="key">{x.feature.key}</span> <span className="ellipsis">{x.feature.title}</span>
                    <div className="small muted ellipsis">{[x.feature.task_kind !== 'planned' && KIND_LABEL[x.feature.task_kind], x.feature.assignee_name, x.sprint && `спринт ${x.sprint.code}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="gantt-track">
                    <span className="gantt-today" style={{ left: `${pct(today)}%` }} />
                    {start !== null && end > start ? (
                      <span className={`gantt-bar ${x.overdue ? 'overdue' : ''} ${x.blocked ? 'blocked' : ''}`} style={{ left: `${start}%`, width: `${end - start}%`, background: color }} />
                    ) : (
                      <span className={`gantt-milestone ${x.overdue ? 'overdue' : ''}`} style={{ left: `calc(${end}% - 6px)`, background: color }} title="Срок без даты начала" />
                    )}
                    {x.production_date && pct(x.production_date) >= 0 && pct(x.production_date) <= 100 && (
                      <span className="gantt-prod" style={{ left: `${pct(x.production_date)}%` }} title={`Выкладка ${fmtDate(x.production_date)}`} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="row wrap small muted" style={{ padding: '8px 12px', gap: 14 }}>
            {Object.entries(KIND_LABEL).map(([k, l]) => <span key={k} className="row" style={{ gap: 6 }}><i style={{ width: 12, height: 8, borderRadius: 2, background: KIND_COLOR[k], display: 'inline-block' }} />{l}</span>)}
            <span className="row" style={{ gap: 6 }}><i className="gantt-milestone" style={{ position: 'static', background: 'var(--ink-3)' }} />срок без даты начала</span>
            <span className="row" style={{ gap: 6 }}><i style={{ width: 2, height: 12, background: 'var(--info)', display: 'inline-block' }} />выкладка на прод</span>
            <span>Красная обводка — срок прошёл</span>
          </div>
        </div>
      )}
      <div className="small muted" style={{ padding: '0 12px 10px' }}><I.chain style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> Конец полосы — срок окончания работ, а не дата выкладки.</div>
    </section>
  );
}

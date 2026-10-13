// «Обзор» (vNext ТЗ §2.1): compact KPI → the shared Gantt as the main element → release focus and blockers side by side.
// The releases table is gone: releases are rows of the Gantt. /api/overview keeps its keys (used by the MCP integration).
import { Gantt } from '../Gantt';
import { fmtDate, navigate, openFeature, plural, useApi, useApp } from '../lib';
import { Empty, ErrorBox, GuestNote, Loading, Notice, PageHead, Progress, StatusPill } from '../ui';

export function Overview() {
  const { me } = useApp();
  const { data, error } = useApi<any>('/overview');
  if (!data) return <><PageHead title="Обзор" />{error ? <ErrorBox error={error} /> : <Loading rows={8} />}</>;
  const k = data.kpi;
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
  return (
    <>
      <PageHead title="Обзор" sub="Общий план релизов: этапы каждой задачи, исходный план, факт и прогноз. Одна картина для бизнеса и продукта." />
      <GuestNote />
      {me && data.alerts > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind="warn">
            Утверждённый план требует повторной проверки: {data.alerts} {plural(data.alerts, 'изменение', 'изменения', 'изменений')} ёмкости, весов или оценок.{' '}
            <a href="/roadmap?tab=plan" onClick={go('/roadmap?tab=plan')} style={{ fontWeight: 600, textDecoration: 'underline' }}>Открыть план</a>
          </Notice>
        </div>
      )}
      <div className="kpis overview-kpis">
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

      <Gantt scope="shared" />

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Цели спринта{data.focus ? ` — ${data.focus.release.name}` : ''}</h2>
            {data.focus && <a className="btn ghost sm" href={`/backlog?focus=1&release=${data.focus.release.id}`} onClick={go(`/backlog?focus=1&release=${data.focus.release.id}`)}>Все</a>}
          </div>
          <div className="list compact-list">
            {!data.focus && <Empty title="Нет открытых релизов">Создайте спринты в разделе «Спринты».</Empty>}
            {data.focus && data.focus.items.length === 0 && <Empty title="Фокусные задачи не отмечены">Отметьте обязательства релиза флажком «Фокусная задача релиза» в карточке.</Empty>}
            {data.focus?.items.map((x: any) => (
              <div key={x.feature.id} className="list-item" onClick={() => openFeature(x.feature.key)}>
                <span className="key">{x.feature.key}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 500 }}>{x.feature.title}</div>
                  <div className="small muted ellipsis">
                    {[x.sprint && `спринт ${x.sprint.code}`, x.planned_production_date && `выкладка ${fmtDate(x.planned_production_date, false)}`, x.feature.assignee_name].filter(Boolean).join(' · ')}
                    {x.overdue && <span style={{ color: 'var(--danger)' }}> · срок прошёл</span>}
                  </div>
                  {x.epic && x.epic.total > 1 && (
                    <div className="small" style={{ maxWidth: 320, marginTop: 4 }}><Progress value={Math.round((x.epic.done / x.epic.total) * 100)} label={`${x.epic.title}: ${x.epic.done}/${x.epic.total}`} /></div>
                  )}
                </div>
                <StatusPill status={x.feature.status} />
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Блокирующие задачи</h2>
            {k.blocked > 0 && <a className="btn ghost sm" href="/backlog?flag=blocked" onClick={go('/backlog?flag=blocked')}>Все ({k.blocked})</a>}
          </div>
          <div className="list compact-list">
            {(data.business_blockers ?? []).length === 0 && <Empty title="Блокировок нет" />}
            {(data.business_blockers ?? []).slice(0, 8).map((b: any, i: number) => (
              <div key={`${b.feature.id}-${i}`} className="list-item" onClick={() => openFeature(b.feature.key)} style={{ alignItems: 'flex-start' }}>
                <span className="key">{b.feature.key}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 500 }}>{b.feature.title}</div>
                  <div className="small">
                    {b.kind === 'business' ? (
                      <>Ждём: <b>{b.waiting_for ?? 'ответ'}</b>{b.owner && <> от <b>{b.owner}</b></>}{b.since && <span className="muted"> · {b.days} {plural(b.days, 'день', 'дня', 'дней')}</span>}{b.overdue && <span style={{ color: 'var(--danger)' }}> · ответ просрочен</span>}</>
                    ) : b.kind === 'dependency' ? (
                      <span className="muted">Ждёт {b.waiting_for}</span>
                    ) : (
                      <span className="muted">Статус «Заблокирована», причина не указана</span>
                    )}
                  </div>
                  {b.unblocks.length > 1 && <div className="small muted ellipsis">Разблокирует: {b.unblocks.join(', ')}</div>}
                </div>
                <StatusPill status={b.feature.status} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

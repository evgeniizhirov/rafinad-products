import { I } from '../icons';
import { FeatureTitle } from '../features';
import { fmtDate, navigate, openFeature, plural, useApi, useApp } from '../lib';
import { Cubes, Empty, ErrorBox, GuestNote, Loading, LoadRow, Notice, PageHead, Progress, StatusPill } from '../ui';

export function Overview() {
  const { me } = useApp();
  const { data, error } = useApi<any>('/overview');
  if (!data) return <><PageHead title="Обзор" />{error ? <ErrorBox error={error} /> : <Loading rows={8} />}</>;
  const k = data.kpi;
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
  return (
    <>
      <PageHead title="Обзор" sub="Состояние бэклога, главные приоритеты отделов, загрузка команд и ближайшие релизы." />
      <GuestNote />
      {me && data.alerts > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind="warn">
            Утверждённый план требует повторной проверки: {data.alerts} {plural(data.alerts, 'изменение', 'изменения', 'изменений')} ёмкости, весов или оценок.{' '}
            <a href="/roadmap?tab=plan" onClick={go('/roadmap?tab=plan')} style={{ fontWeight: 600, textDecoration: 'underline' }}>Открыть план</a>
          </Notice>
        </div>
      )}
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

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Главные приоритеты</h2>
            <a className="btn ghost sm" href="/priorities" onClick={go('/priorities')}>Вся матрица</a>
          </div>
          <div className="list">
            {data.top.length === 0 && <Empty title="Нет открытых задач" />}
            {data.top.map((f: any, i: number) => (
              <div key={f.id} className="list-item" onClick={() => openFeature(f.key)}>
                <span className="rank">{i + 1}</span>
                <span className="key">{f.key}</span>
                <div className="grow" style={{ minWidth: 0 }}><FeatureTitle f={f} /></div>
                <span className="hide-sm"><StatusPill status={f.status} /></span>
                <Cubes score={f.priority.score} />
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Загрузка команд</h2>
            <a className="btn ghost sm" href="/roadmap?tab=timeline" onClick={go('/roadmap?tab=timeline')}>Шкала</a>
          </div>
          <div className="panel-body stack">
            {!data.load && <p className="muted">Ресурсный план виден сотрудникам после входа.</p>}
            {data.load && data.periods.map((p: any) => (
              <div key={p.id} className="stack tight">
                <h3 style={{ fontSize: 14 }}>{p.name}</h3>
                {data.teams.map((t: any) => {
                  const l = data.load.find((x: any) => x.periodId === p.id && x.teamId === t.id);
                  return l ? <LoadRow key={t.id} name={t.name} color={t.color} capacity={l.capacity} planned={l.planned} /> : null;
                })}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Ближайшие релизы</h2>
            <a className="btn ghost sm" href="/releases" onClick={go('/releases')}>Все релизы</a>
          </div>
          <div className="list">
            {data.releases.length === 0 && <Empty title="Нет запланированных релизов" />}
            {data.releases.map((r: any) => (
              <div key={r.id} className="list-item" onClick={() => navigate(`/releases/${r.id}`)} style={{ alignItems: 'flex-start' }}>
                <I.releases style={{ width: 18, height: 18, color: 'var(--beet)', marginTop: 2, flex: 'none' }} />
                <div className="grow stack tight" style={{ minWidth: 0 }}>
                  <div className="row wrap">
                    <b>{r.name}</b>
                    {r.version_label && <span className="muted small">{r.version_label}</span>}
                    {r.approved && <span className="pill ok">утверждён</span>}
                    {r.overdue && <span className="pill danger">срок прошёл</span>}
                  </div>
                  <div className="row small muted">
                    <span>выпуск {fmtDate(r.planned_date)}</span>
                    <span>{r.done_count} из {r.feature_count} готово</span>
                  </div>
                  <Progress value={r.readiness} />
                  {r.blockers.length > 0 && (
                    <div className="small" style={{ color: 'var(--danger)' }}>
                      Блокировки: {r.blockers.map((b: any) => b.feature.key).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Блокировки</h2>
            {data.kpi.blocked > 0 && <a className="btn ghost sm" href="/backlog?flag=blocked" onClick={go('/backlog?flag=blocked')}>Все ({data.kpi.blocked})</a>}
          </div>
          <div className="list">
            {data.blocked.length === 0 && <Empty title="Блокировок нет" />}
            {data.blocked.map((f: any) => (
              <div key={f.id} className="list-item" onClick={() => openFeature(f.key)}>
                <span className="key">{f.key}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 500 }}>{f.title}</div>
                  <div className="small muted ellipsis">
                    {f.status.semantic === 'blocked' ? 'Статус «Заблокирована»' : `Ждёт: ${f.relations.blocked_by.map((b: any) => (b.hidden ? 'внутреннюю задачу' : b.key)).join(', ')}`}
                  </div>
                </div>
                <StatusPill status={f.status} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

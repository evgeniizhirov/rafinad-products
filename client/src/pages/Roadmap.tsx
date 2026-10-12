import { useMemo, useState } from 'react';
import { I } from '../icons';
import { FeatureCard, usePlacement } from '../features';
import { api, ApiError, fmtDate, fmtDateTime, invalidate, mutate, navigate, openFeature, toast, useApi, useApp, useQueryParam } from '../lib';
import { Cubes, Empty, ErrorBox, GuestNote, Loading, LoadRow, Meter, Notice, PageHead, Tabs } from '../ui';

type Tab = 'lanes' | 'timeline' | 'deps' | 'plan';

export function Roadmap() {
  const { me } = useApp();
  const [tabParam, setTab] = useQueryParam('tab');
  const canPlan = !!me?.permissions.plan && !me.must_change_password;
  const tab = (tabParam as Tab) || 'lanes';
  const { data, error } = useApi<any>('/roadmap');
  return (
    <>
      <PageHead title="Роадмап" sub="Что делаем сейчас, что дальше и что позже; план по периодам с учётом часов команд и зависимостей." />
      <GuestNote />
      {me && data?.alerts?.length > 0 && tab !== 'plan' && (
        <div style={{ marginBottom: 14 }}>
          <Notice kind="warn">
            Утверждённый план требует повторной проверки ({data.alerts.length}).{' '}
            {canPlan && <button className="btn sm" onClick={() => setTab('plan')}>Перейти к плану</button>}
          </Notice>
        </div>
      )}
      <Tabs<Tab>
        boxed
        value={tab}
        onChange={(t) => setTab(t === 'lanes' ? null : t)}
        items={[
          { id: 'lanes', label: 'Сейчас / Далее / Позже' },
          { id: 'timeline', label: 'Шкала по периодам' },
          { id: 'deps', label: 'Зависимости' },
          ...(canPlan ? [{ id: 'plan' as Tab, label: 'Ресурсы и план' }] : []),
        ]}
      />
      <ErrorBox error={error} />
      {tab !== 'plan' && !data && <Loading rows={6} />}
      {tab === 'lanes' && data && <Lanes data={data} />}
      {tab === 'timeline' && data && <Timeline data={data} canPlan={canPlan} />}
      {tab === 'deps' && <Dependencies />}
      {tab === 'plan' && canPlan && <PlanTab />}
    </>
  );
}

function Lanes({ data }: { data: any }) {
  const period = (id: string | null) => data.periods.find((p: any) => p.id === id);
  const lanes = [
    { id: 'now', title: 'Сейчас', sub: period(data.current_period_id)?.name ?? 'в работе' },
    { id: 'next', title: 'Далее', sub: period(data.next_period_id)?.name ?? 'следующий период' },
    { id: 'later', title: 'Позже', sub: 'дальше по плану и бэклог' },
  ];
  const done = data.features.filter((f: any) => f.lane === 'done');
  return (
    <>
      <div className="board" style={{ gridAutoColumns: 'minmax(280px, 1fr)' }}>
        {lanes.map((l) => {
          const items = data.features.filter((f: any) => f.lane === l.id);
          return (
            <section key={l.id} className="lane">
              <div className="lane-head">
                <h3>{l.title}</h3>
                <span className="n">{l.sub}</span>
                <span className="grow" />
                <span className="n">{items.length}</span>
              </div>
              <div className="lane-cards">
                {items.length === 0 && <div className="small muted" style={{ padding: 6 }}>Пусто</div>}
                {items.map((f: any) => <FeatureCard key={f.id} f={f} extra={f.period && l.id === 'later' ? <div className="small muted">{f.period.name}</div> : null} />)}
              </div>
            </section>
          );
        })}
      </div>
      {done.length > 0 && <p className="small muted" style={{ marginTop: 12 }}>Завершено: {done.map((f: any) => f.key).join(', ')}</p>}
    </>
  );
}

function Timeline({ data, canPlan }: { data: any; canPlan: boolean }) {
  const { move, modal } = usePlacement();
  const [over, setOver] = useState<string | null>(null);
  const byId = useMemo(() => new Map<string, any>(data.features.map((f: any) => [f.id, f])), [data]);
  const periodIdx = new Map<string, number>(data.periods.map((p: any, i: number) => [p.id, i]));
  const warnFor = (f: any): string | null => {
    const blockers = data.dependencies.filter((d: any) => d.to === f.id).map((d: any) => byId.get(d.from)).filter(Boolean);
    if (!f.period) return null;
    const mine = periodIdx.get(f.period.id) ?? -1;
    for (const b of blockers) {
      if (b.status.semantic === 'done') continue;
      if (!b.period) return `Зависит от ${b.key}, которая не запланирована`;
      if ((periodIdx.get(b.period.id) ?? 99) >= mine) return `Зависит от ${b.key} (${b.period.name}) — она должна быть раньше`;
    }
    return null;
  };
  const columns = [{ id: '', name: 'Не запланированы', unplanned: true }, ...data.periods];
  const releaseIn = (p: any) => data.releases.filter((r: any) => r.planned_date && r.planned_date >= p.startDate && r.planned_date <= p.endDate);
  const onDrop = (periodId: string, featureId: string) => {
    setOver(null);
    const f = byId.get(featureId);
    if (!f || (f.period?.id ?? '') === periodId) return;
    move(f, periodId || null);
  };
  return (
    <>
      {canPlan && <p className="small muted" style={{ marginBottom: 10 }}>Перетащите карточку в другой период. При превышении часов команды потребуется подтверждение с причиной.</p>}
      <div className="timeline" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(250px, 1fr))` }}>
        {columns.map((p: any) => {
          const items = p.unplanned
            ? data.features.filter((f: any) => !f.period && ['ready', 'planned', 'in_progress', 'analysis', 'blocked'].includes(f.status.semantic))
            : data.features.filter((f: any) => f.period?.id === p.id);
          const isCurrent = p.id === data.current_period_id;
          return (
            <section
              key={p.id || 'none'}
              className={`period-col ${isCurrent ? 'current' : ''} ${over === p.id ? 'drop' : ''}`}
              onDragOver={canPlan ? (e) => { e.preventDefault(); setOver(p.id); } : undefined}
              onDragLeave={() => setOver((o) => (o === p.id ? null : o))}
              onDrop={canPlan ? (e) => { e.preventDefault(); onDrop(p.id, e.dataTransfer.getData('text/plain')); } : undefined}
              aria-label={p.name}
            >
              <div className="period-head">
                <div className="row"><h3 className="grow">{p.name}</h3>{isCurrent && <span className="pill beet">текущий</span>}<span className="muted small">{items.length}</span></div>
                {!p.unplanned && <div className="small muted">{fmtDate(p.startDate, false)} — {fmtDate(p.endDate)}</div>}
                {p.unplanned && <div className="small muted">Готовы или прорабатываются</div>}
              </div>
              {!p.unplanned && data.load && (
                <div className="period-load">
                  {data.teams.map((t: any) => {
                    const l = data.load.find((x: any) => x.periodId === p.id && x.teamId === t.id);
                    if (!l || (!l.capacity && !l.planned)) return null;
                    const o = l.planned > l.capacity;
                    return (
                      <div key={t.id} className={`lr ${o ? 'over' : ''}`} title={`${t.name}: ${l.planned} из ${l.capacity} ч`}>
                        <span className="ellipsis">{t.name}</span>
                        <Meter value={l.planned} max={l.capacity} color={t.color} over={o} />
                        <span className="num" style={{ textAlign: 'right' }}>{l.utilization ?? '∞'}%</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {!p.unplanned && releaseIn(p).length > 0 && (
                <div className="period-releases">
                  {releaseIn(p).map((r: any) => (
                    <a key={r.id} href={`/releases/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/releases/${r.id}`); }} className="release-flag" title={r.approved ? 'Утверждённый релиз' : 'Релиз не утверждён'}>
                      <I.releases />
                      <span className="grow ellipsis" title={r.name}>{r.version_label ? `Релиз ${r.version_label}` : r.name}</span>
                      <span className="muted">{fmtDate(r.planned_date, false)}</span>
                    </a>
                  ))}
                </div>
              )}
              <div className="period-cards">
                {items.map((f: any) => <FeatureCard key={f.id} f={f} draggable={canPlan && f.lane !== 'done'} warn={warnFor(f)} />)}
                {items.length === 0 && <div className="small muted">{canPlan ? 'Перетащите задачу сюда' : 'Нет задач'}</div>}
              </div>
            </section>
          );
        })}
      </div>
      {modal}
    </>
  );
}

function Dependencies() {
  const { data, error } = useApi<any>('/graph');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.edges.length) return <Empty title="Зависимостей нет">Связи «блокирует» добавляются в карточке задачи.</Empty>;
  // layered layout: longest path from roots
  const nodes = data.nodes as any[];
  const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of data.edges) {
      const v = (layer.get(e.from) ?? 0) + 1;
      if (v > (layer.get(e.to) ?? 0)) { layer.set(e.to, v); changed = true; }
    }
    if (!changed) break;
  }
  const cols: any[][] = [];
  for (const n of nodes) {
    const l = layer.get(n.id)!;
    (cols[l] ??= []).push(n);
  }
  cols.forEach((c) => c.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1)));
  const W = 230, H = 54, GX = 70, GY = 16, PAD = 16;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((c, ci) => c.forEach((n, ri) => pos.set(n.id, { x: PAD + ci * (W + GX), y: PAD + ri * (H + GY) })));
  const width = PAD * 2 + cols.length * (W + GX) - GX;
  const height = PAD * 2 + Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  return (
    <div className="stack">
      <p className="small muted">Стрелка ведёт от блокирующей задачи к зависимой. Колонки — порядок выполнения.</p>
      <div className="graph-wrap">
        <svg width={width} height={height} role="img" aria-label="Граф зависимостей">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#9aa2b1" />
            </marker>
          </defs>
          {data.edges.map((e: any, i: number) => {
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
            const mx = (x1 + x2) / 2;
            return <path key={i} className="graph-edge" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} markerEnd="url(#arrow)" />;
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            const title = n.hidden ? 'Внутренняя задача' : n.title.length > 30 ? `${n.title.slice(0, 29)}…` : n.title;
            return (
              <g key={n.id} className={`graph-node ${n.hidden ? 'hidden' : ''}`} transform={`translate(${p.x},${p.y})`} style={{ cursor: n.hidden ? 'default' : 'pointer' }} onClick={() => !n.hidden && openFeature(n.key)}>
                <rect width={W} height={H} rx="8" />
                {!n.hidden && <rect width="4" height={H} rx="2" style={{ fill: n.status?.color ?? '#8a94a6', stroke: 'none' }} />}
                <text className="k" x="14" y="21">{n.hidden ? '' : n.key}{!n.hidden && n.status ? `  ${n.status.name}` : ''}</text>
                <text x="14" y="40">{title}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ───────────────── capacity + suggested plan ─────────────────
function PlanTab() {
  const { data, error } = useApi<any>('/planning');
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState<string>('');
  const [horizon, setHorizon] = useState<number | ''>('');
  const [run, setRun] = useState<any>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading rows={6} />;
  const current = run ?? data.last_run;
  const proposed = (current?.placements ?? []).filter((p: any) => p.kind === 'proposed');
  const sel = selected ?? new Set(proposed.map((p: any) => p.featureId));
  const capOf = (pid: string, tid: string) => data.capacities.find((c: any) => c.period_id === pid && c.team_id === tid);
  const loadOf = (pid: string, tid: string) => data.load.find((l: any) => l.periodId === pid && l.teamId === tid);
  const saveCap = async (pid: string, tid: string, raw: string) => {
    const hours = Number(raw.replace(',', '.'));
    const cur = capOf(pid, tid);
    if (raw.trim() === '' || Number.isNaN(hours) || hours < 0 || cur?.hours === hours) return;
    await mutate('/planning/capacity', 'PUT', { period_id: pid, team_id: tid, hours, version: cur?.version ?? null }, 'Ёмкость сохранена');
  };
  const propose = async () => {
    setBusy(true);
    try {
      const r = await api<any>('/planning/propose', { method: 'POST', body: { start_period_id: start || undefined, horizon: horizon || undefined } });
      setRun(r.run);
      setSelected(null);
      toast('Предлагаемый план сформирован');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };
  const approve = async () => {
    setBusy(true);
    try {
      const r = await api<any>(`/planning/runs/${current.id}/approve`, { method: 'POST', body: { feature_ids: [...sel] } });
      toast(`План утверждён: размещено ${r.applied}`);
      setRun(null);
      setSelected(null);
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
      if (e instanceof ApiError && e.code === 'stale') setRun(null);
    }
    setBusy(false);
  };
  const periodName = (id: string) => data.periods.find((p: any) => p.id === id)?.name ?? id;
  const horizonIds: string[] = current?.horizon_period_ids ?? [];
  const reasonTitle: Record<string, string> = { capacity: 'Не хватает часов', too_big: 'Слишком большие для одного периода', dependency: 'Ждут зависимостей', horizon: 'За горизонтом', not_estimated: 'Не оценены', status: 'Исключены по статусу' };
  return (
    <div className="stack loose">
      {data.alerts.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="grow">Требует повторной проверки</h2>
            <button className="btn sm" onClick={() => mutate('/planning/alerts/all/resolve', 'POST', {}, 'Отмечено как проверенное')}>Отметить всё проверенным</button>
          </div>
          <div className="list">
            {data.alerts.map((a: any) => (
              <div key={a.id} className="list-item" style={{ cursor: 'default' }}>
                <I.alert style={{ width: 16, height: 16, color: 'var(--warn)', flex: 'none' }} />
                <span className="grow">{a.message}</span>
                <span className="small muted nowrap">{fmtDateTime(a.created_at)}</span>
                <button className="btn ghost sm" onClick={() => mutate(`/planning/alerts/${a.id}/resolve`, 'POST', {})}>Проверено</button>
              </div>
            ))}
          </div>
          <div className="panel-body small muted">Утверждённые релизы и зафиксированные размещения не меняются автоматически — пересмотрите их вручную или сформируйте новый план.</div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><h2 className="grow">Ёмкость команд, часы на период</h2><span className="small muted">Изменения сохраняются при выходе из поля</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Период</th>
                {data.teams.map((t: any) => <th key={t.id} className="r">{t.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.periods.map((p: any) => (
                <tr key={p.id}>
                  <td className="nowrap"><b>{p.name}</b>{p.id === data.current_period_id && <span className="pill beet" style={{ marginLeft: 6 }}>текущий</span>}</td>
                  {data.teams.map((t: any) => {
                    const l = loadOf(p.id, t.id);
                    const over = l && l.planned > l.capacity;
                    return (
                      <td key={t.id} className="r" style={{ minWidth: 110 }}>
                        <input
                          key={`${capOf(p.id, t.id)?.hours ?? ''}-${capOf(p.id, t.id)?.version ?? 0}`}
                          className="input sm num"
                          style={{ width: 80 }}
                          defaultValue={capOf(p.id, t.id)?.hours ?? ''}
                          placeholder="0"
                          inputMode="decimal"
                          aria-label={`${p.name}, ${t.name}`}
                          onBlur={(e) => saveCap(p.id, t.id, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        />
                        <div className={`small num ${over ? '' : 'muted'}`} style={{ color: over ? 'var(--danger)' : undefined, marginTop: 3 }}>
                          {l ? `занято ${l.planned}${l.capacity ? ` (${l.utilization}%)` : ''}` : ''}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head row wrap">
          <h2 className="grow">Предлагаемый план</h2>
          <label className="small muted" htmlFor="plan-start">С периода</label>
          <select id="plan-start" className="select sm" style={{ width: 170 }} value={start} onChange={(e) => setStart(e.target.value)}>
            <option value="">Текущий</option>
            {data.periods.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="small muted" htmlFor="plan-h">Горизонт</label>
          <select id="plan-h" className="select sm" style={{ width: 160 }} value={horizon} onChange={(e) => setHorizon(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{data.horizon} (по умолчанию)</option>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button className="btn primary" disabled={busy} onClick={propose}>Сформировать предлагаемый план</button>
        </div>
        <div className="panel-body stack loose">
          <p className="small muted">
            Алгоритм берёт задачи «Готова к планированию» и выше по убыванию приоритета, учитывает блокировки и ставит каждую в ближайший период, где хватает часов всех нужных команд.
            Утверждённые размещения и релизы не трогает. Это предложение — ничего не меняется, пока вы его не утвердите.
          </p>
          {!current && <Empty title="План ещё не формировался" />}
          {current && (
            <>
              <div className="row wrap small muted">
                <span>Расчёт от {fmtDateTime(current.created_at)}</span>
                <span>Горизонт: {horizonIds.map(periodName).join(', ')}</span>
                {current.status === 'approved' && <span className="pill ok">утверждён {fmtDateTime(current.approved_at)}</span>}
              </div>
              <div className="grid-3">
                {horizonIds.map((pid) => {
                  const items = current.placements.filter((p: any) => p.periodId === pid);
                  return (
                    <div key={pid} className="panel">
                      <div className="panel-head"><h3 className="grow">{periodName(pid)}</h3><span className="small muted">{items.length}</span></div>
                      <div className="panel-body stack tight">
                        {data.teams.map((t: any) => {
                          const l = current.load.find((x: any) => x.periodId === pid && x.teamId === t.id);
                          return l && (l.capacity || l.planned) ? <LoadRow key={t.id} name={t.name} color={t.color} capacity={l.capacity} planned={l.planned} /> : null;
                        })}
                      </div>
                      <div className="list" style={{ borderTop: '1px solid var(--line)' }}>
                        {items.map((p: any) => (
                          <div key={p.featureId} className="list-item" style={{ cursor: 'default' }}>
                            {p.kind === 'proposed' && current.status === 'proposed' ? (
                              <input
                                type="checkbox"
                                style={{ accentColor: 'var(--beet)' }}
                                checked={sel.has(p.featureId)}
                                aria-label={`Утвердить ${p.feature.key}`}
                                onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(p.featureId); else n.delete(p.featureId); setSelected(n); }}
                              />
                            ) : <I.lock style={{ width: 14, height: 14, color: 'var(--ink-3)' }} />}
                            <a className="key" href={`?f=${p.feature.key}`} onClick={(e) => { e.preventDefault(); openFeature(p.feature.key); }}>{p.feature.key}</a>
                            <span className="grow ellipsis small">{p.feature.title}</span>
                            {p.kind === 'proposed' && p.previousPeriodId && p.previousPeriodId !== p.periodId && <span className="pill info">перенос</span>}
                            {p.kind !== 'proposed' && <span className="small muted">{p.kind === 'fixed' ? 'утверждено' : 'в работе'}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {current.status === 'proposed' && (
                <div className="row">
                  <button className="btn primary" disabled={busy || sel.size === 0} onClick={approve}>Утвердить выбранные ({sel.size})</button>
                  <button className="btn" disabled={busy} onClick={async () => { await mutate(`/planning/runs/${current.id}/discard`, 'POST', {}, 'Расчёт отменён'); setRun(null); }}>Отменить расчёт</button>
                  <span className="small muted">Утверждённые задачи получат период и статус «Запланирована»; планировщик их больше не двигает.</span>
                </div>
              )}
              {current.unplaced.length > 0 && (
                <section className="stack">
                  <h3 style={{ fontSize: 15 }}>Не вошли в план</h3>
                  {['capacity', 'too_big', 'dependency', 'horizon', 'not_estimated', 'status'].map((code) => {
                    const list = current.unplaced.filter((u: any) => u.code === code);
                    if (!list.length) return null;
                    return (
                      <details key={code} open={code !== 'status'}>
                        <summary style={{ cursor: 'pointer', fontWeight: 500, padding: '4px 0' }}>{reasonTitle[code]} <span className="muted">({list.length})</span></summary>
                        <div className="stack tight" style={{ padding: '6px 0 6px 16px' }}>
                          {list.map((u: any) => (
                            <div key={u.featureId} className="row top small">
                              <a className="key" href={`?f=${u.feature.key}`} onClick={(e) => { e.preventDefault(); openFeature(u.feature.key); }}>{u.feature.key}</a>
                              <span style={{ minWidth: 0 }}><span>{u.feature.title}</span><br /><span className="muted">{u.reasons.join('; ')}</span></span>
                              <span className="grow" />
                              <Cubes score={u.feature.score} />
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })}
                </section>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}


// Table Gantt (vNext ТЗ §2.1–2.3), one component for «Обзор» (scope=shared) and the Product planner (scope=planner).
// Left: fixed columns Задача / Ответственный / Статус / Теги. Right: one time scale; rows are shared, so the left table
// and the bars can never drift apart. Every task shows its own phases: plan (light), baseline (outline), confirmed fact
// (solid), forecast of the unfinished part (hatched), release as a milestone; deviation vs baseline in the tooltip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I } from './icons';
import { fmtDate, navigate, openFeature, useApi } from './lib';
import { Empty, ErrorBox, Loading } from './ui';

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const days = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
const addDays = (d: string, n: number) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
const dm = (d: string | null | undefined) => (d ? fmtDate(d, false) : '—');
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const PHASE_LABEL: Record<string, string> = { product: 'Продукт', design: 'Дизайн', dev: 'Разработка', qa: 'QA', release: 'Выкладка' };
const KIND_LABEL: Record<string, string> = { planned: 'Релизные задачи', bug: 'Баги', operational_improvement: 'Доработки' };
const SCALE = { week: 12, month: 4 } as const;
const ROW = 30;
const dev = (n: number | null | undefined) => (n === null || n === undefined ? null : n === 0 ? 'в срок' : n > 0 ? `+${n} дн. к исходному плану` : `${n} дн. к исходному плану (раньше)`);

type Row =
  | { type: 'release'; id: string; level: 0; r: any }
  | { type: 'sprint'; id: string; level: 1; s: any }
  | { type: 'group'; id: string; level: number; label: string; count: number }
  | { type: 'task'; id: string; level: number; t: any; inSprint: boolean };

interface Tip { x: number; y: number; title: string; lines: string[] }

export function Gantt({ scope = 'shared', height = '68vh', toolbar }: { scope?: 'shared' | 'planner'; height?: string; toolbar?: ReactNode }) {
  const { data, error, loading } = useApi<any>(`/gantt?scope=${scope}`);
  const [scale, setScale] = useState<keyof typeof SCALE>('week');
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [full, setFull] = useState(false);
  const [f, setF] = useState({ kind: '', status: '', assignee: '', tag: '' });
  const [tip, setTip] = useState<Tip | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const px = SCALE[scale];

  // default: releases of the horizon (current + 2) open, the rest folded
  useEffect(() => {
    if (data && !collapsed) setCollapsed(new Set(data.releases.filter((r: any) => !data.window.releases.includes(r.id)).map((r: any) => `r:${r.id}`)));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const from = data?.range.from as string | undefined;
  const width = data ? (days(data.range.from, data.range.to) + 1) * px : 0;
  const x = (d: string) => days(from!, d) * px;

  const scrollTo = (d: string) => { if (scroller.current && from) scroller.current.scrollLeft = Math.max(0, x(d)); };
  useLayoutEffect(() => { if (data && scroller.current) scrollTo(data.window.from); }, [data, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [full]);

  const options = useMemo(() => {
    const tasks = data ? [...data.releases.flatMap((r: any) => r.sprints.flatMap((s: any) => s.groups.flatMap((g: any) => g.tasks))), ...data.outside] : [];
    const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'ru'));
    const statuses = new Map<string, string>();
    for (const t of tasks) if (t.status) statuses.set(t.status.semantic, t.status.name);
    return { assignees: uniq(tasks.map((t: any) => t.assignee)), tags: uniq(tasks.flatMap((t: any) => t.tags)), statuses: [...statuses.entries()] };
  }, [data]);

  const match = (t: any) => (!f.kind || t.kind === f.kind) && (!f.status || t.status?.semantic === f.status) && (!f.assignee || t.assignee === f.assignee) && (!f.tag || t.tags.includes(f.tag));
  const rows: Row[] = useMemo(() => {
    if (!data || !collapsed) return [];
    const out: Row[] = [];
    for (const r of data.releases) {
      out.push({ type: 'release', id: `r:${r.id}`, level: 0, r });
      if (collapsed.has(`r:${r.id}`)) continue;
      for (const s of r.sprints) {
        out.push({ type: 'sprint', id: `s:${s.id}`, level: 1, s });
        if (collapsed.has(`s:${s.id}`)) continue;
        for (const g of s.groups) {
          const tasks = g.tasks.filter(match);
          if (!tasks.length) continue;
          const gid = `g:${s.id}:${g.kind}`;
          out.push({ type: 'group', id: gid, level: 2, label: g.label, count: tasks.length });
          if (collapsed.has(gid)) continue;
          for (const t of tasks) out.push({ type: 'task', id: `t:${t.id}`, level: 3, t, inSprint: true });
        }
      }
    }
    const outside = data.outside.filter(match);
    if (outside.length) {
      out.push({ type: 'group', id: 'g:outside', level: 0, label: 'Вне спринтов', count: outside.length });
      if (!collapsed.has('g:outside')) for (const t of outside) out.push({ type: 'task', id: `t:${t.id}`, level: 1, t, inSprint: false });
    }
    return out;
  }, [data, collapsed, f]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <section className="panel"><Loading rows={8} /></section>;
  if (!data) return null;
  if (!data.releases.length && !data.outside.length) {
    return <section className="panel"><Empty title="Нет релизов со спринтами">Календарь релизов создаётся в разделе «Спринты».</Empty></section>;
  }

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allIds = [...data.releases.flatMap((r: any) => [`r:${r.id}`, ...r.sprints.flatMap((s: any) => [`s:${s.id}`, ...s.groups.map((g: any) => `g:${s.id}:${g.kind}`)])]), 'g:outside'];
  const showTip = (e: React.MouseEvent, title: string, lines: string[]) => setTip({ x: e.clientX, y: e.clientY, title, lines });

  return (
    <div className={`gantt-wrap ${full ? 'full' : ''}`}>
      <div className="gantt-toolbar">
        {toolbar}
        <select className="select sm" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Тип работ">
          <option value="">Все типы</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="select sm" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Статус">
          <option value="">Все статусы</option>
          {options.statuses.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {options.assignees.length > 0 && (
          <select className="select sm" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} aria-label="Ответственный">
            <option value="">Все ответственные</option>
            {options.assignees.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {options.tags.length > 0 && (
          <select className="select sm" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} aria-label="Тег">
            <option value="">Все теги</option>
            {options.tags.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Масштаб">
          <button className={scale === 'week' ? 'on' : ''} onClick={() => setScale('week')}>Недели</button>
          <button className={scale === 'month' ? 'on' : ''} onClick={() => setScale('month')}>Месяцы</button>
        </div>
        <button className="btn ghost sm" onClick={() => scrollTo(addDays(data.today, -7))}>Сегодня</button>
        <button className="btn ghost sm" onClick={() => setCollapsed(new Set())}>Развернуть все</button>
        <button className="btn ghost sm" onClick={() => setCollapsed(new Set(allIds))}>Свернуть все</button>
        <button className="btn ghost sm" onClick={() => setFull(!full)} aria-pressed={full}>{full ? 'Обычный вид' : 'Во весь экран'}</button>
      </div>
      <Legend />
      <div className="gantt-scroll" ref={scroller} style={{ maxHeight: full ? undefined : height }} onScroll={() => tip && setTip(null)}>
        <div className="gantt-inner" style={{ width: `calc(var(--gantt-left) + ${width}px)` }}>
          <div className="gantt-row gantt-header">
            <div className="gantt-left"><span className="c-task">Задача</span><span className="c-who">Ответственный</span><span className="c-st">Статус</span><span className="c-tags">Теги</span></div>
            <TimeHeader from={data.range.from} to={data.range.to} px={px} scale={scale} today={data.today} />
          </div>
          <div className="gantt-body">
            <Grid from={data.range.from} to={data.range.to} px={px} scale={scale} today={data.today} rows={rows.length} releases={data.releases} />
            {rows.map((row) => {
              const open = row.type === 'task' ? () => openFeature(row.t.key) : row.type === 'release' ? () => navigate(`/releases/${row.r.id}`) : undefined;
              return (
              <div key={row.id} className={`gantt-row ${row.type}`} style={{ height: ROW }} onClick={open}
                {...(open ? { role: 'button', tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') open(); } } : {})}>
                <div className="gantt-left" style={{ paddingLeft: 8 + row.level * 16 }}>
                  <LeftCells row={row} collapsed={collapsed!} toggle={toggle} />
                </div>
                <div className="gantt-time" style={{ width }}>
                  {row.type === 'release' && <ReleaseBars r={row.r} x={x} px={px} tip={showTip} hide={() => setTip(null)} />}
                  {row.type === 'sprint' && <SprintBars s={row.s} x={x} px={px} tip={showTip} hide={() => setTip(null)} />}
                  {row.type === 'task' && <TaskBars t={row.t} x={x} px={px} today={data.today} tip={showTip} hide={() => setTip(null)} />}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </div>
      {data.undated > 0 && <div className="small muted" style={{ marginTop: 6 }}>Ещё {data.undated} открытых задач без спринта и надёжных дат — на диаграмме не рисуются, они в бэклоге.</div>}
      {tip && (
        <div className="gantt-tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}>
          <b>{tip.title}</b>
          {tip.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

function LeftCells({ row, collapsed, toggle }: { row: Row; collapsed: Set<string>; toggle: (id: string) => void }) {
  const caret = (id: string) => (
    <button className="gantt-caret" aria-label={collapsed.has(id) ? 'Развернуть группу' : 'Свернуть группу'} aria-expanded={!collapsed.has(id)} onClick={(e) => { e.stopPropagation(); toggle(id); }}>
      <I.chevron style={{ transform: collapsed.has(id) ? undefined : 'rotate(90deg)' }} />
    </button>
  );
  if (row.type === 'release') {
    const r = row.r;
    return (
      <>
        <span className="c-task">{caret(row.id)}<b className="ellipsis">{r.name}</b>{r.approved ? <span className="pill ok">утверждён</span> : <span className="pill outline">не утверждён</span>}</span>
        <span className="c-who muted small">выкладка {dm(r.end)}</span>
        <span className="c-st small">{r.readiness !== null ? `готово ${r.readiness}%` : ''}</span>
        <span className="c-tags" />
      </>
    );
  }
  if (row.type === 'sprint') {
    const s = row.s;
    return (
      <>
        <span className="c-task">{caret(row.id)}<span>Спринт <b>{s.code}</b></span></span>
        <span className="c-who muted small">{dm(s.start_date)} – {dm(s.end_date)}</span>
        <span className="c-st muted small">тест до {dm(s.production_due)}</span>
        <span className="c-tags" />
      </>
    );
  }
  if (row.type === 'group') {
    return (
      <>
        <span className="c-task">{caret(row.id)}<span className="small" style={{ fontWeight: 600 }}>{row.label}</span><span className="muted small">{row.count}</span></span>
        <span className="c-who" /><span className="c-st" /><span className="c-tags" />
      </>
    );
  }
  const t = row.t;
  return (
    <>
      <span className="c-task" title={`${t.key} ${t.title}`}>
        <span className="key">{t.key}</span>
        <span className="ellipsis">{t.title}</span>
        {t.is_focus && <span className="pill beet" title="Фокусная задача релиза">фокус</span>}
        {t.is_product_internal && <span className="pill outline">внутр.</span>}
        {row.inSprint && t.kind === 'planned' && !t.timeline.agreed && t.status?.semantic !== 'done' && <span className="pill warn" title="Исходный план фиксируется при утверждении плана релиза">не согласовано</span>}
      </span>
      <span className="c-who small ellipsis">{t.assignee ?? ''}</span>
      <span className="c-st small ellipsis">{t.status && <><span className="dot" style={{ background: t.status.color }} />{t.status.name}</>}</span>
      <span className="c-tags small ellipsis">{t.tags.join(', ')}</span>
    </>
  );
}

function TimeHeader({ from, to, px, scale, today }: { from: string; to: string; px: number; scale: 'week' | 'month'; today: string }) {
  const months: { left: number; width: number; label: string }[] = [];
  const weeks: { left: number; label: string }[] = [];
  let d = from;
  while (d <= to) {
    const dt = new Date(ms(d));
    const next = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const end = next > to ? addDays(to, 1) : next;
    months.push({ left: days(from, d) * px, width: days(d, end) * px, label: `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}` });
    d = end;
  }
  for (let w = from; w <= to; w = addDays(w, 1)) if (new Date(ms(w)).getUTCDay() === 1) weeks.push({ left: days(from, w) * px, label: fmtDate(w, false) });
  return (
    <div className="gantt-time head" style={{ width: (days(from, to) + 1) * px }}>
      {months.map((m) => <div key={m.left} className="gt-month" style={{ left: m.left, width: m.width }}>{m.width > 60 && <span>{m.label}</span>}</div>)}
      {scale === 'week' && weeks.map((w) => <div key={w.left} className="gt-week" style={{ left: w.left }}>{w.label}</div>)}
      <div className="gt-today" style={{ left: days(from, today) * px }} title="Сегодня" />
    </div>
  );
}

function Grid({ from, to, px, scale, today, rows, releases }: { from: string; to: string; px: number; scale: 'week' | 'month'; today: string; rows: number; releases: any[] }) {
  const cells: ReactNode[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(ms(d)).getUTCDay();
    const left = days(from, d) * px;
    if (scale === 'week' && (wd === 0 || wd === 6)) cells.push(<div key={`we${d}`} className="gg-weekend" style={{ left, width: px }} />);
    if (wd === 1) cells.push(<div key={`wk${d}`} className="gg-week" style={{ left }} />);
    if (d.endsWith('-01')) cells.push(<div key={`m${d}`} className="gg-month" style={{ left }} />);
  }
  return (
    <div className="gantt-grid" style={{ height: rows * ROW, width: (days(from, to) + 1) * px }}>
      {cells}
      {releases.map((r) => <div key={r.id} className="gg-release" style={{ left: (days(from, r.end) + 1) * px }} title={`${r.name}: выкладка ${dm(r.end)}`} />)}
      <div className="gg-today" style={{ left: days(from, today) * px + px / 2 }} />
    </div>
  );
}

type TipFn = (e: React.MouseEvent, title: string, lines: string[]) => void;
const bar = (x: (d: string) => number, px: number, a: string, b: string) => ({ left: x(a), width: Math.max(px * 0.6, (days(a, b) + 1) * px) });

function ReleaseBars({ r, x, px, tip, hide }: { r: any; x: (d: string) => number; px: number; tip: TipFn; hide: () => void }) {
  const lines = [`${dm(r.start)} – выкладка ${dm(r.end)}`, r.approved ? 'План утверждён' : 'План не утверждён', ...(r.readiness !== null ? [`Готово ${r.readiness}% релизных задач`] : [])];
  return (
    <>
      <div className="gb rel" style={bar(x, px, r.start, r.end)} onMouseMove={(e) => tip(e, r.name, lines)} onMouseLeave={hide} />
      <Diamond cls="ms-release" left={x(r.end) + px / 2} onMove={(e) => tip(e, `${r.name}: выкладка`, [dm(r.end)])} onLeave={hide} />
    </>
  );
}

function SprintBars({ s, x, px, tip, hide }: { s: any; x: (d: string) => number; px: number; tip: TipFn; hide: () => void }) {
  return (
    <>
      <div className="gb sp-dev" style={bar(x, px, s.start_date, s.end_date)} onMouseMove={(e) => tip(e, `Спринт ${s.code}: разработка`, [`${dm(s.start_date)} – ${dm(s.end_date)}`])} onMouseLeave={hide} />
      <div className="gb sp-qa" style={bar(x, px, s.testing_start, s.production_due)} onMouseMove={(e) => tip(e, `Спринт ${s.code}: тестирование`, [`${dm(s.testing_start)} – ${dm(s.production_due)}`])} onMouseLeave={hide} />
      <Diamond cls="ms-release ghost" left={x(s.production_due) + px / 2} onMove={(e) => tip(e, `Спринт ${s.code}: выкладка`, [`до ${dm(s.production_due)}`])} onLeave={hide} />
    </>
  );
}

const STATE_LABEL: Record<string, string> = { done: 'завершён', active: 'идёт', unconfirmed: 'нет подтверждения', not_started: 'не начат', skipped: 'не требовался' };

function TaskBars({ t, x, px, today, tip, hide }: { t: any; x: (d: string) => number; px: number; today: string; tip: TipFn; hide: () => void }) {
  const tl = t.timeline;
  const parts: ReactNode[] = [];
  let maxRight = 0;
  const track = (left: number, width: number) => { maxRight = Math.max(maxRight, left + width); };
  for (const p of tl.phases) {
    if (p.state === 'skipped') continue;
    const lines = [
      `Этап: ${PHASE_LABEL[p.phase]} — ${STATE_LABEL[p.state]}`,
      `План: ${p.plan ? `${dm(p.plan.start)} – ${dm(p.plan.end)}` : '—'}`,
      ...(p.baseline ? [`Исходный план: ${dm(p.baseline.start)} – ${dm(p.baseline.end)}`] : []),
      ...(p.fact.start ? [`Факт: ${dm(p.fact.start)} – ${p.fact.end ? dm(p.fact.end) : 'идёт'}`] : []),
      ...(p.forecast_end ? [`Прогноз завершения: ${dm(p.forecast_end)}${p.forecast_reason ? ` (${p.forecast_reason})` : ''}`] : []),
      ...(dev(p.deviation_days) ? [`Отклонение: ${dev(p.deviation_days)}`] : []),
      ...(p.risk ? [`⚠ ${p.risk}`] : []),
    ];
    const ev = { onMouseMove: (e: React.MouseEvent) => tip(e, `${t.key} ${t.title}`, lines), onMouseLeave: hide };
    const k = `ph-${p.phase}`;
    if (p.baseline) { const g = bar(x, px, p.baseline.start, p.baseline.end); parts.push(<div key={`b${p.phase}`} className={`gb base ${k}`} style={g} {...ev} />); track(g.left, g.width); }
    if (p.plan) { const g = bar(x, px, p.plan.start, p.plan.end); parts.push(<div key={`p${p.phase}`} className={`gb plan ${k} ${p.state === 'unconfirmed' ? 'unconfirmed' : ''}`} style={g} {...ev} />); track(g.left, g.width); }
    if (p.fact.start) {
      const end = p.fact.end ?? (today < p.fact.start ? p.fact.start : today);
      const g = bar(x, px, p.fact.start, end);
      parts.push(<div key={`f${p.phase}`} className={`gb fact ${k}`} style={g} {...ev} />);
      track(g.left, g.width);
    }
    // forecast = only the part still expected beyond what is already drawn: after today for a running phase,
    // after the plan end for one that has not been confirmed as started (the plan itself is already on the bar)
    if (p.forecast_end && p.state !== 'done') {
      const start = p.fact.start ? addDays(today, 1) : p.plan ? addDays(p.plan.end, 1) : today;
      if (p.forecast_end >= start) { const g = bar(x, px, start, p.forecast_end); parts.push(<div key={`c${p.phase}`} className={`gb forecast ${k}`} style={g} {...ev} />); track(g.left, g.width); }
    }
  }
  const r = tl.release;
  const relLines = [
    `Выкладка — ${r.state === 'done' ? 'выполнена' : STATE_LABEL[r.state]}`,
    `План: ${dm(r.plan)}`, ...(r.baseline ? [`Исходный план: ${dm(r.baseline)}`] : []), ...(r.fact ? [`Факт: ${dm(r.fact)}`] : []),
    ...(r.forecast && r.forecast !== r.plan ? [`Прогноз: ${dm(r.forecast)}`] : []), ...(dev(r.deviation_days) ? [`Отклонение: ${dev(r.deviation_days)}`] : []), ...(r.risk ? [`⚠ ${r.risk}`] : []),
  ];
  const relEv = { onMove: (e: React.MouseEvent) => tip(e, `${t.key} ${t.title}`, relLines), onLeave: hide };
  if (r.baseline && r.baseline !== r.plan) parts.push(<Diamond key="rb" cls="ms-release outline" left={x(r.baseline) + px / 2} {...relEv} />);
  if (r.plan) { parts.push(<Diamond key="rp" cls={`ms-release ${r.fact ? 'ghost' : 'plan'}`} left={x(r.plan) + px / 2} {...relEv} />); track(x(r.plan), px); }
  if (r.forecast && r.plan && r.forecast > r.plan && !r.fact) { parts.push(<Diamond key="rf" cls="ms-release forecast" left={x(r.forecast) + px / 2} {...relEv} />); track(x(r.forecast), px); }
  if (r.fact) { parts.push(<Diamond key="ra" cls="ms-release" left={x(r.fact) + px / 2} {...relEv} />); track(x(r.fact), px); }
  const deviation = r.deviation_days ?? null;
  if (deviation) parts.push(<span key="dv" className={`gb-dev ${deviation > 0 ? 'late' : 'early'}`} style={{ left: maxRight + 8 }}>{deviation > 0 ? `+${deviation}` : deviation} дн.</span>);
  const risky = tl.phases.some((p: any) => p.risk) || r.risk;
  if (risky && !deviation) parts.push(<span key="rk" className="gb-dev late" style={{ left: maxRight + 8 }} title="Есть неподтверждённые этапы">⚠</span>);
  return <>{parts}</>;
}

function Diamond({ cls, left, onMove, onLeave }: { cls: string; left: number; onMove?: (e: React.MouseEvent) => void; onLeave?: () => void }) {
  return <div className={`ms ${cls}`} style={{ left }} onMouseMove={onMove} onMouseLeave={onLeave} />;
}

function Legend() {
  return (
    <div className="gantt-legend small">
      {(['product', 'design', 'dev', 'qa'] as const).map((p) => <span key={p}><i className={`sw ph-${p}`} />{PHASE_LABEL[p]}</span>)}
      <span><i className="ms-mini" />Выкладка</span>
      <span className="muted">|</span>
      <span><i className="sw plan ph-dev" />план</span>
      <span><i className="sw base ph-dev" />исходный план</span>
      <span><i className="sw fact ph-dev" />факт</span>
      <span><i className="sw forecast ph-dev" />прогноз</span>
      <span><i className="sw plan ph-dev unconfirmed" />нет подтверждения</span>
    </div>
  );
}

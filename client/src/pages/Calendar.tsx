// Sprints and calendar months (FR-06): releases of two sprints, generator with preview.
import { useState } from 'react';
import { I } from '../icons';
import { api, ApiError, fmtDate, invalidate, navigate, openFeature, toast, useApi, useApp } from '../lib';
import { Empty, ErrorBox, Loading, Modal, Notice, PageHead, Progress, StatusPill } from '../ui';

const SPRINT_STATUS: Record<string, string> = { planned: 'план', active: 'идёт', closed: 'закрыт' };

export function Calendar() {
  const { me } = useApp();
  const { data, error } = useApi<any>('/calendar');
  const [preview, setPreview] = useState<any | null>(null);
  const canPlan = !!me?.permissions.plan && !me.must_change_password;
  const openPreview = async () => {
    try {
      setPreview(await api('/calendar/generate-preview', { method: 'POST', body: {} }));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <PageHead title="Спринты и календарь" sub="Релиз — два спринта по 14 дней (среда — вторник). Тестирование — со следующего дня, выкладка — до четверга через 9 дней после конца спринта. Месяцы бюджета и доступности считаются отдельно.">
        {canPlan && <button className="btn primary" onClick={openPreview}><I.plus />Создать следующие периоды</button>}
      </PageHead>
      <ErrorBox error={error} />
      {!data ? <div className="panel"><Loading rows={6} /></div> : (
        <div className="stack loose">
          {data.releases.length === 0 ? (
            <div className="panel"><Empty title="Спринтов пока нет">{canPlan ? 'Нажмите «Создать следующие периоды» — календарь построится от релиза 8 (спринт 8.1 начинается 07.10.2026).' : 'Календарь ещё не создан.'}</Empty></div>
          ) : (
            <section className="panel flush">
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Релиз</th><th>Спринт 1</th><th>Спринт 2</th><th style={{ width: 180 }}>Готовность релиза</th><th>Фокус</th></tr></thead>
                  <tbody>
                    {data.releases.map((r: any) => (
                      <tr key={r.id}>
                        <td className="title-cell">
                          <a href={`/releases/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/releases/${r.id}`); }} className="t">{r.name}</a>
                          <div className="row wrap small muted" style={{ marginTop: 3 }}><StatusPill status={r.status} />финал до {fmtDate(r.planned_date)}{r.approved && <span className="pill ok">утверждён</span>}</div>
                        </td>
                        {[0, 1].map((i) => {
                          const s = r.sprints[i];
                          if (!s) return <td key={i} className="muted">—</td>;
                          const current = s.id === data.current_sprint_id;
                          return (
                            <td key={s.id} style={current ? { background: 'var(--beet-soft, rgba(140,30,80,.06))' } : undefined}>
                              <a href={`/backlog?sprint=${s.id}`} onClick={(e) => { e.preventDefault(); navigate(`/backlog?sprint=${s.id}`); }}>
                                <b>{s.code}</b> <span className="small muted">{SPRINT_STATUS[s.status]}{current ? ' · текущий' : ''}</span>
                              </a>
                              <div className="small">разработка {fmtDate(s.start_date, false)} — {fmtDate(s.end_date, false)}</div>
                              <div className="small muted">тест с {fmtDate(s.testing_start, false)}, выкладка до <b>{fmtDate(s.production_due, false)}</b></div>
                              <div className="small muted">задач {s.done_count}/{s.planned_count}{s.reference_count ? `, багов справочно ${s.reference_count}` : ''}</div>
                            </td>
                          );
                        })}
                        <td><Progress value={r.planned_count ? Math.round((r.done_count / r.planned_count) * 100) : 0} label={`${r.done_count}/${r.planned_count}`} /></td>
                        <td className="small">{r.focus_open ? <span style={{ color: 'var(--warn)' }}>открыто {r.focus_open}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {data.months.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Учётные месяцы</h2><span className="small muted">бюджет и доступность команд считаются по календарным месяцам</span></div>
              <div className="panel-body row wrap">
                {data.months.map((m: any) => (
                  <span key={m.id} className={`pill ${m.status === 'closed' ? '' : 'outline'}`} title={`${fmtDate(m.start_date)} — ${fmtDate(m.end_date)}`}>
                    {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
                  </span>
                ))}
              </div>
            </section>
          )}

        </div>
      )}
      {preview && <GeneratePreview preview={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function GeneratePreview({ preview, onClose }: { preview: any; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const p = preview.plan;
  const nothing = !p.releases.length && !p.sprints.length && !p.months.length;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<any>('/calendar/generate', { method: 'POST', body: { plan_hash: preview.plan_hash } });
      toast(`Создано: релизов ${r.created.releases}, спринтов ${r.created.sprints}, месяцев ${r.created.months}`);
      invalidate();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      if (e instanceof ApiError && e.code === 'stale') onClose();
    }
    setBusy(false);
  };
  return (
    <Modal title="Создать следующие периоды" onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={busy || nothing} onClick={apply}>{busy ? 'Создаём…' : 'Создать'}</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Окно: релизы {p.window.first_cycle}–{p.window.last_cycle}, месяцы {p.window.first_month} — {p.window.last_month}. Уже существующие записи не меняются, задачи не переносятся. Повторный запуск ничего не дублирует.
        </p>
        {nothing && <Notice kind="ok">Календарь уже построен на всё окно — создавать нечего.</Notice>}
        {p.conflicts.length > 0 && <Notice kind="warn">Не будут созданы из-за пересечений: {p.conflicts.map((c: any) => `${c.code} — ${c.reason}`).join('; ')}</Notice>}
        {p.sprints.length > 0 && (
          <table className="data">
            <thead><tr><th>Спринт</th><th>Разработка</th><th>Тестирование с</th><th>Выкладка до</th></tr></thead>
            <tbody>
              {p.sprints.map((s: any) => (
                <tr key={s.code}><td><b>{s.code}</b>{s.ordinal === 1 && !p.releases.find((r: any) => r.cycle === s.cycle)?.existing_id ? <span className="small muted"> (новый релиз {s.cycle})</span> : null}</td><td>{fmtDate(s.start_date, false)} — {fmtDate(s.end_date)}</td><td>{fmtDate(s.testing_start)}</td><td>{fmtDate(s.production_due)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {p.months.length > 0 && <div className="small">Месяцы: {p.months.map((m: any) => m.month).join(', ')}</div>}
        {p.skipped.length > 0 && <details className="small muted"><summary>Пропущено как существующее: {p.skipped.length}</summary>{p.skipped.map((x: any) => `${x.code}: ${x.reason}`).join('; ')}</details>}
      </div>
    </Modal>
  );
}

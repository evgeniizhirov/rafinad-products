// «Этапы» of a task card (vNext ТЗ §2.2–2.3): plan from the sprint, baseline, confirmed facts, forecast, deviation.
// The product department moves the task between phases; nobody types dates for every phase.
import { useState } from 'react';
import { api, fmtDate, invalidate, toast, useApi } from '../lib';
import { Modal, ReasonModal } from '../ui';

const STATE: Record<string, { label: string; cls: string }> = {
  done: { label: 'завершён', cls: 'ok' },
  active: { label: 'идёт', cls: 'info' },
  unconfirmed: { label: 'нет подтверждения', cls: 'warn' },
  not_started: { label: 'не начат', cls: 'outline' },
  skipped: { label: 'не требовался', cls: 'outline' },
};
const d = (x: string | null | undefined) => (x ? fmtDate(x, false) : '—');
const range = (r: any) => (r ? `${d(r.start)} – ${d(r.end)}` : '—');
const dev = (n: number | null) => (n === null || n === undefined ? null : n === 0 ? 'в срок' : n > 0 ? `+${n} дн.` : `${n} дн.`);
const today = () => new Date().toISOString().slice(0, 10);

export function PhasePanel({ f }: { f: any }) {
  const { data, reload } = useApi<any>(`/features/${f.id}/phases`) as any;
  const [moving, setMoving] = useState(false);
  const [fixing, setFixing] = useState<any | null>(null);
  const [forecast, setForecast] = useState<any | null>(null);
  const [rebase, setRebase] = useState(false);
  if (!data) return null;
  const tl = data.timeline;
  const call = async (path: string, method: string, body: unknown, ok: string) => {
    try {
      await api(path, { method, body });
      toast(ok);
      invalidate();
      reload?.();
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };
  const rows = [...tl.phases.filter((p: any) => p.plan || p.state !== 'not_started' || ['dev', 'qa'].includes(p.phase))];
  const hasAny = rows.some((p: any) => p.plan || p.fact.start) || tl.release.plan || tl.release.fact;
  const lastRev = data.baselines.at(-1);
  return (
    <section className="stack tight" aria-label="Этапы задачи">
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 className="grow" style={{ fontSize: 15 }}>Этапы</h3>
        {(f.task_kind ?? 'planned') === 'planned' && f.sprint && (
          tl.agreed
            ? <span className="pill ok" title={lastRev ? `Ревизия ${lastRev.revision} от ${fmtDate(lastRev.captured_at)}${lastRev.reason ? ` — ${lastRev.reason}` : ''}` : ''}>согласовано{lastRev && lastRev.revision > 1 ? `, ревизия ${lastRev.revision}` : ''}</span>
            : <span className="pill warn" title="Исходный план фиксируется при утверждении плана релиза">не согласовано</span>
        )}
        {data.can_confirm && <button className="btn sm" onClick={() => setMoving(true)}>Перевести на этап</button>}
        {data.can_rebaseline && tl.agreed && <button className="btn ghost sm" onClick={() => setRebase(true)}>Пересмотреть план</button>}
      </div>
      {!hasAny ? (
        <p className="small muted" style={{ margin: 0 }}>Нет спринта и надёжных дат — на Ганте задача не рисуется, пока её не назначат в спринт.</p>
      ) : (
        <div className="table-wrap"><table className="data small">
          <thead><tr><th>Этап</th><th>План</th><th>Исходный</th><th>Факт</th><th>Прогноз</th><th>Откл.</th><th /></tr></thead>
          <tbody>
            {rows.map((p: any) => (
              <tr key={p.phase} className={tl.current === p.phase ? 'current' : ''}>
                <td><b>{p.label}</b> <span className={`pill ${STATE[p.state].cls}`}>{STATE[p.state].label}</span>{p.risk && <div style={{ color: 'var(--warn)' }}>{p.risk}</div>}</td>
                <td>{range(p.plan)}</td>
                <td className="muted">{range(p.baseline)}</td>
                <td>{p.fact.start || p.fact.end ? `${d(p.fact.start)} – ${p.fact.end ? d(p.fact.end) : '…'}` : '—'}</td>
                <td>{p.forecast_end ? <span title={p.forecast_reason ?? ''}>{d(p.forecast_end)}{p.forecast_reason ? ' *' : ''}</span> : '—'}</td>
                <td style={{ color: p.deviation_days > 0 ? 'var(--danger)' : p.deviation_days < 0 ? 'var(--ok, #3f8f4f)' : undefined }}>{dev(p.deviation_days) ?? '—'}</td>
                <td>{data.can_confirm && ['active', 'unconfirmed', 'not_started'].includes(p.state) && p.phase !== 'product' && p.phase !== 'design' && (
                  <button className="btn ghost sm" onClick={() => setForecast({ phase: p.phase, label: p.label, end: p.forecast_end ?? '', reason: p.forecast_reason ?? '' })}>Прогноз</button>
                )}</td>
              </tr>
            ))}
            <tr>
              <td><b>Выкладка</b> <span className={`pill ${STATE[tl.release.state].cls}`}>{tl.release.state === 'done' ? 'выполнена' : STATE[tl.release.state].label}</span>{tl.release.risk && <div style={{ color: 'var(--warn)' }}>{tl.release.risk}</div>}</td>
              <td>{d(tl.release.plan)}</td>
              <td className="muted">{d(tl.release.baseline)}</td>
              <td>{d(tl.release.fact)}</td>
              <td>{tl.release.forecast && tl.release.forecast !== tl.release.plan ? d(tl.release.forecast) : '—'}</td>
              <td style={{ color: tl.release.deviation_days > 0 ? 'var(--danger)' : undefined }}>{dev(tl.release.deviation_days) ?? '—'}</td>
              <td>{data.can_confirm && tl.release.state !== 'done' && <button className="btn ghost sm" onClick={() => setForecast({ phase: 'release', label: 'Выкладка', end: tl.release.forecast ?? '', reason: '' })}>Прогноз</button>}</td>
            </tr>
          </tbody>
        </table></div>
      )}
      {data.events.length > 0 && (
        <details className="small">
          <summary>Подтверждённые переходы: {data.events.length}</summary>
          {data.events.map((e: any) => (
            <div key={e.id} className="row" style={{ gap: 6 }}>
              <span>{fmtDate(e.at)}</span>
              <span>{data.phases.find((x: any) => x.code === e.phase)?.name}: {e.kind === 'start' ? 'начало' : 'завершение'}</span>
              <span className="muted grow">{e.created_by_name}{e.original_at ? `, исправлено с ${fmtDate(e.original_at)}${e.corrected_by_name ? ` (${e.corrected_by_name})` : ''}` : ''}{e.reason ? ` — ${e.reason}` : ''}</span>
              {data.can_confirm && <button className="btn ghost sm" onClick={() => setFixing(e)}>Исправить дату</button>}
            </div>
          ))}
        </details>
      )}
      {moving && <MoveDialog f={f} data={data} onClose={() => setMoving(false)} onSave={async (body) => { if (await call(`/features/${f.id}/phase`, 'POST', body, 'Этап обновлён')) setMoving(false); }} />}
      {fixing && <FixDialog e={fixing} onClose={() => setFixing(null)} onSave={async (at, reason) => { if (await call(`/phase-events/${fixing.id}`, 'PATCH', { at, reason }, 'Дата исправлена')) setFixing(null); }} />}
      {forecast && <ForecastDialog fc={forecast} onClose={() => setForecast(null)} onSave={async (end, reason) => { if (await call(`/features/${f.id}/phase-forecast`, 'PUT', { phase: forecast.phase, end_date: end || null, reason: reason || undefined }, end ? 'Прогноз сохранён' : 'Прогноз снят')) setForecast(null); }} />}
      {rebase && (
        <ReasonModal title="Пересмотреть согласованный план" confirmText="Зафиксировать новую ревизию" onClose={() => setRebase(false)}
          onConfirm={async (reason) => { if (await call(`/features/${f.id}/baseline`, 'POST', { reason }, 'Новая ревизия плана зафиксирована')) setRebase(false); }}>
          <p>Текущий план (по спринту) станет новой ревизией исходного плана. Предыдущие ревизии сохраняются в истории, а первая обещанная дата для аналитики не меняется.</p>
        </ReasonModal>
      )}
    </section>
  );
}

function MoveDialog({ f, data, onClose, onSave }: { f: any; data: any; onClose: () => void; onSave: (b: any) => void }) {
  const tl = data.timeline;
  const [phase, setPhase] = useState<string>(nextPhase(tl.current) ?? 'dev');
  const [at, setAt] = useState(today());
  const [reason, setReason] = useState('');
  const late = at !== today();
  return (
    <Modal title={`${f.key}: перевести на этап`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={late && !reason.trim()} onClick={() => onSave({ phase, at, ...(reason.trim() ? { reason: reason.trim() } : {}) })}>Сохранить</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Текущий этап завершится этой датой, новый начнётся ею. Даты остальных этапов вводить не нужно.</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <select className="select" value={phase} onChange={(e) => setPhase(e.target.value)} aria-label="Этап" style={{ width: 'auto' }}>
            {data.phases.map((p: any) => <option key={p.code} value={p.code}>{p.name}</option>)}
            <option value="complete">Всё готово (завершить текущий этап)</option>
          </select>
          <input className="input" type="date" value={at} max={today()} onChange={(e) => setAt(e.target.value)} aria-label="Дата" style={{ width: 'auto' }} />
        </div>
        {late && <input className="input" placeholder="Причина: почему дата не сегодняшняя" value={reason} onChange={(e) => setReason(e.target.value)} />}
      </div>
    </Modal>
  );
}

const ORDER = ['product', 'design', 'dev', 'qa', 'release'];
function nextPhase(cur: string | null): string | null {
  if (!cur) return null;
  const i = ORDER.indexOf(cur);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : 'complete';
}

function FixDialog({ e, onClose, onSave }: { e: any; onClose: () => void; onSave: (at: string, reason: string) => void }) {
  const [at, setAt] = useState(e.at);
  const [reason, setReason] = useState('');
  return (
    <Modal title="Исправить дату факта" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!reason.trim() || at === e.at} onClick={() => onSave(at, reason.trim())}>Исправить</button></>}>
      <div className="stack">
        <input className="input" type="date" value={at} max={today()} onChange={(x) => setAt(x.target.value)} aria-label="Дата" />
        <input className="input" placeholder="Причина исправления (обязательно)" value={reason} onChange={(x) => setReason(x.target.value)} />
        <p className="small muted" style={{ margin: 0 }}>Исходная дата сохранится, исправление попадёт в журнал.</p>
      </div>
    </Modal>
  );
}

function ForecastDialog({ fc, onClose, onSave }: { fc: any; onClose: () => void; onSave: (end: string, reason: string) => void }) {
  const [end, setEnd] = useState(fc.end);
  const [reason, setReason] = useState(fc.reason);
  return (
    <Modal title={`Прогноз: ${fc.label}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={() => onSave('', '')}>Снять прогноз</button><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!end || !reason.trim()} onClick={() => onSave(end, reason.trim())}>Сохранить</button></>}>
      <div className="stack">
        <input className="input" type="date" value={end} onChange={(x) => setEnd(x.target.value)} aria-label="Ожидаемое завершение" />
        <input className="input" placeholder="Причина задержки или опережения (обязательно)" value={reason} onChange={(x) => setReason(x.target.value)} />
        <p className="small muted" style={{ margin: 0 }}>Прогноз не меняет исходный план — на Ганте видно и обещание, и ожидание.</p>
      </div>
    </Modal>
  );
}

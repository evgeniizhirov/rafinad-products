// Monthly budget and team availability (FR-05). Planning section — not on the overview.
import { useState } from 'react';
import { api, fmtH, invalidate, mutate, toast, useApi, useApp } from '../lib';
import { Empty, ErrorBox, Loading, Notice, PageHead, ReasonModal } from '../ui';

const rub = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function Budget() {
  const { me } = useApp();
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 7));
  const { data, error } = useApi<any>(me?.permissions.plan ? `/planning/budget?from=${from}&months=4` : null);
  const [closing, setClosing] = useState<any | null>(null);
  if (!me?.permissions.plan) return <Empty title="Раздел доступен продуктовой команде и администраторам" />;
  const shift = (n: number) => {
    const d = new Date(`${from}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    setFrom(d.toISOString().slice(0, 7));
  };
  return (
    <>
      <PageHead title="Бюджет и доступность" sub="Календарные месяцы: лимит в рублях и гарантированные часы команд. Прогноз считается по плановым задачам в спринтах; баги и оперативные доработки в плановый бюджет не входят.">
        <button className="btn" onClick={() => shift(-1)}>←</button>
        <button className="btn" onClick={() => shift(1)}>→</button>
      </PageHead>
      <ErrorBox error={error} />
      {!data ? <div className="panel"><Loading rows={6} /></div> : (
        <div className="stack loose">
          <Notice kind="info">
            Стоимость = часы платных команд × ставка, действующая на начало спринта задачи. Product и Design учитываются в часах, но не в рублях.
            Часы задачи распределяются по месяцам {data.allocation === 'workdays' ? 'пропорционально рабочим дням' : 'пропорционально календарным дням'} её интервала работ (или спринта) — это прогноз, а не бухгалтерский факт.
            Закрытый месяц фиксируется и не пересчитывается.
          </Notice>
          <div className="grid-2">
            {data.months.map((m: any) => <MonthCard key={m.month} m={m} teams={data.teams} onClose={() => setClosing(m)} />)}
          </div>
        </div>
      )}
      {closing && (
        <ReasonModal title={`Закрыть ${monthName(closing.month)}`} confirmText="Закрыть месяц" onClose={() => setClosing(null)}
          onConfirm={async (reason) => { await mutate(`/planning/months/${closing.month}/close`, 'POST', { reason, version: closing.version }, 'Месяц закрыт'); setClosing(null); }}>
          <p>Расчёт месяца будет зафиксирован: дальнейшие изменения ставок и плана его не меняют.</p>
        </ReasonModal>
      )}
    </>
  );
}

function MonthCard({ m, teams, onClose }: { m: any; teams: any[]; onClose: () => void }) {
  const [limit, setLimit] = useState<string>('');
  const closed = m.status === 'closed';
  const missing = m.status === 'missing';
  const pct = m.budget_limit_rub ? Math.min(100, Math.round((m.cost / m.budget_limit_rub) * 100)) : null;
  const saveLimit = async () => {
    try {
      await api('/planning/monthly-budget', { method: 'PUT', body: { month: m.month, budget_limit_rub: limit === '' ? null : Number(limit.replace(/\s/g, '').replace(',', '.')), version: m.version } });
      invalidate();
      toast('Лимит сохранён');
      setLimit('');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="grow" style={{ textTransform: 'capitalize' }}>{monthName(m.month)}</h2>
        {closed ? <span className="pill outline">закрыт</span> : missing ? <span className="pill warn">месяц не создан</span> : <button className="btn ghost sm" onClick={onClose}>Закрыть месяц</button>}
      </div>
      <div className="panel-body stack">
        {missing ? <p className="small muted">Создайте календарь в разделе «Спринты».</p> : (
          <>
            <div className="row wrap" style={{ alignItems: 'baseline' }}>
              <b className="num" style={{ fontSize: 22, color: m.over_budget ? 'var(--danger)' : undefined }}>{rub(m.cost)}</b>
              <span className="muted">{m.forecast ? 'прогноз' : 'зафиксировано'} из лимита {rub(m.budget_limit_rub)}</span>
            </div>
            {pct !== null && <div className="meter"><i style={{ width: `${pct}%`, background: m.over_budget ? 'var(--danger)' : 'var(--beet)' }} /></div>}
            {m.over_budget && <div className="small" style={{ color: 'var(--danger)' }}>Превышение лимита на {rub(m.cost - m.budget_limit_rub)}</div>}
            {m.incomplete > 0 && <div className="small" style={{ color: 'var(--warn)' }}>Неполная стоимость: у {m.incomplete} задач нет оценки платной команды</div>}
            {!closed && (
              <div className="row small">
                Лимит, ₽: <input className="input sm" style={{ width: 140 }} inputMode="numeric" placeholder={m.budget_limit_rub ?? 'не задан'} value={limit} onChange={(e) => setLimit(e.target.value)} />
                <button className="btn sm" disabled={limit === ''} onClick={saveLimit}>Сохранить</button>
              </div>
            )}
            <table className="data">
              <thead><tr><th>Команда</th><th className="r">План, ч</th><th className="r">Доступно, ч</th></tr></thead>
              <tbody>
                {teams.map((t: any) => {
                  const h = m.hours?.[t.id] ?? 0;
                  const cap = m.capacity?.[t.id];
                  const over = (m.over_capacity ?? []).includes(t.id);
                  return (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td className="r num" style={over ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtH(h)}</td>
                      <td className="r">
                        {closed ? fmtH(cap ?? 0) : (
                          <input className="input sm" style={{ width: 80, textAlign: 'right' }} defaultValue={cap ?? ''} placeholder="—" onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v === String(cap ?? '')) return;
                            mutate('/planning/monthly-capacity', 'PUT', { month: m.month, team_id: t.id, hours: v === '' ? null : Number(v.replace(',', '.')) }, 'Доступность сохранена');
                          }} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {m.tasks?.length > 0 && (
              <details className="small">
                <summary>Задачи месяца: {m.tasks.length}</summary>
                {m.tasks.map((t: any) => <div key={t.id} className="row"><span className="key">{t.key}</span><span className="grow ellipsis">{t.title}</span><span className="muted">{Math.round(t.share * 100)}%</span><span>{rub(t.cost)}{t.incomplete ? ' *' : ''}</span></div>)}
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

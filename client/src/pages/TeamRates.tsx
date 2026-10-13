// Admin: team rates RUB/hour versioned by sprint (FR-05). History is append-only.
import { useState } from 'react';
import { fmtDate, mutate, useApi } from '../lib';
import { Loading } from '../ui';

export function TeamRates() {
  const { data } = useApi<any>('/admin/team-rates');
  const sprints = useApi<any>('/sprints');
  const [v, setV] = useState({ team_id: '', rate: '', include: true, sprint: '' });
  if (!data) return <div className="panel"><Loading rows={4} /></div>;
  const open = (sprints.data?.sprints ?? []).filter((s: any) => s.status !== 'closed');
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h2>Новая ставка</h2></div>
        <div className="panel-body row wrap">
          <select className="select" value={v.team_id} onChange={(e) => setV({ ...v, team_id: e.target.value })} aria-label="Команда">
            <option value="">Команда</option>
            {data.teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input className="input" style={{ width: 120 }} placeholder="₽ / час" inputMode="numeric" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} />
          <label className="check"><input type="checkbox" checked={v.include} onChange={(e) => setV({ ...v, include: e.target.checked })} />в рублёвом бюджете</label>
          <select className="select" value={v.sprint} onChange={(e) => setV({ ...v, sprint: e.target.value })} aria-label="С какого спринта">
            <option value="">С какого спринта</option>
            {open.map((s: any) => <option key={s.id} value={s.id}>{s.code} (с {fmtDate(s.start_date)})</option>)}
          </select>
          <button className="btn primary" disabled={!v.team_id || v.rate === '' || !v.sprint} onClick={async () => {
            const ok = await mutate('/admin/team-rates', 'POST', { team_id: v.team_id, rate_rub_per_hour: Number(v.rate.replace(',', '.')), include_in_budget: v.include, effective_sprint_id: v.sprint }, 'Ставка добавлена');
            if (ok) setV({ team_id: '', rate: '', include: true, sprint: '' });
          }}>Добавить</button>
          <p className="small muted" style={{ width: '100%', margin: 0 }}>Ставка действует с начала выбранного спринта и дальше, пока не задана следующая. Прошлые версии не редактируются, закрытые месяцы не пересчитываются.</p>
        </div>
      </section>
      <section className="panel flush">
        <table className="data">
          <thead><tr><th>Команда</th><th>Действует с</th><th className="r">₽ / час</th><th>В бюджете</th></tr></thead>
          <tbody>
            {data.teams.flatMap((t: any) => t.history.map((h: any, i: number) => (
              <tr key={`${t.id}-${h.effective_from}`} style={i ? { opacity: 0.6 } : undefined}>
                <td>{i === 0 ? <b>{t.name}</b> : ''}</td>
                <td>{h.effective_from === '2000-01-01' ? 'начальная' : fmtDate(h.effective_from)}</td>
                <td className="r num">{Number(h.rate_rub_per_hour).toLocaleString('ru-RU')}</td>
                <td>{h.include_in_budget ? 'да' : 'нет (только часы)'}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

import { useState } from 'react';
import { I } from '../icons';
import { VoteControl } from '../features';
import { openFeature, useApi, useApp, useDebounced } from '../lib';
import { Cubes, Empty, ErrorBox, GuestNote, Loading, PageHead, Seg, StatusPill } from '../ui';

export function Priorities() {
  const { me } = useApp();
  const myDepts = me?.department_ids ?? [];
  const [mode, setMode] = useState<'all' | 'mine'>(myDepts.length ? 'mine' : 'all');
  const [dept, setDept] = useState<string>(myDepts[0] ?? '');
  const [filter, setFilter] = useState<'' | 'voted' | 'not_voted'>('');
  const [closed, setClosed] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const qs = new URLSearchParams();
  if (mode === 'mine' && dept) {
    qs.set('department', dept);
    if (filter) qs.set('mode', filter);
  }
  if (closed) qs.set('include_closed', '1');
  if (dq) qs.set('q', dq);
  const { data, error } = useApi<any>(`/priorities?${qs}`);
  const deps: any[] = data?.departments ?? [];
  const shown = mode === 'mine' && dept ? deps.filter((d) => d.id === dept) : deps;
  return (
    <>
      <PageHead title="Приоритеты" sub="Каждый отдел оценивает важность доработки от 1 до 5. Общий балл — средневзвешенная оценка проголосовавших отделов." />
      <GuestNote />
      <div className="toolbar">
        <Seg value={mode} onChange={setMode} items={[{ id: 'mine', label: 'Интересы отдела' }, { id: 'all', label: 'Матрица всех отделов' }]} />
        {mode === 'mine' && (
          <>
            <select className="select" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Отдел">
              <option value="">Выберите отдел</option>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.name}{myDepts.includes(d.id) ? ' (ваш)' : ''}</option>)}
            </select>
            <select className="select" value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Фильтр голосов">
              <option value="">Все задачи</option>
              <option value="not_voted">Ещё не оценены отделом</option>
              <option value="voted">Оценённые отделом</option>
            </select>
          </>
        )}
        <div className="search" style={{ width: 240 }}><I.search /><input className="input" placeholder="Найти задачу" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" /></div>
        <label className="check small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />Показывать завершённые</label>
      </div>
      <ErrorBox error={error} />
      {!data ? <div className="panel"><Loading rows={8} /></div> : (
        <div className="panel flush">
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 220px)' }}>
            <table className="data matrix">
              <thead>
                <tr>
                  <th className="r" style={{ width: 44 }}>Ранг</th>
                  <th>Задача</th>
                  <th>Общий балл</th>
                  <th className="c">Голосов</th>
                  {shown.map((d) => (
                    <th key={d.id} className={`dep ${myDepts.includes(d.id) ? 'mine' : ''}`} title={`Вес ${d.weight}`}>
                      {d.name}
                      <span className="w">вес {d.weight}{data.vote_counts?.[d.id] !== undefined ? `, оценено ${data.vote_counts[d.id]}` : ''}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.features.length === 0 && <tr><td colSpan={4 + shown.length}><Empty title="Задач нет">Измените фильтр.</Empty></td></tr>}
                {data.features.map((f: any) => {
                  const votes = new Map(f.votes.map((v: any) => [v.department_id, v]));
                  return (
                    <tr key={f.id}>
                      <td className="r muted num">{f.rank}</td>
                      <td>
                        <a href={`?f=${f.key}`} onClick={(e) => { e.preventDefault(); openFeature(f.key); }} className="row top" style={{ minWidth: 240 }}>
                          <span className="key">{f.key}</span>
                          <span>
                            <span style={{ fontWeight: 500 }}>{f.title}</span>
                            <span className="small" style={{ display: 'block', marginTop: 2 }}><StatusPill status={f.status} /></span>
                          </span>
                        </a>
                      </td>
                      <td><Cubes score={f.priority.score} /></td>
                      <td className="c num">{f.priority.voters || <span className="muted">—</span>}</td>
                      {shown.map((d) => (
                        <td key={d.id} className={`c ${myDepts.includes(d.id) ? 'mine' : ''}`}>
                          <VoteControl feature={f} dept={d} vote={votes.get(d.id)} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 10 }}>
        «—» — отдел не голосовал (это не равно низкой оценке). При равных баллах выше стоит задача с более высокой оценкой Product, затем более ранняя.
      </p>
    </>
  );
}

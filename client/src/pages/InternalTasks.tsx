import { useState } from 'react';
import { openFeature, useApi, useApp } from '../lib';
import { Empty, Loading, Notice, PageHead, StatusPill } from '../ui';
export function InternalTasks(){
  const {me}=useApp();
  const [q,setQ]=useState('');
  const data=useApi<any>(me?.permissions.edit_catalog?`/internal-tasks?q=${encodeURIComponent(q)}`:null);
  if(!me?.permissions.edit_catalog)return <Empty title="Раздел недоступен" />;
  return <><PageHead title="Внутренние задачи Product" sub="Полноценные RF-задачи продуктового отдела, исключённые из общего Roadmap" /><input className="input" aria-label="Поиск внутренних задач" placeholder="Поиск" value={q} onChange={e=>setQ(e.target.value)} />{data.error?<Notice kind="danger">{data.error.message}</Notice>:!data.data?<Loading />:<><p>Всего задач: {data.data.total} · Закрыто: {data.data.closed} · Оценка: {data.data.estimated_hours} ч · Учтённый факт: {data.data.fact_hours} ч</p><div className="table-wrap"><table className="data"><thead><tr><th>RF</th><th>Название</th><th>Исполнитель</th><th>Статус</th></tr></thead><tbody>{data.data.features.map((f:any)=><tr key={f.id}><td>{f.key}</td><td><button className="btn ghost" onClick={()=>openFeature(f.key)}>{f.title}</button></td><td>{f.assignee_name||'—'}</td><td><StatusPill status={f.status} /></td></tr>)}</tbody></table></div></>}</>;
}



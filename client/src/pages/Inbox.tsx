import { useEffect, useState } from 'react';
import { api, fmtDateTime, invalidate, mutate, openFeature, toast, useApi, useApp, useQueryParam } from '../lib';
import { Empty, Field, Loading, Modal, Notice, PageHead } from '../ui';

const review:Record<string,string>={new:'Новая',needs_info:'Требует уточнения',accepted:'Принята',rejected:'Отклонена'};
const sync:Record<string,string>={pending:'Ожидает обработки',processing:'Обрабатывается',applied:'Обработано',retry_wait:'Ожидает повтора',manual_error:'Требует разбора',paused:'Приостановлено'};
const labels:Record<string,string>={title:'Название',description:'Описание',source_url:'Ссылка на задачу',external_status:'Внешний статус',source_created_at:'Дата создания в Bitrix',source_due_at:'Крайний срок Bitrix',source_task_type:'Тип в Bitrix',priority:'Приоритет Bitrix',related_tasks:'Связанные задачи',author_name:'Постановщик',assignee_name:'Исполнитель',initiator_name:'Инициатор',project:'Проект',task_kind:'Вид задачи',tags:'Теги'};
const value=(v:unknown)=>v===null||v===undefined?'—':typeof v==='string'?v:JSON.stringify(v,null,2);
Object.assign(labels,{initiator:'Инициатор',is_product_internal:'Внутренняя задача Product',visibility:'Видимость'});
const previewValue=(key:string,v:any)=>key==='task_kind'?({planned:'Плановая доработка',bug:'Баг',operational_improvement:'Операционное улучшение'}[v as string]??value(v)):key==='visibility'&&v==='draft'?'Черновик':key==='is_product_internal'?(v?'Да':'Нет'):key==='initiator'&&v?(v.name??v.department_id??'—'):Array.isArray(v)?v.join(', ')||'—':value(v)||'—';

export function Inbox() {
  const {me}=useApp();
  if(!me?.permissions.inbox)return <Empty title="Раздел недоступен" />;
  return <InboxContent />;
}

function InboxContent(){
  const [tab,setTab]=useQueryParam('tab'); const [q,setQ]=useQueryParam('q'); const [state,setState]=useQueryParam('state');
  const [id,setId]=useQueryParam('inbox'); const [from,setFrom]=useQueryParam('from');const [to,setTo]=useQueryParam('to');
  const [offset,setOffset]=useState(0); const [errors,setErrors]=useState(false);
  const [kind,setKind]=useQueryParam('kind'); const [sort,setSort]=useQueryParam('sort'); const [duplicates,setDuplicates]=useState(false);
  const list=useApi<any>(tab==='log'?null:`/inbox?${new URLSearchParams({q:q??'',review_state:state??'',from:from??'',to:to??'',offset:String(offset),errors:errors?'1':'0',kind:kind??'',sort:sort??'updated',duplicates:duplicates?'1':'0'})}`);
  useEffect(()=>setOffset(0),[q,state,from,to,errors,kind,sort,duplicates]);
  return <>
    <PageHead title="Входящие задачи" sub="Автоматическое создание RF, исходные события и диагностика интеграций">
      <button className="btn" onClick={()=>invalidate()}>Обновить</button>
    </PageHead>
    <div className="row" style={{marginBottom:16}}>
      <button className={`btn ${tab!=='log'?'primary':''}`} onClick={()=>setTab(null)}>Входящие</button>
      <button className={`btn ${tab==='log'?'primary':''}`} onClick={()=>setTab('log')}>Журнал синхронизации</button>
    </div>
    {tab==='log'?<SyncLog />:<>
      <div className="row" style={{flexWrap:'wrap',marginBottom:16}}>{Object.entries(review).map(([key,label])=><button className={`btn sm ${state===key?'primary':''}`} key={key} onClick={()=>setState(state===key?null:key)}>{label} · {list.data?.counts.find((c:any)=>c.review_state===key)?.n??0}</button>)}</div>
      <section className="panel">
        <div className="panel-body row" style={{flexWrap:'wrap'}}>
          <input className="input" style={{flex:'1 1 240px'}} aria-label="Поиск входящих" placeholder="Название или ID Bitrix" value={q??''} onChange={e=>setQ(e.target.value)} />
          <Field label="С"><input className="input" type="date" value={from??''} onChange={e=>setFrom(e.target.value)} /></Field>
          <Field label="По"><input className="input" type="date" value={to??''} onChange={e=>setTo(e.target.value)} /></Field>
          <select className="select" aria-label="Вид задачи" value={kind??''} onChange={e=>setKind(e.target.value)}><option value="">Все виды</option><option value="planned">Плановая</option><option value="bug">Баг</option><option value="operational_improvement">Операционная</option></select>
          <select className="select" aria-label="Сортировка" value={sort??'updated'} onChange={e=>setSort(e.target.value)}><option value="updated">По обновлению</option><option value="created">По поступлению</option><option value="title">По названию</option></select>
          <label className="check"><input type="checkbox" checked={duplicates} onChange={e=>setDuplicates(e.target.checked)} />Возможные дубли</label>
          <label className="check"><input type="checkbox" checked={errors} onChange={e=>setErrors(e.target.checked)} />С ошибками</label>
        </div>
        {list.error?<Notice kind="danger">{list.error.message}</Notice>:!list.data?<Loading />:!list.data.items.length?<Empty title="Входящих пока нет">Здесь появятся обращения после подключения почты. Настройки и состояние приёма — в журнале синхронизации.</Empty>:
          <div className="table-wrap"><table className="data"><thead><tr><th>Источник / ID</th><th>Название</th><th>Решение Product</th><th>Синхронизация</th><th>RF</th><th>Обновлена</th></tr></thead><tbody>{list.data.items.map((i:any)=><tr key={i.id}>
            <td><span className="small muted">{i.source_instance_id}</span><br />{i.external_task_id}</td>
            <td><button className="btn ghost sm" style={{textAlign:'left',whiteSpace:'normal'}} onClick={()=>setId(i.id)}>{i.title||'Без названия'}</button><div className="small muted">{i.external_status||'Внешний статус не передан'}</div>{i.duplicate_candidate&&<span className="pill">Возможный дубль</span>}</td>
            <td>{review[i.review_state]}</td><td>{i.errors?<span style={{color:'var(--danger)'}}>Ошибок: {i.errors}</span>:sync[i.sync_state]??'—'}</td>
            <td>{i.feature_number?<button className="btn ghost sm" onClick={()=>openFeature(`RF-${i.feature_number}`)}>RF-{i.feature_number}</button>:i.review_state==='accepted'?'RF удалена':'—'}</td><td className="small">{fmtDateTime(i.updated_at)}</td>
          </tr>)}</tbody></table></div>}
        <div className="panel-body row"><button className="btn sm" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Назад</button><span className="small muted">{list.data?.total??0} обращений</span><button className="btn sm" disabled={offset+50>=(list.data?.total??0)} onClick={()=>setOffset(offset+50)}>Далее</button></div>
      </section>
    </>}
    {id&&<InboxCard id={id} onClose={()=>setId(null)} />}
  </>;
}

function InboxCard({id,onClose}:{id:string;onClose:()=>void}){
  const query=useApi<any>(`/inbox/${id}`);
  return <Modal wide title="Входящее обращение" onClose={onClose}>{query.error?<Notice kind="danger">{query.error.message}</Notice>:!query.data?<Loading />:<CardEditor key={`${id}:${query.data.item.version}`} data={query.data} onClose={onClose} />}</Modal>;
}
function CardEditor({data,onClose}:{data:any;onClose:()=>void}){
  const i=data.item,s=i.snapshot,o=i.overrides;const {meta}=useApp();
  const initial={title:o.title??s.title??'',description:o.description??s.description??'',task_kind:o.task_kind??s.task_kind??'planned',author_name:o.author_name??(/^user_\d+$/.test(s.author_name??'')?'':s.author_name??''),assignee_name:o.assignee_name??s.assignee_name??'',tags:(o.tags??s.tags??[]).join(', '),initiator:o.initiator??(s.initiator_name?{type:'free_text',name:s.initiator_name}:null)};
  const [fields,setFields]=useState<any>(initial); const [reason,setReason]=useState('');const [target,setTarget]=useState('');
  const [plan,setPlan]=useState<any>(null);const [busy,setBusy]=useState(false); const [ack,setAck]=useState(false);
  const [operationKey,setOperationKey]=useState(''); const accepted=i.review_state==='accepted';
  const dirty=JSON.stringify(fields)!==JSON.stringify(initial);
  const set=(key:string,v:unknown)=>{setFields((f:any)=>({...f,[key]:v}));setPlan(null);};
  const save=async()=>{
    const changed:Record<string,unknown>={}; for(const key of Object.keys(initial))if(JSON.stringify(fields[key])!==JSON.stringify((initial as any)[key]))changed[key]=key==='tags'?fields.tags.split(',').map((t:string)=>t.trim()).filter(Boolean):fields[key];
    setBusy(true);await mutate(`/inbox/${i.id}`,'PATCH',{version:i.version,fields:changed},'Правки сохранены');setBusy(false);
  };
  const makePreview=async(mode:'create'|'link')=>{
    setBusy(true);try{const p=await api(`/inbox/${i.id}/preview`,{method:'POST',body:{version:i.version,mode,...(mode==='link'?{target_id:target}: {})}});setPlan(p);setAck(false);setOperationKey(crypto.randomUUID());}catch(e){toast((e as Error).message,'error');}finally{setBusy(false);}
  };
  const accept=async()=>{
    setBusy(true);try{const result=await api(`/inbox/${i.id}/accept`,{method:'POST',body:{version:plan.version,mode:plan.mode,...(plan.target?{target_id:plan.target.id}:{}),preview_hash:plan.preview_hash,operation_key:operationKey,confirm_incomplete:ack}});invalidate();toast(`Связано с ${result.key}`);onClose();openFeature(result.key);}catch(e){toast((e as Error).message,'error');}finally{setBusy(false);}
  };
  return <div className="stack">
    <div className="row" style={{flexWrap:'wrap'}}><b>{i.source} · {i.external_task_id}</b><span className="pill">{review[i.review_state]}</span>{s.source_url&&<a href={s.source_url} target="_blank" rel="noopener noreferrer">Открыть первоисточник ↗</a>}</div>
    {accepted&&<Notice>RF связана. Поля, которыми управляет источник, обновляются автоматически; ручные правки RF сохраняются.{i.feature_id?<button className="btn sm" onClick={()=>{onClose();openFeature(i.feature_id);}}>Открыть RF</button>:' Связанная RF удалена; автоматического повторного создания не будет.'}</Notice>}
    <details><summary>Исходные поля · без правок Product</summary><dl className="inbox-source">{Object.entries(s).map(([k,v])=><div key={k}><dt>{labels[k]??k}</dt><dd>{value(v)}</dd></div>)}</dl></details>
    {!accepted&&<>
      <h3>Данные для Roadmap</h3><p className="small muted">Сохранённые правки Product не заменяют оригинал. Дедлайн и приоритет Bitrix не переносятся в планирование.</p>
      <Field label={`Название${'title' in o?' · правка Product':' · из источника'}`}><input className="input" value={fields.title} maxLength={300} onChange={e=>set('title',e.target.value)} /></Field>
      <Field label={`Описание · ${fields.description.length.toLocaleString('ru')} / 20 000`}><textarea className="input" rows={9} value={fields.description} onChange={e=>set('description',e.target.value)} /></Field>
      {fields.description.length>20000&&<Notice kind="warn">Оригинал сохранён во входящей. Для RF подготовьте описание до 20 000 символов; текст не будет обрезан автоматически.</Notice>}
      <div className="inbox-grid">
        <Field label="Вид задачи"><select className="select" value={fields.task_kind} onChange={e=>set('task_kind',e.target.value)}><option value="planned">Плановая доработка</option><option value="bug">Баг</option><option value="operational_improvement">Операционное улучшение</option></select></Field>
        <Field label="Исполнитель"><input className="input" value={fields.assignee_name} maxLength={120} onChange={e=>set('assignee_name',e.target.value)} /></Field>
        <Field label="Постановщик"><input className="input" value={fields.author_name} maxLength={120} onChange={e=>set('author_name',e.target.value)} /></Field>
        <Field label="Теги через запятую"><input className="input" value={fields.tags} onChange={e=>set('tags',e.target.value)} /></Field>
        <Field label="Инициатор"><select className="select" value={fields.initiator?.type??'unknown'} onChange={e=>set('initiator',e.target.value==='unknown'?null:e.target.value==='free_text'?{type:'free_text',name:''}:{type:'department',department_id:meta.departments[0]?.id??''})}><option value="unknown">Неизвестен</option><option value="free_text">Имя / текст</option><option value="department">Подразделение</option></select></Field>
        {fields.initiator?.type==='free_text'&&<Field label="Имя инициатора"><input className="input" maxLength={120} value={fields.initiator.name} onChange={e=>set('initiator',{type:'free_text',name:e.target.value})} /></Field>}
        {fields.initiator?.type==='department'&&<Field label="Подразделение"><select className="select" value={fields.initiator.department_id} onChange={e=>set('initiator',{type:'department',department_id:e.target.value})}>{meta.departments.map((d:any)=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
      </div>
      <div className="row" style={{flexWrap:'wrap'}}><button className="btn primary" disabled={busy||!dirty||fields.description.length>20000} onClick={save}>Сохранить правки</button><button className="btn" disabled={busy||dirty} onClick={()=>mutate(`/inbox/${i.id}`,'PATCH',{version:i.version,review_state:'needs_info'},'Отмечено для уточнения')}>Требует уточнения</button></div>
      {!!Object.keys(o).length&&<details><summary>Происхождение правок Product</summary><div className="stack">{Object.keys(o).map(k=><div className="row" key={k}><span className="grow">{labels[k]??k} · задано Product</span><button className="btn sm" disabled={busy||dirty} onClick={()=>mutate(`/inbox/${i.id}`,'PATCH',{version:i.version,remove_overrides:[k]},'Возвращено исходное значение')}>Вернуть из источника</button></div>)}</div></details>}
      <h3>Проверка дублей</h3>
      {data.candidates.length?<div className="stack">{data.candidates.map((c:any)=><div className="row" key={c.id}><div className="grow"><b>{c.key}</b> {c.title}<div className="small muted">{c.reason}</div></div><button className="btn sm" onClick={()=>{setTarget(c.id);setPlan(null);}}>Выбрать</button></div>)}</div>:<p className="small muted">Совпадений по ссылке, ID и похожим названиям не найдено.</p>}
      <Field label="Привязать к существующей RF"><input className="input" value={target} placeholder="RF-123 или выбранная задача" onChange={e=>{setTarget(e.target.value);setPlan(null);}} /></Field>
      <div className="row" style={{flexWrap:'wrap'}}><button className="btn primary" disabled={busy||dirty||fields.description.length>20000} onClick={()=>makePreview('create')}>Предпросмотр новой RF</button><button className="btn" disabled={busy||dirty||!target} onClick={()=>makePreview('link')}>Предпросмотр привязки</button></div>
      {dirty&&<Notice kind="warn">Сохраните правки перед предпросмотром.</Notice>}
      {plan&&<section className="panel"><div className="panel-body stack"><h3>{plan.mode==='create'?'Создание черновика RF':'Привязка к '+plan.target.key}</h3>{plan.fields&&<dl className="inbox-source">{Object.entries(plan.fields).map(([k,v])=><div key={k}><dt>{labels[k]??k}</dt><dd>{previewValue(k,v)}</dd></div>)}</dl>}
        {plan.source_url&&<p>Будет добавлена ссылка на исходную задачу: <a href={plan.source_url} target="_blank" rel="noopener noreferrer">{plan.source_url}</a></p>}
        {!!plan.warnings.length&&<Notice kind="warn"><ul>{plan.warnings.map((w:string)=><li key={w}>{w}</li>)}</ul></Notice>}
        <label className="check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} />Проверил данные и предупреждения, подтверждаю {plan.mode==='create'?'создание':'привязку'}</label>
        <button className="btn primary" disabled={busy||!ack} onClick={accept}>Подтвердить</button></div></section>}
      <details><summary>Отклонить обращение</summary><div className="stack"><input className="input" placeholder="Обязательная причина" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)} /><button className="btn" disabled={busy||!reason.trim()||dirty} onClick={()=>mutate(`/inbox/${i.id}`,'PATCH',{version:i.version,review_state:'rejected',reason},'Обращение отклонено')}>Отклонить</button></div></details>
    </>}
    <h3>События источника</h3>{data.events.map((e:any)=><EventRow key={`${e.id}:${e.version}`} event={e} item={i} />)}
    <details><summary>История решений Product</summary>{data.history.map((h:any)=><p className="small" key={h.id}>{fmtDateTime(h.at)} · {h.actor_name??'Система'} · {h.action}</p>)}</details>
  </div>;
}

function EventRow({event:e,item}:{event:any;item?:any}){
  const [raw,setRaw]=useState<any>(null); const [choices,setChoices]=useState<Record<string,string>>({});
  return <div className="panel"><div className="panel-body stack">
    <div className="row" style={{flexWrap:'wrap'}}><b>{e.event_type??'Неразобранное письмо'}</b><span>{e.external_task_id??'ID не определён'}</span><span>{sync[e.state]}</span><span className="small muted">{fmtDateTime(e.received_at)} · попыток: {e.attempts}</span></div>
    {e.error_code&&<Notice kind="warn">{({invalid_event:'Не удалось разобрать сообщение: проверьте отправителя, портал, формат полей и ограничения размера.',field_conflict:'Изменения источника требуют ручного решения.',attempts_exhausted:'Попытки исчерпаны. Устраните причину и запустите повтор.',processing_retry:'Временная ошибка обработки. Запланирован повтор.'} as any)[e.error_code]??e.error_code}</Notice>}
    {item&&Object.entries(e.conflicts??{}).map(([k,c]:[string,any])=><Field key={k} label={labels[k]??k}><div className="inbox-grid"><pre className="inbox-text">Сейчас: {value(item.snapshot[k])}</pre><pre className="inbox-text">В письме: {value(c.incoming)}</pre></div><select className="select" value={choices[k]??''} onChange={ev=>setChoices({...choices,[k]:ev.target.value})}><option value="">Выберите решение</option><option value="current">Оставить текущее</option><option value="incoming">Применить из письма</option></select></Field>)}
    {item&&Object.keys(e.conflicts??{}).length>0&&<button className="btn" disabled={Object.keys(e.conflicts).some(k=>!choices[k])} onClick={()=>mutate(`/inbox-events/${e.id}/resolve`,'POST',{version:e.version,item_version:item.version,choices},'Конфликт разрешён')}>Сохранить решение</button>}
    <div className="row"><button className="btn sm" onClick={async()=>{try{setRaw(await api(`/inbox-events/${e.id}`));}catch(err){toast((err as Error).message,'error');}}}>Оригинал и результат разбора</button>{['manual_error','retry_wait','paused'].includes(e.state)&&<button className="btn sm" onClick={()=>mutate(`/inbox-events/${e.id}/retry`,'POST',{version:e.version},'Повтор поставлен в очередь')}>Повторить</button>}</div>
    {raw&&<Modal wide title="Исходное сообщение" onClose={()=>setRaw(null)}><pre className="inbox-text">{JSON.stringify(raw.event,null,2)}</pre></Modal>}
  </div></div>;
}

function SyncLog(){
  const {me}=useApp();const health=useApi<any>('/inbox-connections');const [state,setState]=useState('');const events=useApi<any>(`/inbox-events?state=${state}`);
  const [create,setCreate]=useState(false);
  return <div className="stack">
    {health.error?<Notice kind="danger">{health.error.message}</Notice>:health.data&&<>
      {!health.data.ingest_enabled&&<Notice kind="warn">Приём почты выключен. Карточки и журнал доступны; для подключения потребуется настройка серверного ключа.</Notice>}
      {!health.data.connections.length&&<Empty title="Почтовые подключения не настроены" />}
      {health.data.connections.map((c:any)=><section className="panel" key={c.id}><div className="panel-body stack"><div className="row"><h3 className="grow">{c.name}</h3><span>{c.enabled?'Включено':'Выключено'}</span>{me?.permissions.admin&&<button className="btn sm" onClick={()=>mutate(`/inbox-connections/${c.id}`,'PATCH',{version:c.version,enabled:!c.enabled})}>{c.enabled?'Приостановить':'Включить'}</button>}</div>
        <div className="inbox-grid"><span>Последний опрос почты: {fmtDateTime(c.last_poll_at)}</span><span>Приём сообщения: {fmtDateTime(c.last_ingest_at)}</span><span>Обработка: {fmtDateTime(c.last_processed_at)}</span></div>
        {c.heartbeat_stale&&<Notice kind="warn">Нет сигнала от почтового скрипта более 20 минут или первый опрос ещё не выполнен.</Notice>}
        {c.heartbeat&&<p className="small">Найдено: {c.heartbeat.found}; передано: {c.heartbeat.sent}; ошибок: {c.heartbeat.errors}</p>}
      </div></section>)}
      <div className="row" style={{flexWrap:'wrap'}}>{health.data.queue.map((q:any)=><span className="pill" key={q.state}>{sync[q.state]}: {q.n}</span>)}</div>
    </>}
    <div className="row" style={{flexWrap:'wrap'}}>{me?.permissions.admin&&<button className="btn" onClick={()=>setCreate(true)}>Добавить почтовое подключение</button>}<button className="btn" onClick={()=>mutate('/inbox-process','POST',{},'Очередь проверена')}>Обработать очередь</button>
      <select className="select" value={state} onChange={e=>setState(e.target.value)}><option value="">Все события</option>{Object.entries(sync).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></div>
    <p className="small muted">Последние 100 событий. Исходные сообщения сохраняются; автоматическая очистка отключена. Ошибки скрипта до передачи доступны также в Apps Script → Executions.</p>
    {events.error?<Notice kind="danger">{events.error.message}</Notice>:!events.data?<Loading />:events.data.events.map((e:any)=><EventRow key={`${e.id}:${e.version}`} event={e} />)}
    {create&&<ConnectionForm onClose={()=>setCreate(false)} />}
  </div>;
}
function ConnectionForm({onClose}:{onClose:()=>void}){
  const [name,setName]=useState('Bitrix · почта');const [id,setId]=useState('bitrix-mail');const [host,setHost]=useState('my.kokocgroup.ru');const [sender,setSender]=useState('robot@my.kokocgroup.ru');const [busy,setBusy]=useState(false);
  const [source,setSource]=useState('bitrix'),[adapter,setAdapter]=useState('bitrix_email'),[ordering,setOrdering]=useState('version');
  return <Modal title="Подключение источника" onClose={onClose} footer={<button className="btn primary" disabled={busy||!name||!id||!host||!source||(adapter==='bitrix_email'&&!sender)} onClick={async()=>{setBusy(true);const r=await mutate('/inbox-connections','POST',{id,name,source,source_instance_id:host,adapter,...(adapter==='bitrix_email'?{allowed_sender:sender,ordering:'none'}:{ordering}),enabled:false},'Подключение создано');setBusy(false);if(r)onClose();}}>Создать</button>}><div className="stack">
    <Field label="Источник (bitrix, jira или код другого источника)"><input className="input" value={source} onChange={e=>{setSource(e.target.value);if(e.target.value!=='bitrix')setAdapter('canonical_v1');}} /></Field>
    <Field label="Способ получения"><select className="select" value={adapter} onChange={e=>setAdapter(e.target.value)}>{source==='bitrix'&&<option value="bitrix_email">Письма Bitrix через Gmail</option>}<option value="canonical_v1">События интеграции</option></select></Field>
    {adapter==='canonical_v1'&&<Field label="Порядок событий источника"><select className="select" value={ordering} onChange={e=>setOrdering(e.target.value)}><option value="version">Версия изменения</option><option value="time">Время изменения</option><option value="none">Не определён — конфликты вручную</option></select></Field>}
    <Field label="Название"><input className="input" value={name} onChange={e=>setName(e.target.value)} /></Field><Field label="Идентификатор подключения"><input className="input" value={id} onChange={e=>setId(e.target.value)} /></Field>
    <Field label="Домен источника"><input className="input" value={host} onChange={e=>setHost(e.target.value)} /></Field>{adapter==='bitrix_email'&&<Field label="Отправитель писем"><input className="input" type="email" value={sender} onChange={e=>setSender(e.target.value)} /></Field>}
    <Notice>Подключение создаётся выключенным. Следующий шаг — установить почтовый скрипт и серверный ключ по инструкции подключения.</Notice>
  </div></Modal>;
}


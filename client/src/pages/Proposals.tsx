// «Предложения» (vNext ТЗ §1.2): business needs from any employee; product decides and links tasks.
import { useEffect, useState } from 'react';
import { FeaturePicker } from '../features';
import { I } from '../icons';
import { api, ApiError, fmtDate, fmtDateTime, invalidate, mutate, navigate, openFeature, toast, useApi, useApp, useDebounced, useQueryParam } from '../lib';
import { Cubes, Empty, ErrorBox, Field, Loading, Modal, Notice, PageHead, ReasonModal, RichText, StatusPill, useDirty } from '../ui';
import { PurgeButton } from './Purge';

const STATUS_COLOR: Record<string, string> = {
  new: '#6b7fd7', review: '#b07a1f', accepted: '#2f6fb0', postponed: '#9b8b6e', rejected: '#7d7d7d', planned: '#8a3b8f', implemented: '#3f8f4f',
};
const pill = (s: { code: string; name: string }) => <StatusPill status={{ name: s.name, color: STATUS_COLOR[s.code] }} />;

export function Proposals() {
  const { me, meta } = useApp();
  const [q, setQ] = useQueryParam('q');
  const [status, setStatus] = useQueryParam('status');
  const [dept, setDept] = useQueryParam('department');
  const [author, setAuthor] = useQueryParam('author');
  const [sort, setSort] = useQueryParam('sort');
  const [from, setFrom] = useQueryParam('from');
  const [to, setTo] = useQueryParam('to');
  const [text, setText] = useState(q ?? '');
  const dq = useDebounced(text, 250);
  useEffect(() => { if ((q ?? '') !== dq) setQ(dq || null); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams(Object.entries({ q, status, department: dept, author, sort, from, to }).filter(([, v]) => v) as [string, string][]);
  const { data, error, loading } = useApi<any>(me ? `/proposals?${qs}` : null);
  if (!me) return <Empty title="Предложения доступны после входа" />;
  return (
    <>
      <PageHead title="Предложения" sub="Бизнес-потребности и ожидаемый результат от любого отдела. Продуктовая команда рассматривает предложения, связывает их с задачами и показывает прогноз реализации.">
        <button className="btn primary" onClick={() => setCreating(true)}><I.plus />Новое предложение</button>
      </PageHead>
      <div className="toolbar">
        <div className="search" style={{ minWidth: 260 }}><I.search /><input className="input" placeholder="Поиск по номеру, названию, описанию, автору" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <select className="select" value={status ?? ''} onChange={(e) => setStatus(e.target.value || null)} aria-label="Статус">
          <option value="">Все статусы</option>
          {(data?.statuses ?? []).map((s: any) => <option key={s.code} value={s.code}>{s.name}{data?.counts?.[s.code] ? ` (${data.counts[s.code]})` : ''}</option>)}
        </select>
        <select className="select" value={dept ?? ''} onChange={(e) => setDept(e.target.value || null)} aria-label="Отдел-инициатор">
          <option value="">Любой отдел</option>
          {meta.departments.filter((d: any) => d.is_active).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value="none">Без отдела</option>
        </select>
        <select className="select" value={author ?? ''} onChange={(e) => setAuthor(e.target.value || null)} aria-label="Автор">
          <option value="">Все авторы</option>
          <option value="me">Мои предложения</option>
        </select>
        <input className="input" type="date" value={from ?? ''} onChange={(e) => setFrom(e.target.value || null)} aria-label="Создано с" style={{ width: 'auto' }} />
        <input className="input" type="date" value={to ?? ''} onChange={(e) => setTo(e.target.value || null)} aria-label="Создано по" style={{ width: 'auto' }} />
        <select className="select" value={sort ?? 'popular'} onChange={(e) => setSort(e.target.value === 'popular' ? null : e.target.value)} aria-label="Сортировка">
          <option value="popular">По популярности</option>
          <option value="newest">Сначала новые</option>
          <option value="updated">Недавно изменённые</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        {loading && !data ? <Loading rows={6} /> : !data?.proposals.length ? (
          <Empty title="Предложений пока нет">Опишите, что нужно бизнесу и какой результат вы ждёте — продуктовая команда рассмотрит.</Empty>
        ) : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>#</th><th>Предложение</th><th>Статус</th><th>Отдел</th><th>Важность</th><th>Реализация</th><th>Создано</th></tr></thead>
            <tbody>
              {data.proposals.map((p: any) => (
                <tr key={p.id} className="click" onClick={() => navigate(`/proposals/${p.key}`)}>
                  <td><span className="key">{p.key}</span></td>
                  <td style={{ minWidth: 260 }}>
                    <b>{p.title}</b>
                    <div className="small muted ellipsis" style={{ maxWidth: 520 }}>{p.excerpt}</div>
                    <div className="small muted">{p.author.name}{p.comment_count ? ` · комментариев ${p.comment_count}` : ''}</div>
                  </td>
                  <td>{pill(p.status)}</td>
                  <td className="small">{p.department?.name ?? <span className="muted">—</span>}</td>
                  <td><Cubes score={p.priority.score} /><div className="small muted">{p.priority.voters ? `оценили ${p.priority.voters}` : 'нет оценок'}</div></td>
                  <td className="small">
                    {p.delivery.total ? <>{p.delivery.done} из {p.delivery.total} задач</> : <span className="muted">задач нет</span>}
                    {p.delivery.forecast.production_date && <div className="muted">прогноз {fmtDate(p.delivery.forecast.production_date)}</div>}
                  </td>
                  <td className="small">{fmtDate(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {creating && <ProposalForm onClose={() => setCreating(false)} />}
    </>
  );
}

function ProposalForm({ proposal, onClose }: { proposal?: any; onClose: () => void }) {
  const { me, meta } = useApp();
  const [v, setV] = useState({
    title: proposal?.title ?? '', description: proposal?.description ?? '', expected_result: proposal?.expected_result ?? '',
    department_id: proposal ? proposal.department?.id ?? '' : me?.department_ids?.[0] ?? '',
  });
  const dirty = useDirty(v);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: any) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: v.title.trim(), description: v.description, expected_result: v.expected_result.trim() || null, department_id: v.department_id || null };
      if (proposal) {
        await api(`/proposals/${proposal.key}`, { method: 'PATCH', body: { ...body, version: proposal.version } });
        toast('Предложение сохранено');
        invalidate();
        onClose();
      } else {
        const r = await api<any>('/proposals', { method: 'POST', body });
        toast(`Предложение ${r.key} создано`);
        invalidate();
        onClose();
        navigate(`/proposals/${r.key}`);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={proposal ? `Изменить ${proposal.key}` : 'Новое предложение'} onClose={onClose} dirty={dirty} wide
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={busy || !v.title.trim()} onClick={save}>{proposal ? 'Сохранить' : 'Отправить'}</button></>}>
      <div className="form-grid">
        <Field label="Название" span2 hint="Коротко, что нужно бизнесу — не техническое решение"><input className="input" autoFocus value={v.title} onChange={set('title')} maxLength={300} placeholder="Например: видеть возвраты по партнёрам без ручной сверки" /></Field>
        <Field label="Потребность" span2 hint="Что сейчас мешает, кого это касается, как часто"><textarea className="textarea" rows={5} value={v.description} onChange={set('description')} /></Field>
        <Field label="Ожидаемый результат" span2 hint="Что изменится для бизнеса, если сделать"><textarea className="textarea" rows={3} value={v.expected_result} onChange={set('expected_result')} /></Field>
        <Field label="Отдел-инициатор">
          <select className="select" value={v.department_id} onChange={set('department_id')}>
            <option value="">Не указан</option>
            {meta.departments.filter((d: any) => d.is_active).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

const ACTION: Record<string, string> = {
  created: 'создал(а) предложение', updated: 'изменил(а)', status: 'изменил(а) статус', status_auto: 'статус изменён автоматически',
  vote: 'оценил(а) важность', vote_admin_override: 'изменил(а) оценку отдела (админ)', comment_added: 'оставил(а) комментарий',
  task_linked: 'связал(а) с задачей', task_unlinked: 'убрал(а) связь с задачей', merged_into: 'объединил(а) с основным', merged_from: 'присоединил(а) дубль',
};
const FIELD: Record<string, string> = { title: 'название', description: 'потребность', expected_result: 'ожидаемый результат', department_id: 'отдел' };

export function ProposalDetail({ id }: { id: string }) {
  const { me } = useApp();
  const { data, error } = useApi<any>(me ? `/proposals/${id}` : null);
  const [editing, setEditing] = useState(false);
  const [deciding, setDeciding] = useState<any | null>(null);
  const [merging, setMerging] = useState(false);
  const [comment, setComment] = useState('');
  const [pickerKey, setPickerKey] = useState(0); // remount = empty search after a task is linked
  if (!me) return <Empty title="Предложения доступны после входа" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="panel"><Loading rows={8} /></div>;
  const p = data.proposal;
  const setStatus = async (to: any, reason?: string) => {
    try {
      await api(`/proposals/${p.key}/status`, { method: 'POST', body: { status: to.code, version: p.version, ...(reason ? { reason } : {}) } });
      toast(`Статус: ${to.name}`);
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <PageHead title={`${p.key}. ${p.title}`} sub={<>Автор {p.author.name}{p.department ? `, ${p.department.name}` : ''} · {fmtDateTime(p.created_at)}</>}>
        <button className="btn ghost" onClick={() => navigate('/proposals')}>Все предложения</button>
        {p.permissions.edit && <button className="btn" onClick={() => setEditing(true)}>Изменить</button>}
        {p.permissions.merge && <button className="btn ghost" onClick={() => setMerging(true)}>Объединить с…</button>}
        <PurgeButton kind="proposal" refKey={p.key} onDone={() => navigate('/proposals')} />
      </PageHead>
      {p.merged_into_ref && (
        <Notice kind="info">Предложение объединено с <a href={`/proposals/${p.merged_into_ref.key}`} onClick={(e) => { e.preventDefault(); navigate(`/proposals/${p.merged_into_ref.key}`); }}>{p.merged_into_ref.key} «{p.merged_into_ref.title}»</a>. Голоса, задачи и комментарии перенесены туда; эта страница сохранена для истории.</Notice>
      )}
      <div className="grid-2">
        <div className="stack loose">
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Потребность</h2>{pill(p.status)}</div>
            <div className="panel-body stack">
              <RichText text={p.description} />
              {p.expected_result && <div><div className="small muted">Ожидаемый результат</div><p className="pre" style={{ margin: 0 }}>{p.expected_result}</p></div>}
              {p.decision_reason && ['postponed', 'rejected', 'accepted'].includes(p.status.code) && (
                <Notice kind={p.status.code === 'rejected' ? 'warn' : 'info'}><b>Решение продуктовой команды{p.decided_at ? ` (${fmtDate(p.decided_at)})` : ''}:</b> {p.decision_reason}</Notice>
              )}
              {p.transitions.length > 0 && (
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="small muted">Перевести:</span>
                  {p.transitions.map((t: any) => (
                    <button key={t.code} className="btn sm" onClick={() => (t.reason_required || t.code === 'accepted' ? setDeciding(t) : setStatus(t))}>{t.name}</button>
                  ))}
                </div>
              )}
              {p.permissions.decide && p.delivery.all_done && p.status.code !== 'implemented' && (
                <Notice kind="ok">Все связанные задачи завершены. Подтвердите «Реализовано», если результат достигнут — статус не ставится автоматически.</Notice>
              )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Реализация</h2>
              <span className="small muted">{p.delivery.total ? `${p.delivery.done} из ${p.delivery.total} задач завершено` : 'задачи не связаны'}</span>
            </div>
            <div className="panel-body stack">
              {(p.delivery.forecast.production_date || p.delivery.forecast.releases.length > 0) && (
                <div className="small">Прогноз: {p.delivery.forecast.releases.map((r: any) => r.name).join(', ')}{p.delivery.forecast.production_date ? `${p.delivery.forecast.releases.length ? ', ' : ''}выкладка до ${fmtDate(p.delivery.forecast.production_date)}` : ''}</div>
              )}
              {p.implemented_at && <div className="small">Реализовано {fmtDate(p.implemented_at)}</div>}
              {p.tasks.map((t: any) => (
                <div key={t.id} className="row" style={{ gap: 8 }}>
                  <a className="grow" href={`/backlog?f=${t.key}`} onClick={(e) => { e.preventDefault(); openFeature(t.key); }}>
                    <span className="key">{t.key}</span> {t.title}
                  </a>
                  {t.is_product_internal && <span className="pill outline">внутренняя</span>}
                  {t.sprint && <span className="small muted">спринт {t.sprint.code}</span>}
                  <StatusPill status={t.status} />
                  {p.permissions.link && <button className="btn ghost sm" aria-label="Убрать связь" onClick={() => mutate(`/proposals/${p.key}/features/${t.id}`, 'DELETE', undefined, 'Связь убрана')}><I.x /></button>}
                </div>
              ))}
              {p.permissions.link && <FeaturePicker key={pickerKey} autoFocus={false} placeholder="Связать с задачей: номер или название" exclude={p.tasks.map((t: any) => t.id)} onPick={async (f) => { await mutate(`/proposals/${p.key}/features`, 'POST', { feature_id: f.id }, `Связано с ${f.key}`); setPickerKey((k) => k + 1); }} />}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Обсуждение</h2></div>
            <div className="panel-body stack">
              {!p.comments.length && <p className="small muted" style={{ margin: 0 }}>Комментариев пока нет.</p>}
              {p.comments.map((c: any) => (
                <div key={c.id} className="comment">
                  <div className="row small"><b>{c.author_name}</b><span className="muted">{fmtDateTime(c.created_at)}</span>{c.moved_from && <span className="muted">из {c.moved_from}</span>}</div>
                  <p className="pre" style={{ marginTop: 4 }}>{c.body}</p>
                </div>
              ))}
              <textarea className="textarea" rows={2} placeholder="Добавить комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div><button className="btn sm" disabled={!comment.trim()} onClick={async () => { const r = await mutate(`/proposals/${p.key}/comments`, 'POST', { body: comment.trim() }, 'Комментарий добавлен'); if (r) setComment(''); }}>Отправить</button></div>
            </div>
          </section>
        </div>
        <div className="stack loose">
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Важность для отделов</h2><Cubes score={p.priority.score} /></div>
            <div className="panel-body stack tight">
              <p className="small muted" style={{ margin: 0 }}>Каждый отдел ставит одну оценку от 1 до 5. Оценки предложений не меняют приоритеты задач.</p>
              {p.votes.map((v: any) => <VoteRow key={v.department_id} p={p} v={v} />)}
            </div>
          </section>
          {p.merged_from.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2 className="grow">Объединённые дубли</h2></div>
              <div className="panel-body stack tight">
                {p.merged_from.map((m: any) => (
                  <a key={m.id} href={`/proposals/${m.key}`} onClick={(e) => { e.preventDefault(); navigate(`/proposals/${m.key}`); }} className="small">
                    <span className="key">{m.key}</span> {m.title} <span className="muted">— {m.author_name}, {fmtDate(m.created_at)}</span>
                  </a>
                ))}
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-head"><h2 className="grow">История</h2></div>
            <div className="panel-body stack tight">
              {p.history.map((h: any) => (
                <div key={h.id} className="small">
                  <span className="muted">{fmtDateTime(h.at)}</span> <b>{h.actor ?? 'система'}</b> {ACTION[h.action] ?? h.action}
                  {h.action !== 'created' && h.action !== 'comment_added' && (h.changes ?? []).map((c: any, i: number) => (
                    <span key={i}>
                      {c.field === 'status' ? <> {label(c.old)} → <b>{label(c.new)}</b></> : c.field === 'task' ? <> {c.new ?? c.old}</> : c.field?.startsWith('vote:') ? <> {c.field.slice(5)}: {c.old ?? '—'} → {c.new ?? '—'}</> : FIELD[c.field] ? <> {FIELD[c.field]}</> : null}
                    </span>
                  ))}
                  {h.reason && <span className="muted"> — {h.reason}</span>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      {editing && <ProposalForm proposal={p} onClose={() => setEditing(false)} />}
      {deciding && (
        deciding.reason_required ? (
          <ReasonModal title={`${p.key}: ${deciding.name}`} confirmText={deciding.name} onClose={() => setDeciding(null)} onConfirm={async (reason) => { await setStatus(deciding, reason); setDeciding(null); }}>
            <p>Причину увидят автор и все сотрудники. Позже предложение можно вернуть на рассмотрение.</p>
          </ReasonModal>
        ) : (
          <ReasonModal title={`${p.key}: принять в работу`} confirmText="Принять" onClose={() => setDeciding(null)} onConfirm={async (reason) => { await setStatus(deciding, reason || undefined); setDeciding(null); }}>
            <p>Комментарий для автора (необязательно). Когда связанная задача попадёт в спринт, статус станет «Запланировано» автоматически.</p>
          </ReasonModal>
        )
      )}
      {merging && <MergeDialog p={p} onClose={() => setMerging(false)} />}
    </>
  );
}

const STATUS_NAME: Record<string, string> = { new: 'Новое', review: 'На рассмотрении', accepted: 'Принято в работу', postponed: 'Отложено', rejected: 'Отклонено', planned: 'Запланировано', implemented: 'Реализовано' };
const label = (s: string | null) => (s ? STATUS_NAME[s] ?? s : '—');

function VoteRow({ p, v }: { p: any; v: any }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<number | null | undefined>(undefined); // admin override waiting for a reason
  const can = (v.can_vote || p.permissions.override_vote) && !p.merged_into_ref;
  const vote = async (score: number | null, reason?: string) => {
    if (!v.can_vote && !reason) {
      setPending(score);
      return;
    }
    setBusy(true);
    try {
      await api(`/proposals/${p.key}/votes/${v.department_id}`, { method: 'PUT', body: { score, expected_version: v.version, ...(reason ? { reason } : {}) } });
      invalidate();
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'version_conflict' ? 'Оценку уже изменили — данные обновлены' : (e as Error).message, 'error');
      invalidate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <span className="grow small">{v.department}<span className="muted"> · вес {v.weight}</span>{v.voted_by && <span className="muted"> · {v.voted_by}</span>}</span>
      {can ? (
        <div className="choice" role="group" aria-label={`Оценка отдела ${v.department}`}>
          {[1, 2, 3, 4, 5].map((n) => <button key={n} disabled={busy} className={v.score === n ? 'on' : ''} onClick={() => vote(v.score === n ? null : n)}>{n}</button>)}
        </div>
      ) : <b className="num">{v.score ?? '—'}</b>}
      {pending !== undefined && (
        <ReasonModal title={`Оценка за отдел «${v.department}»`} confirmText="Сохранить оценку" onClose={() => setPending(undefined)}
          onConfirm={async (reason) => { await vote(pending, reason); setPending(undefined); }}>
          <p>Вы не состоите в этом отделе. Изменение его оценки — административное действие, оно попадёт в журнал с причиной.</p>
        </ReasonModal>
      )}
    </div>
  );
}

function MergeDialog({ p, onClose }: { p: any; onClose: () => void }) {
  const [target, setTarget] = useState('');
  const t = useApi<any>(/^p-?\d+$/i.test(target.trim()) ? `/proposals/${target.trim()}` : null);
  const tp = t.data?.proposal;
  const ok = tp && tp.id !== p.id && !tp.merged_into_ref;
  return (
    <Modal title={`Объединить ${p.key} с основным предложением`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!ok} onClick={async () => {
        const r = await mutate(`/proposals/${p.key}/merge`, 'POST', { target_id: tp.id, source_version: p.version, target_version: tp.version, confirm: true }, `Объединено с ${tp.key}`);
        if (r) { onClose(); navigate(`/proposals/${tp.key}`); }
      }}>Объединить</button></>}>
      <div className="stack">
        <p className="small">{p.key} станет дублем: голоса отделов (если у основного их нет), связанные задачи и комментарии перейдут в основное. Автор и история {p.key} сохранятся.</p>
        <Field label="Основное предложение"><input className="input" autoFocus value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Например, P-12" /></Field>
        {tp && <div className="small">{tp.key}: <b>{tp.title}</b> — {tp.author.name}{tp.merged_into_ref ? ' (само объединено — выберите основное)' : ''}</div>}
      </div>
    </Modal>
  );
}

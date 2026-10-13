// Shared feature widgets: form, vote picker, placement control, feature picker.
import { useMemo, useState } from 'react';
import { I } from './icons';
import { api, ApiError, invalidate, mutate, openFeature, toast, useApi, useApp, useClickOutside, useDebounced, useDict } from './lib';
import { Cubes, Field, Modal, ReasonModal, ScoreCell, StatusPill, useDirty, VisBadge } from './ui';

export const KIND_LABEL: Record<string, string> = { planned: 'Плановая', bug: 'Баг', operational_improvement: 'Оперативная доработка' };
export const URGENCY_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая', critical: 'критическая' };
/** bugs use the ordinary status; this is how its semantic reads for a bug */
export const BUG_STATE: Record<string, string> = { new: 'не решено', analysis: 'не решено', ready: 'не решено', planned: 'не решено', in_progress: 'в работе', blocked: 'в работе (блок)', postponed: 'отложено', done: 'решено', cancelled: 'отменено' };

/** work type + hidden Product task markers (nothing for an ordinary planned task) */
export function KindBadges({ f }: { f: any }) {
  return (
    <>
      {f.task_kind && f.task_kind !== 'planned' && <span className={`pill ${f.task_kind === 'bug' ? 'danger' : 'warn'}`} style={{ marginRight: 6, fontSize: 11 }}>{KIND_LABEL[f.task_kind]}</span>}
      {f.task_kind && f.task_kind !== 'planned' && f.urgency && ['high', 'critical'].includes(f.urgency) && <span className="pill danger" style={{ marginRight: 6, fontSize: 11 }} title="Срочность">{URGENCY_LABEL[f.urgency]}</span>}
      {f.is_product_internal && <span className="pill outline" style={{ marginRight: 6, fontSize: 11 }} title="Видна только продуктовой команде и администраторам">Внутренняя продукта</span>}
    </>
  );
}

export function FeatureTitle({ f, sub = true }: { f: any; sub?: boolean }) {
  return (
    <div className="title-cell">
      <div className="t"><KindBadges f={f} />{f.title}</div>
      {sub && (
        <div className="sub ellipsis">
          {[f.epic && !f.epic.hidden ? f.epic.title : f.category?.name, f.assignee_name].filter(Boolean).join(', ')}
          {(f.tags ?? []).slice(0, 3).map((t: string) => (
            <span key={t} className="tag" style={{ marginLeft: 6, fontSize: 11, padding: '0 5px' }}>{t}</span>
          ))}
          {f.open_blockers > 0 && (
            <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
              <I.chain style={{ width: 13, height: 13, verticalAlign: '-2px' }} /> блокировок: {f.open_blockers}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function FeatureCard({ f, draggable, onDragStart, onDragEnd, warn, extra }: { f: any; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void; warn?: string | null; extra?: React.ReactNode }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`card ${dragging ? 'dragging' : ''} ${warn ? 'warn' : ''} ${f.placement_locked ? 'locked' : ''}`}
      draggable={draggable}
      onDragStart={(e) => { setDragging(true); e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'move'; onDragStart?.(e); }}
      onDragEnd={() => { setDragging(false); onDragEnd?.(); }}
      onClick={() => openFeature(f.key)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && openFeature(f.key)}
      title={warn ?? undefined}
    >
      <div className="row">
        <span className="key">{f.key}</span>
        <span className="grow" />
        <Cubes score={f.priority?.score} />
      </div>
      <div className="t">{f.title}</div>
      <div className="meta">
        <StatusPill status={f.status} />
        {f.estimate_total != null && <span className="num">{f.estimate_total} ч</span>}
        {f.placement_locked && <span title="Размещение утверждено"><I.lock style={{ width: 13, height: 13, verticalAlign: '-2px' }} /></span>}
        {f.release && <span className="ellipsis" style={{ maxWidth: 140 }}>{f.release.version_label ?? f.release.name}</span>}
        <VisBadge v={f.visibility !== 'public' ? f.visibility : undefined} />
      </div>
      {warn && <div className="small" style={{ color: 'var(--danger)' }}>{warn}</div>}
      {extra}
    </div>
  );
}

// ───────────────── vote picker ─────────────────
export function VoteControl({ feature, dept, vote }: { feature: any; dept: any; vote: any | undefined }) {
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState<number | null | undefined>(undefined);
  const ref = useClickOutside(() => setOpen(false));
  const own = !!me && me.department_ids.includes(dept.id);
  const canOverride = !!me && me.role === 'admin' && !me.must_change_password;
  const editable = (own || canOverride) && !me?.must_change_password;
  const save = async (score: number | null, reason?: string) => {
    setOpen(false);
    await mutate(`/features/${feature.id}/votes/${dept.id}`, 'PUT', { score, expected_version: vote?.version ?? null, reason }, score === null ? `Оценка ${dept.name} снята` : `${dept.name}: ${score}`);
  };
  const choose = (score: number | null) => (own ? save(score) : setOverride(score));
  return (
    <span style={{ position: 'relative', display: 'inline-block' }} ref={ref}>
      <ScoreCell
        score={vote?.score}
        onClick={editable ? () => setOpen((o) => !o) : undefined}
        title={editable ? `${dept.name}: ${vote?.score ? `оценка ${vote.score}` : 'нет оценки'}${own ? '' : ' (админ-изменение)'}` : `${dept.name}: ${vote?.score ?? 'не голосовал'}`}
      />
      {open && (
        <div className="popover" style={{ top: 32, left: '50%', translate: '-50% 0' }}>
          <div className="score-picker" role="group" aria-label={`Оценка отдела ${dept.name}`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={`score-cell v${n}`} onClick={() => choose(n)} aria-pressed={vote?.score === n}>{n}</button>
            ))}
            {vote && <button className="clear" onClick={() => choose(null)}>Снять</button>}
          </div>
        </div>
      )}
      {override !== undefined && (
        <ReasonModal
          title={`Изменить оценку за отдел «${dept.name}»`}
          confirmText="Изменить оценку"
          onClose={() => setOverride(undefined)}
          onConfirm={async (reason) => { await save(override, reason); setOverride(undefined); }}
        >
          <p>Вы не состоите в этом отделе. Изменение будет записано в журнал как административное действие.</p>
        </ReasonModal>
      )}
    </span>
  );
}

// ───────────────── placement (planning period) ─────────────────
export function usePlacement() {
  const [pending, setPending] = useState<{ feature: any; periodId: string | null; overload: any[] } | null>(null);
  const move = async (feature: any, periodId: string | null, extra: Record<string, unknown> = {}) => {
    try {
      await api(`/features/${feature.id}/placement`, { method: 'PATCH', body: { period_id: periodId, version: feature.version, ...extra } });
      invalidate();
      toast(periodId ? `${feature.key} перенесена` : `${feature.key} снята с плана`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'overload') setPending({ feature, periodId, overload: e.details?.overload ?? [] });
      else {
        toast((e as Error).message, 'error');
        invalidate();
      }
    }
  };
  const modal = pending && (
    <ReasonModal
      title="Превышение доступных часов"
      confirmText="Перенести с превышением"
      onClose={() => setPending(null)}
      onConfirm={async (reason) => {
        const p = pending;
        setPending(null);
        await move(p.feature, p.periodId, { confirm_overload: true, reason });
      }}
    >
      <p>После переноса {pending.feature.key} не хватит часов:</p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {pending.overload.map((o) => (
          <li key={o.teamId}><b>{o.team_name}</b>: будет {o.plannedAfter} ч при ёмкости {o.capacity} ч (дефицит {o.over} ч)</li>
        ))}
      </ul>
    </ReasonModal>
  );
  return { move, modal };
}

// ───────────────── feature form (create / edit) ─────────────────
export function FeatureForm({ feature, onClose, defaults }: { feature?: any; onClose: () => void; defaults?: Record<string, any> }) {
  const { meta } = useApp();
  const d = useDict();
  const epics = useApi<any>('/epics');
  const offers = useApi<any>('/offers');
  const [v, setV] = useState<Record<string, any>>(() => ({
    title: feature?.title ?? '',
    description: feature?.description ?? '',
    category_id: feature?.category?.id ?? '',
    epic_id: feature?.epic?.id ?? '',
    status_id: feature?.status?.id ?? d.statuses('feature')[0]?.id ?? '',
    stage_id: feature?.stage?.id ?? '',
    visibility: feature?.visibility ?? 'internal',
    author_name: feature?.author_name ?? '',
    assignee_name: feature?.assignee_name ?? '',
    requested_at: feature?.requested_at ?? '',
    planned_start: feature?.planned_start ?? '',
    planned_end: feature?.planned_end ?? '',
    external_ref: feature?.external_ref ?? '',
    tags: (feature?.tags ?? []).join(', '),
    offer_ids: (feature?.offers ?? []).map((o: any) => o.id),
    private_notes: feature?.private_notes ?? '',
    task_kind: feature?.task_kind ?? 'planned',
    is_product_internal: !!feature?.is_product_internal,
    is_focus: !!feature?.is_focus,
    urgency: feature?.urgency ?? '',
    fact_hours: feature?.fact_hours ?? '',
    initiator_type: feature?.initiator?.type ?? '',
    initiator_name: feature?.initiator?.type === 'free_text' ? feature.initiator.name : '',
    initiator_user_id: feature?.initiator?.user_id ?? '',
    initiator_department_id: feature?.initiator?.department_id ?? '',
    ...defaults,
  }));
  const directory = useApi<any>('/users/directory');
  const dirty = useDirty(v);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setV((s) => ({ ...s, [k]: e.target.value }));
  const nul = (x: string) => (x === '' ? null : x);
  const submit = async () => {
    setBusy(true);
    const body: Record<string, any> = {
      title: v.title.trim(), description: v.description, category_id: nul(v.category_id), epic_id: nul(v.epic_id), status_id: v.status_id,
      stage_id: nul(v.stage_id), visibility: v.visibility, author_name: nul(v.author_name.trim()), assignee_name: nul(v.assignee_name.trim()),
      requested_at: nul(v.requested_at), planned_start: nul(v.planned_start), planned_end: nul(v.planned_end), external_ref: nul(v.external_ref.trim()),
      tags: v.tags.split(',').map((t: string) => t.trim()).filter(Boolean), offer_ids: v.offer_ids, private_notes: nul(v.private_notes),
      task_kind: v.task_kind, is_product_internal: v.is_product_internal,
      is_focus: v.task_kind === 'planned' && !v.is_product_internal ? v.is_focus : false,
      ...(v.task_kind !== 'planned' || feature?.urgency || feature?.fact_hours != null
        ? { urgency: v.urgency || null, fact_hours: v.fact_hours === '' ? null : Number(String(v.fact_hours).replace(',', '.')) }
        : {}),
      initiator: v.initiator_type === 'free_text' ? { type: 'free_text', name: v.initiator_name.trim() }
        : v.initiator_type === 'user' ? { type: 'user', user_id: v.initiator_user_id }
        : v.initiator_type === 'department' ? { type: 'department', department_id: v.initiator_department_id }
        : null,
    };
    let r: any = null;
    if (feature) {
      try {
        r = await api(`/features/${feature.id}`, { method: 'PATCH', body: { ...body, version: feature.version } });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'confirm_disclose') {
          // the hidden Product task becomes visible to other departments: explicit confirmation
          r = window.confirm(`${e.message}\n\nСделать задачу общей?`)
            ? await mutate(`/features/${feature.id}`, 'PATCH', { ...body, version: feature.version, confirm_disclose: true }, 'Задача стала общей')
            : null;
        } else {
          toast(e instanceof Error ? e.message : 'Ошибка', 'error');
          if (e instanceof ApiError && e.code === 'version_conflict') invalidate();
        }
      }
      if (r && !r.unchanged) { invalidate(); toast('Изменения сохранены'); }
    } else {
      r = await mutate<any>('/features', 'POST', body, 'Задача создана');
    }
    setBusy(false);
    if (r) {
      onClose();
      if (!feature && r.key) openFeature(r.key);
    }
  };
  return (
    <Modal
      wide
      dirty={dirty}
      title={feature ? `Редактирование ${feature.key}` : 'Новая задача'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={!v.title.trim() || busy || (v.initiator_type === 'free_text' && !v.initiator_name.trim()) || (v.initiator_type === 'user' && !v.initiator_user_id) || (v.initiator_type === 'department' && !v.initiator_department_id)} onClick={submit}>{feature ? 'Сохранить' : 'Создать задачу'}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Название" span2><input className="input" value={v.title} onChange={set('title')} maxLength={300} autoFocus /></Field>
        <Field label="Описание" span2><textarea className="textarea" rows={5} value={v.description} onChange={set('description')} /></Field>
        <Field label="Тип работы" hint={v.task_kind === 'planned' ? 'Участвует в планировании и релизах' : 'Не планируется по часам и не входит в релизы'}>
          <select className="select" value={v.task_kind} onChange={set('task_kind')}>
            <option value="planned">Плановая задача</option>
            <option value="bug">Баг</option>
            <option value="operational_improvement">Оперативная доработка</option>
          </select>
        </Field>
        <Field label="Скрытость" hint="Видна только продуктовой команде и администраторам; не попадает в общие списки, релизы и план">
          <label className="check" style={{ minHeight: 36 }}>
            <input type="checkbox" checked={v.is_product_internal} onChange={(e) => setV((s) => ({ ...s, is_product_internal: e.target.checked }))} />
            Внутренняя задача продукта
          </label>
          {v.task_kind === 'planned' && !v.is_product_internal && (
            <label className="check" title="Обязательство релиза перед бизнесом — показывается в целях спринта независимо от статуса">
              <input type="checkbox" checked={v.is_focus} onChange={(e) => setV((s) => ({ ...s, is_focus: e.target.checked }))} />
              Фокусная задача релиза
            </label>
          )}
        </Field>
        <Field label="Инициатор" hint="Кто попросил задачу — не автор карточки и не исполнитель">
          <select className="select" value={v.initiator_type} onChange={set('initiator_type')}>
            <option value="">Не указан</option>
            <option value="free_text">Человек без учётной записи (ФИО)</option>
            <option value="user">Пользователь Roadmap</option>
            <option value="department">Отдел</option>
          </select>
        </Field>
        <Field label={v.initiator_type === 'user' ? 'Пользователь' : v.initiator_type === 'department' ? 'Отдел' : 'Фамилия Имя'}>
          {v.initiator_type === 'user' ? (
            <select className="select" value={v.initiator_user_id} onChange={set('initiator_user_id')}>
              <option value="">Выберите пользователя</option>
              {feature?.initiator?.type === 'user' && !(directory.data?.users ?? []).some((u: any) => u.id === v.initiator_user_id) && v.initiator_user_id && <option value={v.initiator_user_id}>{feature.initiator.name}</option>}
              {(directory.data?.users ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          ) : v.initiator_type === 'department' ? (
            <select className="select" value={v.initiator_department_id} onChange={set('initiator_department_id')}>
              <option value="">Выберите отдел</option>
              {meta.departments.filter((x) => x.is_active || x.id === v.initiator_department_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          ) : (
            <input className="input" value={v.initiator_name} onChange={set('initiator_name')} disabled={v.initiator_type !== 'free_text'} placeholder={v.initiator_type === 'free_text' ? 'Иванов Иван' : '—'} maxLength={120} />
          )}
        </Field>
        <Field label="Эпик">
          <select className="select" value={v.epic_id} onChange={set('epic_id')}>
            <option value="">Без эпика</option>
            {(epics.data?.epics ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.key} {e.title}</option>)}
          </select>
        </Field>
        <Field label="Категория">
          <select className="select" value={v.category_id} onChange={set('category_id')}>
            <option value="">Без категории</option>
            {meta.categories.filter((c) => c.is_active || c.id === v.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Статус">
          <select className="select" value={v.status_id} onChange={set('status_id')}>
            {d.statuses('feature').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Этап выполнения" hint="Этап и статус — разные поля">
          <select className="select" value={v.stage_id} onChange={set('stage_id')}>
            <option value="">Не указан</option>
            {meta.stages.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Публикация">
          <select className="select" value={v.visibility} onChange={set('visibility')}>
            <option value="draft">Черновик — только продуктовая команда</option>
            <option value="internal">Внутренняя — сотрудники</option>
            <option value="public">Опубликована — видна всем</option>
          </select>
        </Field>
        <Field label="Внешний ID / источник"><input className="input" value={v.external_ref} onChange={set('external_ref')} placeholder="Например, RAF-412" /></Field>
        <Field label="Автор запроса"><input className="input" value={v.author_name} onChange={set('author_name')} /></Field>
        <Field label="Ответственный"><input className="input" value={v.assignee_name} onChange={set('assignee_name')} /></Field>
        <Field label="Дата постановки"><input type="date" className="input" value={v.requested_at} onChange={set('requested_at')} /></Field>
        <Field label="Теги" hint="Через запятую"><input className="input" value={v.tags} onChange={set('tags')} /></Field>
        <Field label="Плановое начало"><input type="date" className="input" value={v.planned_start} onChange={set('planned_start')} /></Field>
        <Field label={v.task_kind === 'planned' ? 'Плановое завершение' : 'Плановая дата устранения'} hint={v.task_kind === 'planned' ? undefined : 'Без даты задача не попадает на диаграмму Ганта'}><input type="date" className="input" value={v.planned_end} onChange={set('planned_end')} /></Field>
        {v.task_kind !== 'planned' && (
          <>
            <Field label="Срочность" hint="Не межотдельный приоритет — только для багов и доработок">
              <select className="select" value={v.urgency} onChange={set('urgency')}>
                <option value="">Не указана</option>
                {Object.entries(URGENCY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Факт часов" hint="Заполняется после устранения, только для аналитики"><input className="input" inputMode="decimal" value={v.fact_hours} onChange={set('fact_hours')} /></Field>
          </>
        )}
        <Field label="Связанные офферы" span2>
          <div className="row wrap" style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 8, gap: 6 }}>
            {(offers.data?.offers ?? []).map((o: any) => (
              <label key={o.id} className="check" style={{ width: 'calc(50% - 6px)', minWidth: 220 }}>
                <input
                  type="checkbox"
                  checked={v.offer_ids.includes(o.id)}
                  onChange={(e) => setV((s) => ({ ...s, offer_ids: e.target.checked ? [...s.offer_ids, o.id] : s.offer_ids.filter((x: string) => x !== o.id) }))}
                />
                <span className="ellipsis">{o.external_code ? `${o.external_code} ` : ''}{o.name}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Приватные заметки" hint="Видны только продуктовой команде и администраторам" span2>
          <textarea className="textarea" rows={2} value={v.private_notes} onChange={set('private_notes')} />
        </Field>
      </div>
    </Modal>
  );
}

// ───────────────── feature picker ─────────────────
export function FeaturePicker({ onPick, exclude = [], placeholder = 'Найти задачу по номеру или названию' }: { onPick: (f: any) => void; exclude?: string[]; placeholder?: string }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const res = useApi<any>(dq.trim().length >= 1 ? `/features?q=${encodeURIComponent(dq.trim())}&sort=number&internal=all` : null);
  const list = useMemo(() => (res.data?.features ?? []).filter((f: any) => !exclude.includes(f.id)).slice(0, 8), [res.data, exclude]);
  return (
    <div className="stack tight">
      <div className="search">
        <I.search />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoFocus />
      </div>
      {dq && (
        <div className="panel" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {list.length === 0 && <div className="empty small">Ничего не найдено</div>}
          {list.map((f: any) => (
            <div key={f.id} className="list-item" onClick={() => onPick(f)}>
              <span className="key">{f.key}</span>
              <span className="grow ellipsis">{f.title}</span>
              <StatusPill status={f.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

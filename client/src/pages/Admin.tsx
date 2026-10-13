import { AdminApiKeys } from './ApiKeys';
import { TeamRates } from './TeamRates';
import { useState } from 'react';
import { I } from '../icons';
import { api, fmtDate, fmtDateTime, invalidate, mutate, ROLE_LABEL, toast, useApi, useApp, useQueryParam } from '../lib';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, StatusPill, Tabs, useDirty } from '../ui';

type Tab = 'users' | 'departments' | 'teams' | 'categories' | 'statuses' | 'stages' | 'periods' | 'settings' | 'audit' | 'apikeys' | 'rates';

export function Admin() {
  const { me } = useApp();
  const [t, setT] = useQueryParam('tab');
  const tab = (t as Tab) || 'users';
  if (!me?.permissions.admin) return <Empty title="Раздел доступен администраторам" />;
  return (
    <>
      <PageHead title="Администрирование" sub="Пользователи и роли, справочники, веса голосов, плановые периоды и журнал действий. Изменения действуют сразу, без правки кода." />
      <Tabs<Tab>
        boxed
        value={tab}
        onChange={(v) => setT(v === 'users' ? null : v)}
        items={[
          { id: 'users', label: 'Пользователи' },
          { id: 'departments', label: 'Отделы и веса' },
          { id: 'teams', label: 'Ресурсные команды' },
          { id: 'periods', label: 'Плановые периоды' },
          { id: 'categories', label: 'Категории' },
          { id: 'statuses', label: 'Статусы' },
          { id: 'stages', label: 'Этапы' },
          { id: 'settings', label: 'Публикация' },
          { id: 'apikeys', label: 'API-ключи' },
          { id: 'rates', label: 'Ставки команд' },
          { id: 'audit', label: 'Журнал' },
        ]}
      />
      {tab === 'users' && <Users />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
      {tab === 'apikeys' && <AdminApiKeys />}
      {tab === 'rates' && <TeamRates />}
      {!['users', 'settings', 'audit'].includes(tab) && <Dictionary kind={tab as DictKind} />}
    </>
  );
}

// ───────────────── users ─────────────────
function Users() {
  const { meta, me } = useApp();
  const { data, error } = useApi<any>('/admin/users');
  const [edit, setEdit] = useState<any | null>(null);
  const [cred, setCred] = useState<any | null>(null);
  const dept = (id: string) => meta.departments.find((d) => d.id === id)?.name ?? id;
  return (
    <div className="stack">
      <div className="row"><span className="grow small muted">Саморегистрации нет: администратор создаёт учётную запись и выдаёт одноразовое приглашение или временный пароль.</span><button className="btn primary" onClick={() => setEdit({})}><I.plus />Пользователь</button></div>
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Пользователь</th><th>Роль</th><th>Отделы (голосует за)</th><th>Доступ</th><th>Последний вход</th><th /></tr></thead>
              <tbody>
                {data.users.map((u: any) => (
                  <tr key={u.id}>
                    <td><b>{u.name}</b>{u.id === me?.id && <span className="muted small"> (вы)</span>}<div className="small muted">{u.email}</div></td>
                    <td>{ROLE_LABEL[u.role]}</td>
                    <td className="small">{u.department_ids.map(dept).join(', ') || <span className="muted">—</span>}</td>
                    <td>
                      {!u.is_active ? <span className="pill danger">отключён</span>
                        : u.has_pending_invite ? <span className="pill warn">приглашение отправлено</span>
                        : !u.has_password ? <span className="pill outline">нет пароля</span>
                        : u.must_change_password ? <span className="pill warn">временный пароль</span>
                        : <span className="pill ok">активен</span>}
                    </td>
                    <td className="small">{u.last_login_at ? fmtDateTime(u.last_login_at) : <span className="muted">не входил</span>}</td>
                    <td className="r nowrap">
                      <button className="btn sm" onClick={() => setEdit(u)}>Изменить</button>{' '}
                      <ResetButton user={u} onResult={setCred} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {edit && <UserForm user={edit.id ? (data?.users ?? []).find((u: any) => u.id === edit.id) ?? edit : null} onClose={() => setEdit(null)} onCreated={setCred} />}
      {cred && <CredentialsModal cred={cred} onClose={() => setCred(null)} />}
    </div>
  );
}

function ResetButton({ user, onResult }: { user: any; onResult: (r: any) => void }) {
  const [open, setOpen] = useState(false);
  const go = async (delivery: 'invite' | 'temp_password') => {
    setOpen(false);
    try {
      const r = await api<any>(`/admin/users/${user.id}/reset`, { method: 'POST', body: { delivery } });
      invalidate();
      onResult({ ...r, email: user.email, name: user.name });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>Сбросить доступ</button>
      {open && (
        <Modal title={`Новый доступ для ${user.name}`} onClose={() => setOpen(false)}>
          <div className="stack">
            <p>Текущие сессии пользователя будут завершены.</p>
            <button className="btn" onClick={() => go('invite')}>Выдать одноразовое приглашение (7 дней)</button>
            <button className="btn" onClick={() => go('temp_password')}>Выдать временный пароль</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function CredentialsModal({ cred, onClose }: { cred: any; onClose: () => void }) {
  const value = cred.invite_url ?? cred.temp_password;
  return (
    <Modal title="Передайте данные для входа" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Готово</button>}>
      <div className="stack">
        <p>{cred.invite_url ? `Ссылка-приглашение для ${cred.email ?? 'пользователя'}. Действует 7 дней и только один раз.` : `Временный пароль для ${cred.email ?? 'пользователя'}. При первом входе система попросит сменить его.`}</p>
        <div className="row">
          <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(value).then(() => toast('Скопировано'))}>Копировать</button>
        </div>
        <p className="small muted">Мы не показываем эти данные повторно. Передайте их по защищённому каналу.</p>
      </div>
    </Modal>
  );
}

function UserForm({ user, onClose, onCreated }: { user: any | null; onClose: () => void; onCreated: (r: any) => void }) {
  const { meta } = useApp();
  const [v, setV] = useState({ email: user?.email ?? '', name: user?.name ?? '', role: user?.role ?? 'department_lead', department_ids: user?.department_ids ?? [], is_active: user?.is_active ?? true, delivery: 'invite' });
  const dirty = useDirty(v);
  const submit = async () => {
    if (user) {
      const r = await mutate(`/admin/users/${user.id}`, 'PATCH', { name: v.name, role: v.role, department_ids: v.department_ids, is_active: v.is_active, version: user.version }, 'Пользователь сохранён');
      if (r) onClose();
    } else {
      const r = await mutate<any>('/admin/users', 'POST', { email: v.email, name: v.name, role: v.role, department_ids: v.department_ids, delivery: v.delivery }, 'Пользователь создан');
      if (r) { onClose(); onCreated({ ...r, email: v.email }); }
    }
  };
  return (
    <Modal title={user ? user.name : 'Новый пользователь'} onClose={onClose} dirty={dirty} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!v.name.trim() || (!user && !v.email.trim())} onClick={submit}>{user ? 'Сохранить' : 'Создать'}</button></>}>
      <div className="form-grid">
        <Field label="Email" span2><input className="input" type="email" value={v.email} disabled={!!user} onChange={(e) => setV({ ...v, email: e.target.value })} autoFocus={!user} /></Field>
        <Field label="Имя" span2><input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Роль" span2>
          <select className="select" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            <option value="department_lead">Руководитель / представитель отдела</option>
            <option value="product">Продуктовая команда</option>
            <option value="admin">Администратор</option>
          </select>
        </Field>
        <Field label="Голосует от имени отделов" span2 hint="Приоритет принадлежит отделу: одна текущая оценка на пару «отдел + задача»">
          <div className="row wrap" style={{ gap: 10 }}>
            {meta.departments.filter((d) => d.is_active).map((d) => (
              <label key={d.id} className="check">
                <input type="checkbox" checked={v.department_ids.includes(d.id)} onChange={(e) => setV({ ...v, department_ids: e.target.checked ? [...v.department_ids, d.id] : v.department_ids.filter((x: string) => x !== d.id) })} />
                {d.name}
              </label>
            ))}
          </div>
        </Field>
        {!user && (
          <Field label="Способ выдачи доступа" span2>
            <select className="select" value={v.delivery} onChange={(e) => setV({ ...v, delivery: e.target.value })}>
              <option value="invite">Одноразовое приглашение по ссылке</option>
              <option value="temp_password">Временный пароль с обязательной заменой</option>
            </select>
          </Field>
        )}
        {user && <label className="check span2"><input type="checkbox" checked={v.is_active} onChange={(e) => setV({ ...v, is_active: e.target.checked })} />Учётная запись активна</label>}
      </div>
    </Modal>
  );
}

// ───────────────── dictionaries ─────────────────
type DictKind = 'departments' | 'teams' | 'categories' | 'statuses' | 'stages' | 'periods';
const META_KEY: Record<DictKind, string> = { departments: 'departments', teams: 'teams', categories: 'categories', statuses: 'statuses', stages: 'stages', periods: 'periods' };
const ENTITY: Record<string, string> = { feature: 'Задачи', epic: 'Эпики', release: 'Релизы' };
const SEMANTIC: Record<string, string> = { new: 'новая', analysis: 'проработка', ready: 'готова к планированию', planned: 'запланирована', in_progress: 'в работе', blocked: 'заблокирована', postponed: 'отложена', done: 'завершена', cancelled: 'отменена', active: 'активна' };

function Dictionary({ kind }: { kind: DictKind }) {
  const { meta } = useApp();
  const [edit, setEdit] = useState<any | null>(null);
  // statuses of removed entities (offers, until migration 0012) are not shown
  const rows: any[] = ((meta as any)[META_KEY[kind]] ?? []).filter((r: any) => kind !== 'statuses' || ENTITY[r.entity]);
  const hint: Record<DictKind, string> = {
    departments: 'Голосующие бизнес-подразделения. Вес влияет на общий балл; отдел с отметкой «Product» решает при равенстве баллов.',
    teams: 'Команды, чьи часы планируются. Колонка Google Sheets по умолчанию — <код>_hours.',
    periods: 'Периоды планирования (месяц, спринт). Часы команд по периодам задаются в разделе «Роадмап → Ресурсы и план».',
    categories: 'Категории для задач и эпиков.',
    statuses: 'Смысловая группа определяет поведение: что планируется, когда ставится дата завершения. Название можно менять свободно.',
    stages: 'Этап выполнения (Product, Backend, QA…) — отдельное поле, не статус.',
  };
  return (
    <div className="stack">
      <div className="row"><span className="grow small muted">{hint[kind]}</span><button className="btn primary" onClick={() => setEdit({})}><I.plus />Добавить</button></div>
      <div className="panel flush">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Название</th>
                {kind !== 'categories' && kind !== 'periods' && <th>Код</th>}
                {kind === 'departments' && <><th className="r">Вес</th><th>Product</th></>}
                {kind === 'statuses' && <><th>Для</th><th>Смысл</th></>}
                {kind === 'periods' && <th>Даты</th>}
                <th>Состояние</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6}><Empty title="Пусто" /></td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{kind === 'statuses' ? <StatusPill status={r} /> : <span className="row">{r.color && <span className="cube" style={{ background: r.color }} />}{r.name}</span>}</td>
                  {kind !== 'categories' && kind !== 'periods' && <td className="small muted">{r.code}</td>}
                  {kind === 'departments' && <><td className="r num">{r.weight}</td><td>{r.is_product ? 'да' : ''}</td></>}
                  {kind === 'statuses' && <><td className="small">{ENTITY[r.entity]}</td><td className="small">{SEMANTIC[r.semantic] ?? r.semantic}</td></>}
                  {kind === 'periods' && <td className="small">{fmtDate(r.start_date)} — {fmtDate(r.end_date)}</td>}
                  <td>{r.is_active ? <span className="pill ok">активен</span> : <span className="pill outline">отключён</span>}</td>
                  <td className="r"><button className="btn sm" onClick={() => setEdit(r)}>Изменить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <DictForm kind={kind} row={edit.id ? rows.find((r) => r.id === edit.id) ?? edit : null} onClose={() => setEdit(null)} />}
    </div>
  );
}

function DictForm({ kind, row, onClose }: { kind: DictKind; row: any | null; onClose: () => void }) {
  const [v, setV] = useState<Record<string, any>>({
    name: row?.name ?? '', code: row?.code ?? '', weight: row?.weight ?? 1, is_product: row?.is_product ?? false, color: row?.color ?? '#5b6b8c',
    entity: row?.entity ?? 'feature', semantic: row?.semantic ?? 'new', sort_order: row?.sort_order ?? 0, start_date: row?.start_date ?? '', end_date: row?.end_date ?? '',
    is_active: row?.is_active ?? true, phase: row ? row.phase ?? '' : 'dev',
  });
  const dirty = useDirty(v);
  const set = (k: string, val: any) => setV((s) => ({ ...s, [k]: val }));
  const submit = async () => {
    const body: Record<string, any> = { name: v.name };
    if (!row && ['departments', 'teams', 'statuses', 'stages'].includes(kind)) body.code = v.code;
    if (kind === 'departments') Object.assign(body, { weight: Number(v.weight), is_product: v.is_product, sort_order: Number(v.sort_order) });
    if (['teams', 'categories', 'statuses'].includes(kind)) body.color = v.color;
    if (['teams', 'categories', 'statuses', 'stages'].includes(kind)) body.sort_order = Number(v.sort_order);
    if (kind === 'statuses' && !row) Object.assign(body, { entity: v.entity, semantic: v.semantic });
    if (kind === 'periods') Object.assign(body, { start_date: v.start_date, end_date: v.end_date });
    if (kind === 'stages') body.phase = v.phase || null;
    if (row) body.is_active = v.is_active;
    const r = row ? await mutate(`/admin/dict/${kind}/${row.id}`, 'PATCH', { ...body, version: row.version }, 'Сохранено') : await mutate(`/admin/dict/${kind}`, 'POST', body, 'Добавлено');
    if (r) onClose();
  };
  return (
    <Modal title={row ? row.name : 'Новая запись'} onClose={onClose} dirty={dirty} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!v.name.trim()} onClick={submit}>Сохранить</button></>}>
      <div className="form-grid">
        <Field label="Название" span2><input className="input" value={v.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        {['departments', 'teams', 'statuses', 'stages'].includes(kind) && (
          <Field label="Код" hint="Латиница, цифры и _; не меняется после создания"><input className="input" value={v.code} disabled={!!row} onChange={(e) => set('code', e.target.value.toLowerCase())} /></Field>
        )}
        {kind === 'departments' && <Field label="Вес голоса" hint="По умолчанию 1"><input className="input num" type="number" min="0.1" step="0.1" value={v.weight} onChange={(e) => set('weight', e.target.value)} /></Field>}
        {kind === 'departments' && <label className="check span2"><input type="checkbox" checked={v.is_product} onChange={(e) => set('is_product', e.target.checked)} />Это отдел Product (его оценка решает при равных баллах)</label>}
        {kind === 'statuses' && !row && (
          <>
            <Field label="Для сущности">
              <select className="select" value={v.entity} onChange={(e) => set('entity', e.target.value)}>
                {Object.entries(ENTITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Смысловая группа">
              <select className="select" value={v.semantic} onChange={(e) => set('semantic', e.target.value)}>
                {Object.entries(SEMANTIC).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </>
        )}
        {['teams', 'categories', 'statuses'].includes(kind) && <Field label="Цвет"><input className="input" type="color" value={v.color} onChange={(e) => set('color', e.target.value)} style={{ padding: 2 }} /></Field>}
        {kind === 'stages' && (
          <Field label="Этап на Ганте" hint="Несколько этапов могут относиться к одному этапу Ганта: Backend и Frontend — это «Разработка»">
            <select className="select" value={v.phase} onChange={(e) => set('phase', e.target.value)}>
              <option value="">Не показывать на Ганте</option>
              <option value="product">Продукт</option><option value="design">Дизайн</option><option value="dev">Разработка</option><option value="qa">QA</option><option value="release">Релиз</option>
            </select>
          </Field>
        )}
        {['departments', 'teams', 'categories', 'statuses', 'stages'].includes(kind) && <Field label="Порядок"><input className="input num" type="number" value={v.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field>}
        {kind === 'periods' && (
          <>
            <Field label="Начало"><input className="input" type="date" value={v.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
            <Field label="Окончание"><input className="input" type="date" value={v.end_date} onChange={(e) => set('end_date', e.target.value)} /></Field>
          </>
        )}
        {row && <label className="check span2"><input type="checkbox" checked={v.is_active} onChange={(e) => set('is_active', e.target.checked)} />Активна (отключённые записи скрыты из выбора, история сохраняется)</label>}
      </div>
    </Modal>
  );
}

// ───────────────── settings ─────────────────
function Settings() {
  const { meta } = useApp();
  const s = meta.settings;
  const save = async (patch: Record<string, unknown>) => {
    await mutate('/admin/settings', 'PUT', patch, 'Настройки сохранены');
  };
  return (
    <div className="panel">
      <div className="panel-body stack loose">
        <label className="check"><input type="checkbox" checked={s.public_show_estimates} onChange={(e) => save({ public_show_estimates: e.target.checked })} />Показывать гостям оценки трудозатрат опубликованных задач</label>
        <label className="check"><input type="checkbox" checked={s.public_show_capacity} onChange={(e) => save({ public_show_capacity: e.target.checked })} />Показывать гостям загрузку команд</label>
        <div className="row">
          <label htmlFor="hz">Горизонт планирования по умолчанию, периодов:</label>
          <select id="hz" className="select" style={{ width: 90 }} value={s.planning_horizon} onChange={(e) => save({ planning_horizon: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 8, 12].map((n) => <option key={n}>{n}</option>)}
          </select>
        </div>
        <ExportSettings save={save} />
        <p className="small muted">Гости видят только опубликованные карточки, эпики и релизы. Черновики, внутренние комментарии, приватные заметки, email сотрудников, настройки интеграций и история изменений в публичный API не попадают.</p>
      </div>
    </div>
  );
}

/** FR-08: the only spreadsheet the export may write to and who may write there */
function ExportSettings({ save }: { save: (patch: Record<string, unknown>) => Promise<void> }) {
  const cfg = useApi<any>('/exports/config');
  const [sheet, setSheet] = useState('');
  return (
    <div className="stack tight" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <b>Экспорт задач в Google-таблицу</b>
      <p className="small muted" style={{ margin: 0 }}>Экспорт пишет только во вкладку «Import» указанной таблицы и не трогает другие вкладки. Откройте таблицу сервисному аккаунту с ролью «Редактор» и создайте вкладку «Import».</p>
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 520 }} placeholder={cfg.data?.google?.url ?? 'Ссылка на таблицу для экспорта'} value={sheet} onChange={(e) => setSheet(e.target.value)} />
        <button className="btn sm" disabled={!sheet.trim()} onClick={async () => { await save({ export_google_spreadsheet_id: sheet }); setSheet(''); cfg.reload?.(); }}>Сохранить</button>
        {cfg.data?.google?.configured && <button className="btn ghost sm" onClick={() => save({ export_google_spreadsheet_id: '' })}>Отключить</button>}
      </div>
      {cfg.data?.google?.url && <a className="small" style={{ color: 'var(--info)' }} href={cfg.data.google.url} target="_blank" rel="noopener noreferrer">Текущая таблица экспорта</a>}
      <div className="row wrap small">
        Выгружать в Google могут:
        <select className="select sm" style={{ width: 'auto' }} value={cfg.data?.roles ?? 'product,admin'} onChange={async (e) => { await save({ export_google_roles: e.target.value.split(',') }); cfg.reload?.(); }} aria-label="Кто выгружает">
          <option value="admin">только администраторы</option>
          <option value="product,admin">продукт и администраторы</option>
          <option value="department_lead,product,admin">все сотрудники</option>
        </select>
      </div>
    </div>
  );
}

// ───────────────── audit ─────────────────
function Audit() {
  const [type, setType] = useState('');
  const [before, setBefore] = useState<number | null>(null);
  const { data, error } = useApi<any>(`/admin/audit?${new URLSearchParams({ ...(type ? { entity_type: type } : {}), ...(before ? { before: String(before) } : {}) })}`);
  const types = ['feature', 'proposal', 'vote', 'estimate', 'placement', 'relation', 'epic', 'release', 'capacity', 'plan', 'import', 'import_source', 'export', 'api_key', 'sprint', 'calendar', 'user', 'departments', 'teams', 'periods', 'settings'];
  return (
    <div className="stack">
      <div className="toolbar">
        <select className="select" value={type} onChange={(e) => { setType(e.target.value); setBefore(null); }} aria-label="Тип">
          <option value="">Все события</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {before && <button className="btn sm" onClick={() => setBefore(null)}>К последним</button>}
      </div>
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Когда</th><th>Кто</th><th>Объект</th><th>Действие</th><th>Изменения</th></tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan={5}><Empty title="Событий нет" /></td></tr>}
                {data.entries.map((e: any) => (
                  <tr key={e.id}>
                    <td className="nowrap small">{fmtDateTime(e.at)}</td>
                    <td className="small">{e.actor_name}</td>
                    <td className="small"><span className="muted">{e.entity_type}</span> {e.entity_id}</td>
                    <td className="small">{e.action}{e.is_override && <span className="pill warn" style={{ marginLeft: 6 }}>с подтверждением</span>}</td>
                    <td className="small" style={{ maxWidth: 420 }}>
                      {(e.changes ?? []).slice(0, 6).map((c: any, i: number) => <div key={i} className="ellipsis">{c.field}: {short(c.old)} → {short(c.new)}</div>)}
                      {e.reason && <div className="muted">Причина: {e.reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.entries.length === 100 && <div className="panel-body"><button className="btn sm" onClick={() => setBefore(data.entries[data.entries.length - 1].id)}>Показать раньше</button></div>}
        </div>
      )}
    </div>
  );
}

const short = (v: unknown) => {
  if (v === null || v === undefined) return '—';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

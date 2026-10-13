// Export builder (vNext ТЗ §4; owner decision 13.10 №15, variant A): a page of its own.
// Left — the catalog of fields by group (only what this user may export; the server builds it). Centre — the chosen
// columns: drag to reorder, rename. Right — filters (the backlog ones), sort, two groupings, subtotals.
// Bottom — a live preview of 50 rows and the structure of the file. Templates: the built-in TaskFlow one (read-only),
// shared ones (from an administrator) and personal ones.
import { useEffect, useMemo, useState } from 'react';
import { I } from '../icons';
import { api, ApiError, invalidate, navigate, toast, useApi, useApp, useDebounced, useDict, useQueryParam } from '../lib';
import { Empty, ErrorBox, Loading, Modal, Notice, PageHead } from '../ui';

interface Col { field: string; title?: string }
interface Spec { columns: Col[]; query: string; sort: { field: string; dir: 'asc' | 'desc' }[]; groups: string[]; subtotals: boolean }
const BUILTIN = 'builtin:taskflow';
const KIND_LABEL: Record<string, string> = { planned: 'Плановые', bug: 'Баги', operational_improvement: 'Оперативные доработки' };

export function ExportBuilder() {
  const { me } = useApp();
  const [queryParam] = useQueryParam('query');
  const fieldsQ = useApi<any>(me ? '/exports/fields' : null);
  const tplQ = useApi<any>(me ? '/exports/templates' : null);
  const cfg = useApi<any>(me ? '/exports/config' : null);
  const [tplId, setTplId] = useState<string>(BUILTIN);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<null | 'as'>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ code: string; message: string } | null>(null);

  const templates: any[] = tplQ.data?.templates ?? [];
  const tpl = templates.find((t) => t.id === tplId);
  // load a template into the editor (the backlog query, when the page was opened from the backlog, replaces its filters)
  useEffect(() => {
    if (!tpl || (spec && dirty)) return;
    const s: Spec = JSON.parse(JSON.stringify(tpl.spec));
    if (queryParam !== null && !spec) s.query = queryParam;
    setSpec(s);
  }, [tplId, tplQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useMemo(() => {
    const m = new Map<string, any>();
    for (const g of fieldsQ.data?.groups ?? []) for (const f of g.fields) m.set(f.id, { ...f, group: g.name });
    return m;
  }, [fieldsQ.data]);
  const edit = (patch: Partial<Spec>) => { setSpec((s) => ({ ...s!, ...patch })); setDirty(true); };

  const debounced = useDebounced(spec, 350);
  const [preview, setPreview] = useState<any | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  useEffect(() => {
    if (!debounced) return;
    if (!debounced.columns.length) { setPreview(null); setPreviewErr('Выберите хотя бы одну колонку'); return; }
    let stop = false;
    api('/exports/build/preview', { method: 'POST', body: { spec: debounced, template_id: tplId } })
      .then((r) => { if (!stop) { setPreview(r); setPreviewErr(null); } })
      .catch((e) => { if (!stop) setPreviewErr((e as Error).message); });
    return () => { stop = true; };
  }, [debounced, tplId]);

  if (!me) return <><PageHead title="Экспорт" /><div className="panel"><Empty title="Войдите, чтобы выгружать задачи" /></div></>;
  if (fieldsQ.error || tplQ.error) return <><PageHead title="Экспорт" /><ErrorBox error={fieldsQ.error ?? tplQ.error} /></>;
  if (!spec || !fieldsQ.data) return <><PageHead title="Экспорт" /><div className="panel"><Loading rows={8} /></div></>;

  const body = () => ({ spec, template_id: tplId });
  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/exports/build/xlsx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()), credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `Ошибка ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? '') || /filename="([^"]+)"/.exec(cd)?.[1] || 'export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Выгружено задач: ${res.headers.get('x-export-count')}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };
  const toGoogle = async (flags: Record<string, boolean> = {}) => {
    setBusy(true);
    try {
      const r = await api<any>('/exports/build/google', { method: 'POST', body: { ...body(), ...flags } });
      toast(`Во вкладку «${r.tab}» выгружено задач: ${r.count}`);
      setConfirm(null);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'confirm_external' || e.code === 'confirm_internal')) setConfirm({ code: e.code, message: e.message });
      else toast((e as Error).message, 'error');
    }
    setBusy(false);
  };
  const save = async () => {
    try {
      const r = await api<any>(`/exports/templates/${tpl.id}`, { method: 'PUT', body: { spec, version: tpl.version } });
      tpl.version = r.version;
      setDirty(false);
      toast('Шаблон сохранён');
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!tpl?.can_edit) return;
    try {
      await api(`/exports/templates/${tpl.id}`, { method: 'DELETE' });
      toast('Шаблон удалён');
      setDirty(false);
      setTplId(BUILTIN);
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const g = cfg.data?.google;

  return (
    <>
      <PageHead title="Экспорт" sub="Конструктор выгрузки: выберите поля, порядок и названия колонок, фильтры, сортировку и две группировки. Права проверяет сервер — недоступные поля не показываются и не выгружаются.">
        <button className="btn ghost" onClick={() => navigate('/backlog')}>К бэклогу</button>
      </PageHead>
      <div className="export-bar panel">
        <label className="row" style={{ gap: 6 }}>
          <span className="small muted">Шаблон</span>
          <select className="select" value={tplId} onChange={(e) => { if (dirty && !window.confirm('Несохранённые изменения пропадут. Продолжить?')) return; setDirty(false); setSpec(null); setTplId(e.target.value); }} aria-label="Шаблон">
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.scope === 'builtin' ? ' (встроенный)' : t.scope === 'shared' ? ' (общий)' : ''}</option>)}
          </select>
        </label>
        {dirty && <span className="pill warn">изменён</span>}
        {tpl?.can_edit && dirty && <button className="btn sm" onClick={save}>Сохранить</button>}
        <button className="btn ghost sm" onClick={() => setSaving('as')}>Сохранить как…</button>
        {tpl?.can_edit && <button className="btn ghost sm danger" onClick={remove}>Удалить шаблон</button>}
        <span className="grow" />
        {preview && <span className="small muted">задач: <b>{preview.count}</b>{preview.internal_count > 0 && <>, внутренних: {preview.internal_count}</>}</span>}
        <button className="btn primary" disabled={busy || !preview?.count} onClick={download}><I.download />Скачать Excel</button>
        {g?.allowed && g.configured && <button className="btn" disabled={busy || !preview?.count} onClick={() => toGoogle()}>В Google-таблицу</button>}
      </div>
      {tplId === BUILTIN && !dirty && <Notice kind="info">Встроенный шаблон «TaskFlow — 12 колонок» — формат обмена с первой подключённой таблицей. Его порядок и смысл колонок не меняются; чтобы изменить, сохраните копию.</Notice>}
      {confirm && (
        <Notice kind="warn">
          <div className="stack tight">
            <span>{confirm.message}</span>
            <div className="row">
              <button className="btn sm primary" disabled={busy} onClick={() => toGoogle(confirm.code === 'confirm_external' ? { confirm_external: true } : { confirm_external: true, confirm_internal: true })}>
                {confirm.code === 'confirm_external' ? 'Понимаю, выгрузить' : 'Выгрузить вместе с внутренними задачами'}
              </button>
              <button className="btn sm ghost" onClick={() => setConfirm(null)}>Отмена</button>
            </div>
          </div>
        </Notice>
      )}

      <div className="export-grid">
        <FieldCatalog groups={fieldsQ.data.groups} chosen={new Set(spec.columns.map((c) => c.field))} onAdd={(id) => edit({ columns: [...spec.columns, { field: id }] })} />
        <Columns spec={spec} fields={fields} onChange={(columns) => edit({ columns })} />
        <Settings spec={spec} fields={fields} onChange={edit} editor={!!me.permissions.plan} />
      </div>

      <section className="panel flush" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2 className="grow">Предпросмотр</h2>
          {preview && <span className="small muted">{Math.min(50, preview.total_rows)} из {preview.total_rows} строк файла</span>}
        </div>
        {previewErr && <div className="panel-body"><Notice kind="warn">{previewErr}</Notice></div>}
        {preview?.skipped?.length > 0 && <div className="panel-body"><Notice kind="warn">Недоступны вам и не будут выгружены: {preview.skipped.join(', ')}</Notice></div>}
        {preview && <PreviewTable p={preview} />}
        {preview && <Structure s={preview.structure} />}
      </section>
      {saving && <SaveAs canShare={!!tplQ.data?.can_share} initial={tpl && tpl.scope !== 'builtin' ? `${tpl.name} (копия)` : ''} onClose={() => setSaving(null)} onSave={async (name, scope) => {
        try {
          const r = await api<any>('/exports/templates', { method: 'POST', body: { name, scope, spec } });
          toast('Шаблон сохранён');
          setSaving(null);
          setDirty(false);
          await tplQ.reload?.();
          setTplId(r.id);
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }} />}
    </>
  );
}

function FieldCatalog({ groups, chosen, onAdd }: { groups: any[]; chosen: Set<string>; onAdd: (id: string) => void }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  return (
    <section className="panel export-col" aria-label="Каталог полей">
      <div className="panel-head"><h2 className="grow">Поля</h2></div>
      <div className="panel-body stack tight">
        <input className="input sm" placeholder="Найти поле" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Найти поле" />
        {groups.map((g) => {
          const list = g.fields.filter((f: any) => !needle || f.label.toLowerCase().includes(needle));
          if (!list.length) return null;
          return (
            <div key={g.name} className="stack tight">
              <div className="small muted" style={{ fontWeight: 600, marginTop: 6 }}>{g.name}</div>
              {list.map((f: any) => (
                <button key={f.id} className={`export-field ${chosen.has(f.id) ? 'on' : ''}`} draggable={!chosen.has(f.id)}
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-field', f.id); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => !chosen.has(f.id) && onAdd(f.id)} disabled={chosen.has(f.id)} title={chosen.has(f.id) ? 'Уже в колонках' : 'Добавить колонку'}>
                  <span className="grow ellipsis">{f.label}</span>
                  {chosen.has(f.id) ? <I.check /> : <I.plus />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Columns({ spec, fields, onChange }: { spec: Spec; fields: Map<string, any>; onChange: (c: Col[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const cols = spec.columns;
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = cols.slice();
    const [x] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, x);
    onChange(next);
  };
  const drop = (at: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const field = e.dataTransfer.getData('application/x-field');
    if (field && !cols.some((c) => c.field === field)) { const next = cols.slice(); next.splice(at, 0, { field }); onChange(next); }
    else if (drag !== null) move(drag, at);
    setDrag(null); setOver(null);
  };
  return (
    <section className="panel export-col" aria-label="Колонки файла" onDragOver={(e) => e.preventDefault()} onDrop={drop(cols.length)}>
      <div className="panel-head"><h2 className="grow">Колонки <span className="muted small">{cols.length}</span></h2>{cols.length > 0 && <button className="btn ghost sm" onClick={() => onChange([])}>Очистить</button>}</div>
      <div className="panel-body stack tight">
        {cols.length === 0 && <p className="small muted" style={{ margin: 0 }}>Добавьте поля слева — нажатием или перетаскиванием.</p>}
        {cols.map((c, i) => {
          const f = fields.get(c.field);
          return (
            <div key={c.field} className={`export-colrow ${over === i ? 'drop-before' : ''} ${f ? '' : 'missing'}`} draggable
              onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.field); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(i); }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.stopPropagation(); drop(i)(e); }}>
              <span className="grip" aria-hidden>⋮⋮</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <input className="input sm" value={c.title ?? ''} placeholder={f?.label ?? c.field} onChange={(e) => onChange(cols.map((x, j) => (j === i ? { ...x, title: e.target.value || undefined } : x)))} aria-label={`Название колонки ${i + 1}`} />
                <div className="small muted ellipsis">{f ? `${f.group} · ${f.label}` : `${c.field} — недоступно`}</div>
              </div>
              <div className="row" style={{ gap: 2 }}>
                <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Выше">↑</button>
                <button className="btn ghost icon sm" disabled={i === cols.length - 1} onClick={() => move(i, i + 2)} aria-label="Ниже">↓</button>
                <button className="btn ghost icon sm" onClick={() => onChange(cols.filter((_, j) => j !== i))} aria-label="Убрать колонку"><I.x /></button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Settings({ spec, fields, onChange, editor }: { spec: Spec; fields: Map<string, any>; onChange: (p: Partial<Spec>) => void; editor: boolean }) {
  const d = useDict();
  const releases = useApi<any>('/releases');
  const sprints = useApi<any>('/sprints');
  const p = new URLSearchParams(spec.query);
  const setQ = (key: string, value: string) => {
    const n = new URLSearchParams(spec.query);
    if (value) n.set(key, value); else n.delete(key);
    onChange({ query: n.toString() });
  };
  const all = [...fields.values()];
  const groupable = all.filter((f) => f.groupable);
  const sel = (label: string, key: string, options: { id: string; name: string }[]) => (
    <label className="field"><span>{label}</span>
      <select className="select sm" value={p.get(key) ?? ''} onChange={(e) => setQ(key, e.target.value)}>
        <option value="">Все</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
  const sorts = spec.sort.length ? spec.sort : [];
  return (
    <section className="panel export-col" aria-label="Фильтры, сортировка и группировка">
      <div className="panel-head"><h2 className="grow">Фильтры и группы</h2></div>
      <div className="panel-body stack tight">
        <label className="field"><span>Поиск</span><input className="input sm" value={p.get('q') ?? ''} onChange={(e) => setQ('q', e.target.value)} placeholder="ID, название, описание, тег" /></label>
        {sel('Тип работ', 'kind', Object.entries(KIND_LABEL).map(([id, name]) => ({ id, name })))}
        {sel('Статус', 'status', d.statuses('feature').map((s) => ({ id: s.id, name: s.name })))}
        {sel('Релиз', 'release', [{ id: 'none', name: 'Без релиза' }, ...(releases.data?.releases ?? []).map((r: any) => ({ id: r.id, name: r.name }))])}
        {sel('Спринт', 'sprint', [{ id: 'none', name: 'Без спринта' }, ...(sprints.data?.sprints ?? []).map((s: any) => ({ id: s.id, name: `Спринт ${s.code}` }))])}
        <label className="field"><span>Ответственный</span><input className="input sm" value={p.get('assignee') ?? ''} onChange={(e) => setQ('assignee', e.target.value)} placeholder="Имя как в карточке" /></label>
        <label className="field"><span>Тег</span><input className="input sm" value={p.get('tag') ?? ''} onChange={(e) => setQ('tag', e.target.value)} /></label>
        {editor && sel('Внутренние задачи продукта', 'internal', [{ id: '1', name: 'Только внутренние' }, { id: 'all', name: 'Общие и внутренние' }])}
        <label className="check small"><input type="checkbox" checked={p.get('hide_closed') === '1'} onChange={(e) => setQ('hide_closed', e.target.checked ? '1' : '')} />Без завершённых и отменённых</label>

        <div className="small muted" style={{ fontWeight: 600, marginTop: 8 }}>Сортировка</div>
        {[0, 1].map((i) => (
          <div key={i} className="row" style={{ gap: 6 }}>
            <select className="select sm grow" value={sorts[i]?.field ?? ''} disabled={i > 0 && !sorts[0]} aria-label={`Сортировка ${i + 1}`} onChange={(e) => {
              const next = sorts.slice();
              if (e.target.value) next[i] = { field: e.target.value, dir: next[i]?.dir ?? 'asc' }; else next.splice(i);
              onChange({ sort: next.filter(Boolean) });
            }}>
              <option value="">{i === 0 ? 'По приоритету (как в бэклоге)' : '—'}</option>
              {all.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            {sorts[i] && (
              <select className="select sm" value={sorts[i].dir} aria-label="Направление" onChange={(e) => onChange({ sort: sorts.map((s, j) => (j === i ? { ...s, dir: e.target.value as 'asc' | 'desc' } : s)) })}>
                <option value="asc">↑</option><option value="desc">↓</option>
              </select>
            )}
          </div>
        ))}

        <div className="small muted" style={{ fontWeight: 600, marginTop: 8 }}>Группировка</div>
        {[0, 1].map((i) => (
          <select key={i} className="select sm" value={spec.groups[i] ?? ''} disabled={i > 0 && !spec.groups[0]} aria-label={`Группировка ${i + 1}`} onChange={(e) => {
            const next = spec.groups.slice();
            if (e.target.value) next[i] = e.target.value; else next.splice(i);
            onChange({ groups: next.filter((x, j) => x && next.indexOf(x) === j) });
          }}>
            <option value="">{i === 0 ? 'Без группировки' : 'Без второго уровня'}</option>
            {groupable.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        ))}
        <label className="check small"><input type="checkbox" checked={spec.subtotals} onChange={(e) => onChange({ subtotals: e.target.checked })} disabled={!spec.groups.length} />Промежуточные итоги часов в группах</label>
      </div>
    </section>
  );
}

function PreviewTable({ p }: { p: any }) {
  if (!p.rows.length) return <Empty title="Нет задач под фильтры" />;
  return (
    <div className="table-wrap" style={{ maxHeight: 520 }}>
      <table className="data small export-preview">
        <thead><tr>{p.header.map((h: string, i: number) => <th key={i} className={p.columns[i]?.sum ? 'num' : ''}>{h}</th>)}</tr></thead>
        <tbody>
          {p.rows.map((r: any, i: number) => r.kind === 'group' ? (
            <GroupRow key={i} r={r} columns={p.columns} />
          ) : (
            <tr key={i}>
              {r.cells.map((c: any, j: number) => (
                <td key={j} className={p.columns[j]?.sum || typeof c === 'number' ? 'num' : ''} style={j === 0 && r.kind === 'task' ? { paddingLeft: 8 + r.level * 14 } : j === 0 ? { paddingLeft: 8 + r.level * 14 } : undefined}>
                  {c === null || c === undefined ? '' : String(c).split('\n').map((l, k) => <div key={k}>{l}</div>)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** a group header: its label spans the empty cells up to the first subtotal, so it reads like in Excel */
function GroupRow({ r, columns }: { r: any; columns: any[] }) {
  const labelAt = r.cells.findIndex((c: any) => typeof c === 'string' && c);
  const nextValue = r.cells.findIndex((c: any, j: number) => j > labelAt && c !== null && c !== undefined && c !== '');
  const span = (nextValue < 0 ? r.cells.length : nextValue) - labelAt;
  return (
    <tr className={`grp grp${r.level}`}>
      {r.cells.slice(0, labelAt).map((_: any, j: number) => <td key={`b${j}`} />)}
      <td colSpan={span} style={{ paddingLeft: 8 + r.level * 14 }}>{r.cells[labelAt]}</td>
      {r.cells.slice(labelAt + span).map((c: any, j: number) => <td key={j} className={columns[labelAt + span + j]?.sum ? 'num' : ''}>{c ?? ''}</td>)}
    </tr>
  );
}

function Structure({ s }: { s: any }) {
  return (
    <div className="panel-body export-structure small">
      <div><b>Структура файла.</b> Лист «{s.sheet}», колонки по порядку:</div>
      <ol>{s.columns.map((c: any, i: number) => <li key={i}>{c.title} <span className="muted">— {c.type}{c.sum ? ', итог в группах' : ''}</span></li>)}</ol>
      {s.groups.length > 0 && <div>Группировка: {s.groups.join(' → ')}.</div>}
      <div>Excel: {s.excel}</div>
      <div>Google: {s.google}</div>
      <div className="muted">Несколько ссылок одного типа — в одной ячейке, каждая с новой строки. Даты — ДД.ММ.ГГГГ. Формулы не создаются: весь текст выгружается как текст.</div>
    </div>
  );
}

function SaveAs({ canShare, initial, onClose, onSave }: { canShare: boolean; initial: string; onClose: () => void; onSave: (name: string, scope: 'personal' | 'shared') => void }) {
  const [name, setName] = useState(initial);
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  return (
    <Modal title="Сохранить шаблон" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), scope)}>Сохранить</button></>}>
      <div className="stack">
        <label className="field"><span>Название</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></label>
        {canShare && (
          <div className="stack tight">
            <label className="check"><input type="radio" checked={scope === 'personal'} onChange={() => setScope('personal')} />Личный — видите только вы</label>
            <label className="check"><input type="radio" checked={scope === 'shared'} onChange={() => setScope('shared')} />Общий — для всех сотрудников (поля, недоступные сотруднику, у него не выгружаются)</label>
          </div>
        )}
      </div>
    </Modal>
  );
}

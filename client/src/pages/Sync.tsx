import { useMemo, useState } from 'react';
import { I } from '../icons';
import { api, fmtDate, fmtDateTime, invalidate, mutate, openFeature, toast, useApi, useApp, useQueryParam } from '../lib';
import { Empty, ErrorBox, Field, Loading, Modal, Notice, PageHead, useDirty } from '../ui';

const SHEETS = [
  { key: 'epics', label: 'Эпики' },
  { key: 'features', label: 'Фичи' },
  { key: 'relations', label: 'Связи' },
] as const;

const ACTION_LABEL: Record<string, string> = { create: 'Создать', update: 'Обновить', unchanged: 'Без изменений', duplicate: 'Возможный дубль', error: 'Ошибка' };
const ACTION_PILL: Record<string, string> = { create: 'ok', update: 'info', unchanged: '', duplicate: 'warn', error: 'danger' };
const ENTITY_LABEL: Record<string, string> = { epic: 'Эпик', feature: 'Задача', relation: 'Связь', sheet: 'Лист' };
const VIS_LABEL: Record<string, string> = { draft: 'черновики', internal: 'внутренние (видны команде)' };
const isFlat = (s: any) => s?.config?.format === 'flat';

/** human-readable list of the columns a "one table of tasks" source reads */
function flatSummary(cfg: any): string {
  const c = cfg.flat?.columns ?? {};
  const parts = [
    `задача — «${c.title}»`,
    c.assignee && `исполнитель — «${c.assignee}»`,
    c.deadline?.length && `срок — ${c.deadline.map((x: string) => `«${x}»`).join(' или ')}`,
    c.done && `готово — «${c.done}»`,
    c.priority && `приоритет — «${c.priority}» (тег P1, P2…)`,
    ...Object.entries(cfg.flat?.hours ?? {}).map(([col, team]) => `часы «${col}» → ${team}`),
  ].filter(Boolean);
  const kind = ({ bug: 'баги', operational_improvement: 'оперативные доработки' } as Record<string, string>)[cfg.flat?.kind ?? ''];
  return (kind ? `тип — ${kind}; ` : '') + parts.join('; ');
}

export function Sync() {
  const { me } = useApp();
  const sources = useApi<any>('/import/sources');
  const runs = useApi<any>('/import/runs');
  const [runId, setRunId] = useQueryParam('run');
  const [editing, setEditing] = useState<any | null>(null);
  const [uploading, setUploading] = useState<any | null>(null);
  const [fileRun, setFileRun] = useState<any | null>(null);
  const [checks, setChecks] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!me?.permissions.import) return <Empty title="Раздел доступен продуктовой команде и администраторам" />;

  const check = async (s: any) => {
    setBusy(`check:${s.id}`);
    try {
      const r = await api<any>(`/import/sources/${s.id}/check`, { method: 'POST', body: {} });
      setChecks((c) => ({ ...c, [s.id]: r }));
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(null);
  };
  const preview = async (s: any) => {
    setBusy(`preview:${s.id}`);
    try {
      const r = await api<any>(`/import/sources/${s.id}/preview`, { method: 'POST', body: {} });
      setRunId(r.run.id);
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(null);
  };

  return (
    <>
      <PageHead title="Синхронизация" sub="Загрузка задач из Google Sheets: таблица задач отдела (например, TaskFlow) или шаблон из листов эпиков, фич, офферов и связей. Запуск вручную, изменения применяются только после предпросмотра.">
        {sources.data && (sources.data.bug_presets ?? []).some((p: any) => !sources.data.sources.some((x: any) => x.spreadsheet_id === p.spreadsheet_id && x.config?.flat?.sheet === p.config.flat.sheet)) && (
          <button className="btn" title="Две вкладки таблицы «Прием обращений по багам/доработкам»: «Баги» и «Доработки»" onClick={async () => {
            for (const p of sources.data.bug_presets) {
              if (sources.data.sources.some((x: any) => x.spreadsheet_id === p.spreadsheet_id && x.config?.flat?.sheet === p.config.flat.sheet)) continue;
              await mutate('/import/sources', 'POST', { name: p.name, kind: 'google', spreadsheet: p.spreadsheet_id, config: p.config }, `Источник «${p.name}» добавлен`);
            }
          }}><I.plus />Подключить баги и доработки</button>
        )}
        <button className="btn primary" onClick={() => setEditing({})}><I.plus />Добавить источник</button>
      </PageHead>

      {runId ? (
        <RunView runId={runId} onClose={() => setRunId(null)} />
      ) : (
        <div className="stack loose">
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Источники</h2></div>
            {!sources.data ? <Loading /> : sources.data.sources.length === 0 ? (
              <Empty title="Источников пока нет">
                Подключите Google-таблицу или{' '}
                <button className="btn sm" onClick={async () => { await mutate('/import/sources', 'POST', { name: 'Демонстрационная таблица (CSV)', kind: 'csv', demo: true }, 'Демо-источник добавлен'); }}>добавьте демонстрационный набор</button>
              </Empty>
            ) : sources.data.sources.map((s: any) => {
              const c = checks[s.id];
              return (
                <div key={s.id} className="source-card">
                  <div className="source-icon">{s.kind === 'google' ? <I.sheet /> : <I.file />}</div>
                  <div className="stack tight" style={{ minWidth: 0 }}>
                    <div className="row wrap"><b>{s.name}</b><span className="pill outline">{s.kind === 'google' ? 'Google Sheets' : 'CSV'}</span><span className="pill outline">{isFlat(s) ? 'одна таблица задач' : 'шаблон из 4 листов'}</span>{!s.is_active && <span className="pill warn">отключён</span>}</div>
                    {s.kind === 'google' && (
                      <a className="small ellipsis" style={{ color: 'var(--info)' }} href={`https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}`} target="_blank" rel="noopener noreferrer">
                        Открыть таблицу ({s.spreadsheet_id.slice(0, 12)}…)
                      </a>
                    )}
                    {s.kind === 'csv' && (
                      <div className="small muted">
                        {isFlat(s)
                          ? `Загружено: ${s.csv_sheets?.flat ? `${s.csv_sheets.flat.rows} строк` : 'нет'}`
                          : SHEETS.map((sh) => `${sh.label}: ${s.csv_sheets?.[sh.key] ? `${s.csv_sheets[sh.key].rows} строк` : 'нет'}`).join('; ')}
                      </div>
                    )}
                    {isFlat(s) ? (
                      <div className="small muted">Лист «{s.config.flat.sheet}»: {flatSummary(s.config)}. Новые карточки — {VIS_LABEL[s.config.newVisibility ?? 'draft']}.</div>
                    ) : (
                      <div className="small muted">
                        Листы: {SHEETS.map((sh) => s.config.sheets[sh.key]).join(', ')}
                        {Object.keys(s.config.hoursColumns ?? {}).length > 0 && `; доп. колонки часов: ${Object.entries(s.config.hoursColumns).map(([k, v]) => `${k} → ${v}`).join(', ')}`}
                      </div>
                    )}
                    {s.last_checked_at && (
                      <div className={`small ${s.last_check_ok ? '' : ''}`} style={{ color: s.last_check_ok ? 'var(--ok)' : 'var(--danger)' }}>
                        Проверка {fmtDateTime(s.last_checked_at)}: {s.last_check_ok ? 'подключение работает' : 'есть проблемы'}. {s.last_check_msg}
                      </div>
                    )}
                    {c && (
                      <div className="small">
                        {c.sheets.map((x: any) => (
                          <div key={x.key}>
                            {x.name}: {x.found ? `${x.rows} строк` : 'не найден'}
                            {x.missing_columns.length > 0 && <span style={{ color: 'var(--danger)' }}> — нет колонок {x.missing_columns.join(', ')}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {s.last_run && (
                      <div className="small muted">
                        Последний запуск {fmtDateTime(s.last_run.created_at)}: {runStatus(s.last_run.status)}
                        {s.last_run.status === 'preview' && <> — <a href={`?run=${s.last_run.id}`} onClick={(e) => { e.preventDefault(); setRunId(s.last_run.id); }} style={{ color: 'var(--info)' }}>открыть предпросмотр</a></>}
                      </div>
                    )}
                  </div>
                  <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                    {s.kind === 'csv' && <button className="btn sm" onClick={() => setUploading(s)}><I.upload />Загрузить CSV</button>}
                    {s.kind === 'google' && <button className="btn sm" disabled={!s.is_active} onClick={() => setFileRun(s)} title="Если таблица закрыта для сервисного аккаунта: скачайте лист как CSV и загрузите сюда"><I.upload />Из выгрузки CSV</button>}
                    <button className="btn sm" onClick={() => setEditing(s)}>Настройки</button>
                    <button className="btn sm" disabled={!!busy} onClick={() => check(s)}>{busy === `check:${s.id}` ? 'Проверяем…' : 'Проверить подключение'}</button>
                    <button className="btn sm primary" disabled={!!busy || !s.is_active} onClick={() => preview(s)}>{busy === `preview:${s.id}` ? 'Читаем таблицу…' : 'Синхронизировать'}</button>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Как подключить Google-таблицу</h2></div>
            <div className="panel-body stack">
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li>
                  <b>Таблица задач</b> (формат «одна таблица»): лист со строками задач и колонками «Задача», «Сотрудник», «Срок», «Сделано», «Оценка в часах» и т. п. — соответствие колонок задаётся в настройках источника, для TaskFlow оно заполнено заранее.
                  Если в таблице нет колонки с ID, задача узнаётся по тексту и исполнителю: переименованная задача придёт как «возможный дубль» и её можно привязать к прежней карточке.
                </li>
                <li><b>Шаблон из 3 листов</b>: <b>Epics</b>, <b>Features</b>, <b>Relations</b> (имена можно изменить в настройках). Шаблоны с примерами строк:{' '}
                  {SHEETS.map((sh, i) => <span key={sh.key}>{i > 0 && ', '}<a href={`/api/import/template/${sh.key}.csv`} style={{ color: 'var(--info)' }}>{sh.label}</a></span>)}.
                </li>
                <li>
                  {sources.data?.service_account_email ? (
                    <>Откройте таблице доступ <b>«Читатель»</b> для сервисного аккаунта <code style={{ background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 4 }}>{sources.data.service_account_email}</code>. Доступ на редактирование не нужен.</>
                  ) : (
                    <>Сервисный аккаунт не настроен: напрямую читаются только таблицы с доступом «по ссылке, читатель». Для закрытых таблиц администратор добавляет ключ read-only сервисного аккаунта в секрет <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (см. README). До этого можно скачать лист как CSV (Файл → Скачать → CSV) и загрузить его кнопкой «Из выгрузки CSV».</>
                  )}
                </li>
                <li>Добавьте источник, нажмите «Проверить подключение», затем «Синхронизировать». Ничего не запишется, пока вы не проверите предпросмотр и не нажмёте «Применить изменения».</li>
              </ol>
              <p className="small muted">
                Часы команд берутся из колонок вида <code>backend_hours</code>, <code>frontend_hours</code> — по коду ресурсной команды. Колонки с другими названиями сопоставьте в настройках источника.
                Удаление строки из таблицы не удаляет карточку. Голоса отделов, утверждённые релизы, план и вручную уточнённые часы синхронизация не перезаписывает.
              </p>
            </div>
          </section>

          <section className="panel flush">
            <div className="panel-head"><h2>Журнал импорта</h2></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Дата</th><th>Источник</th><th>Запустил</th><th>Статус</th><th>Результат</th></tr></thead>
                <tbody>
                  {(runs.data?.runs ?? []).length === 0 && <tr><td colSpan={5}><Empty title="Импортов ещё не было" /></td></tr>}
                  {(runs.data?.runs ?? []).map((r: any) => (
                    <tr key={r.id} className="click" onClick={() => setRunId(r.id)}>
                      <td className="nowrap">{fmtDateTime(r.created_at)}</td>
                      <td>{r.source_name}</td>
                      <td>{r.applied_by ?? r.created_by ?? '—'}</td>
                      <td>{runStatus(r.status)}</td>
                      <td className="small">
                        {r.status === 'applied' && r.counts
                          ? `создано ${r.counts.created}, обновлено ${r.counts.updated}, привязано ${r.counts.linked}, без изменений ${r.counts.unchanged}, пропущено ${r.counts.skipped}, ошибок ${r.counts.errors}, связей ${r.counts.relations_created}${r.counts.conflicts?.length ? `, конфликтов решено ${r.counts.conflicts.length}` : ''}`
                          : r.error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {editing && <SourceForm source={editing.id ? editing : null} defaults={sources.data?.default_config} flatPreset={sources.data?.flat_preset} onClose={() => setEditing(null)} />}
      {uploading && <CsvUpload source={uploading} onClose={() => setUploading(null)} />}
      {fileRun && <FilePreview source={fileRun} onClose={() => setFileRun(null)} onRun={(id) => { setFileRun(null); setRunId(id); }} />}
    </>
  );
}

function runStatus(s: string) {
  return ({ preview: 'ожидает решения', applied: 'применён', failed: 'ошибка, данные не изменены', stale: 'устарел — таблица изменилась', discarded: 'отменён' } as Record<string, string>)[s] ?? s;
}

const FLAT_FIELDS: { key: string; label: string; hint?: string; required?: boolean }[] = [
  { key: 'title', label: 'Задача', required: true, hint: 'Первая строка ячейки — название, ссылки и остальные строки уходят в описание' },
  { key: 'assignee', label: 'Исполнитель' },
  { key: 'description', label: 'Комментарий → описание' },
  { key: 'category', label: 'Категория' },
  { key: 'done', label: 'Сделано (да/нет)', hint: '«Да» → статус «Завершена»' },
  { key: 'closed_at', label: 'Дата выполнения' },
  { key: 'priority', label: 'Приоритет', hint: 'Становится тегом P1, P2… Голоса отделов не трогаются' },
  { key: 'fact_hours', label: 'Факт в часах → в описание' },
  { key: 'id', label: 'ID задачи (если есть)', hint: 'Пусто — ID вычисляется из текста задачи и исполнителя' },
];

function SourceForm({ source, defaults, flatPreset, onClose }: { source: any | null; defaults: any; flatPreset: any; onClose: () => void }) {
  const { meta } = useApp();
  const base = defaults ?? { sheets: { epics: 'Epics', features: 'Features', relations: 'Relations' }, hoursColumns: {} };
  const cfg = source?.config ?? base;
  const preset = flatPreset?.flat ?? { sheet: 'TaskFlow', columns: { title: 'Задача' }, flags: {}, hours: {} };
  const [name, setName] = useState(source?.name ?? '');
  const [kind, setKind] = useState<'google' | 'csv'>(source?.kind ?? 'google');
  const [format, setFormat] = useState<'template' | 'flat'>(source ? cfg.format ?? 'template' : 'flat');
  const [sheet, setSheet] = useState(source?.spreadsheet_id ?? '');
  const [sheets, setSheets] = useState<Record<string, string>>(cfg.sheets ?? base.sheets);
  const [cols, setCols] = useState<[string, string][]>(Object.entries(cfg.hoursColumns ?? {}));
  const flat0 = cfg.flat ?? preset;
  const [flatSheet, setFlatSheet] = useState<string>(flat0.sheet);
  const [flatCols, setFlatCols] = useState<Record<string, string>>(Object.fromEntries(FLAT_FIELDS.map((f) => [f.key, flat0.columns?.[f.key] ?? ''])));
  const [deadline, setDeadline] = useState<string>((flat0.columns?.deadline ?? []).join(', '));
  const [flags, setFlags] = useState<[string, string][]>(Object.entries(flat0.flags ?? {}));
  const [hours, setHours] = useState<[string, string][]>(Object.entries(flat0.hours ?? {}));
  const [vis, setVis] = useState<'draft' | 'internal'>(source ? cfg.newVisibility ?? 'draft' : 'internal');
  const [active, setActive] = useState(source?.is_active ?? true);
  const dirty = useDirty({ name, kind, format, sheet, sheets, cols, flatSheet, flatCols, deadline, flags, hours, vis, active });
  const pairs = (l: [string, string][]) => Object.fromEntries(l.filter(([c, t]) => c.trim() && t.trim()).map(([c, t]) => [c.trim(), t.trim()]));
  const submit = async () => {
    const config: any = { format, sheets, hoursColumns: pairs(cols), newVisibility: vis };
    if (format === 'flat') {
      const columns: any = Object.fromEntries(Object.entries(flatCols).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      const dl = deadline.split(',').map((x) => x.trim()).filter(Boolean);
      if (dl.length) columns.deadline = dl;
      config.flat = { sheet: flatSheet.trim(), columns, flags: pairs(flags), hours: pairs(hours) };
    }
    const r = source
      ? await mutate(`/import/sources/${source.id}`, 'PATCH', { name, config, is_active: active, ...(kind === 'google' && sheet !== source.spreadsheet_id ? { spreadsheet: sheet } : {}), version: source.version }, 'Источник сохранён')
      : await mutate('/import/sources', 'POST', { name, kind, config, ...(kind === 'google' ? { spreadsheet: sheet } : {}) }, 'Источник добавлен');
    if (r) onClose();
  };
  const pairEditor = (list: [string, string][], setList: (f: (l: [string, string][]) => [string, string][]) => void, placeholder: string, right: 'team' | 'tag') => (
    <div className="stack tight">
      {list.map(([c, t], i) => (
        <div key={i} className="row">
          <input className="input sm" value={c} placeholder={placeholder} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
          {right === 'team' ? (
            <select className="select sm" value={t} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}>
              <option value="">Команда</option>
              {meta.teams.map((tm) => <option key={tm.id} value={tm.code}>{tm.name}</option>)}
            </select>
          ) : (
            <input className="input sm" value={t} placeholder="Тег" onChange={(e) => setList((l) => l.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
          )}
          <button className="btn ghost sm icon" aria-label="Удалить" onClick={() => setList((l) => l.filter((_, j) => j !== i))}><I.x /></button>
        </div>
      ))}
      <div><button className="btn sm" onClick={() => setList((l) => [...l, ['', '']])}><I.plus />Колонка</button></div>
    </div>
  );
  const valid = name.trim() && (kind !== 'google' || sheet.trim()) && (format !== 'flat' || (flatSheet.trim() && flatCols.title.trim()));
  return (
    <Modal title={source ? 'Настройки источника' : 'Новый источник'} onClose={onClose} wide dirty={dirty} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!valid} onClick={submit}>Сохранить</button></>}>
      <div className="form-grid">
        <Field label="Название"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="TaskFlow отдела" /></Field>
        <Field label="Тип">
          <select className="select" value={kind} disabled={!!source} onChange={(e) => setKind(e.target.value as any)}>
            <option value="google">Google Sheets</option>
            <option value="csv">CSV-файлы (загрузка вручную)</option>
          </select>
        </Field>
        {kind === 'google' && <Field label="Ссылка на таблицу или её ID" span2><input className="input" value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>}
        <Field label="Формат таблицы">
          <select className="select" value={format} onChange={(e) => { const f = e.target.value as 'template' | 'flat'; setFormat(f); if (!source) setVis(f === 'flat' ? 'internal' : 'draft'); }}>
            <option value="flat">Одна таблица задач (TaskFlow и похожие)</option>
            <option value="template">Шаблон: эпики, фичи, офферы, связи</option>
          </select>
        </Field>
        <Field label="Новые карточки" hint="Обновления существующих карточек видимость не меняют">
          <select className="select" value={vis} onChange={(e) => setVis(e.target.value as any)}>
            <option value="internal">Внутренние — сразу видны команде</option>
            <option value="draft">Черновики — видны только продукту</option>
          </select>
        </Field>
        {format === 'flat' ? (
          <>
            <Field label="Лист"><input className="input" value={flatSheet} onChange={(e) => setFlatSheet(e.target.value)} /></Field>
            <Field label="Срок (первая заполненная колонка)" hint="Через запятую, по приоритету"><input className="input" value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="Новый срок, Изначальный срок" /></Field>
            {FLAT_FIELDS.map((f) => (
              <Field key={f.key} label={`Колонка: ${f.label}`} hint={f.hint}>
                <input className="input" value={flatCols[f.key]} onChange={(e) => setFlatCols((s) => ({ ...s, [f.key]: e.target.value }))} placeholder={f.required ? 'обязательно' : 'не используется'} />
              </Field>
            ))}
            <Field label="Колонки часов → команда" span2 hint="Оценка в часах попадает в ресурсную команду. Вручную уточнённые часы синхронизация не перезаписывает без вашего решения.">
              {pairEditor(hours, setHours, 'Название колонки, например Оценка в часах', 'team')}
            </Field>
            <Field label="Колонки-флаги → тег" span2 hint="Если в ячейке «Да», задаче ставится тег">
              {pairEditor(flags, setFlags, 'Название колонки, например Влетевшая', 'tag')}
            </Field>
          </>
        ) : (
          <>
            {SHEETS.map((sh) => (
              <Field key={sh.key} label={`Лист: ${sh.label}`}><input className="input" value={sheets[sh.key]} onChange={(e) => setSheets((s) => ({ ...s, [sh.key]: e.target.value }))} /></Field>
            ))}
            <Field label="Дополнительные колонки часов" span2 hint="Автоматически распознаются колонки <код команды>_hours. Здесь — колонки с другими названиями.">
              {pairEditor(cols, setCols, 'Название колонки, например Аналитика (ч)', 'team')}
            </Field>
          </>
        )}
        {source && <label className="check span2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Источник активен</label>}
      </div>
    </Modal>
  );
}

/** Preview from a CSV export of a Google source (works without a service account). */
function FilePreview({ source, onClose, onRun }: { source: any; onClose: () => void; onRun: (runId: string) => void }) {
  const flat = isFlat(source);
  const keys = flat ? [{ key: 'flat', label: `Лист «${source.config.flat.sheet}»` }] : SHEETS.map((sh) => ({ key: sh.key as string, label: sh.label as string }));
  const [files, setFiles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const read = (key: string, f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_400_000) { toast('Файл больше 1,4 МБ', 'error'); return; }
    f.text().then((t) => setFiles((s) => ({ ...s, [key]: t })));
  };
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<any>(`/import/sources/${source.id}/preview`, { method: 'POST', body: { files } });
      invalidate();
      onRun(r.run.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };
  return (
    <Modal title={`Синхронизация из выгрузки: ${source.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={busy || !Object.keys(files).length} onClick={go}>{busy ? 'Читаем…' : 'Сформировать предпросмотр'}</button></>}>
      <div className="stack">
        <p className="small muted">
          Откройте таблицу, перейдите на нужный лист и выберите «Файл → Скачать → CSV». Загрузите файл сюда — дальше всё как при обычной синхронизации:
          предпросмотр, решения по дублям и конфликтам, применение одной транзакцией. Файл не сохраняется как источник.
        </p>
        {keys.map((k) => (
          <Field key={k.key} label={k.label} hint={files[k.key] ? 'Файл прочитан' : 'Не выбран'}>
            <input type="file" accept=".csv,text/csv" onChange={(e) => read(k.key, e.target.files?.[0])} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function CsvUpload({ source, onClose }: { source: any; onClose: () => void }) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const read = (key: string, f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_000_000) { toast('Файл больше 1 МБ', 'error'); return; }
    f.text().then((t) => setFiles((s) => ({ ...s, [key]: t })));
  };
  return (
    <Modal title={`Загрузка CSV: ${source.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!Object.keys(files).length} onClick={async () => { if (await mutate(`/import/sources/${source.id}/csv`, 'PUT', { sheets: files, version: source.version }, 'Файлы загружены')) onClose(); }}>Загрузить</button></>}>
      <div className="stack">
        <p className="small muted">CSV с заголовками как в шаблоне. Разделитель — запятая или точка с запятой, кодировка UTF-8. Незагруженные листы останутся прежними.</p>
        {(isFlat(source) ? [{ key: 'flat', label: `Таблица задач («${source.config.flat.sheet}»)` }] : SHEETS).map((sh) => (
          <Field key={sh.key} label={sh.label} hint={files[sh.key] ? 'Файл прочитан, готов к загрузке' : source.csv_sheets?.[sh.key] ? `Сейчас: ${source.csv_sheets[sh.key].rows} строк` : 'Не загружен'}>
            <input type="file" accept=".csv,text/csv" onChange={(e) => read(sh.key, e.target.files?.[0])} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

// ───────────────── preview / run ─────────────────
function RunView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { data, error } = useApi<any>(`/import/runs/${runId}`);
  const [filter, setFilter] = useState<string>('attention');
  const [busy, setBusy] = useState(false);
  const run = data?.run;
  const items = useMemo(() => {
    if (!run) return [];
    if (filter === 'attention') return run.items.filter((i: any) => i.action === 'duplicate' || i.action === 'error' || i.warnings.length > 0 || i.diff.some((d: any) => d.kind !== 'update'));
    if (filter === 'all') return run.items;
    return run.items.filter((i: any) => i.action === filter);
  }, [run, filter]);
  if (!run) return error ? <ErrorBox error={error} /> : <Loading rows={8} />;
  const editable = run.status === 'preview';
  const s = run.summary;
  const attention = run.items.filter((i: any) => i.action === 'duplicate' || i.action === 'error' || i.warnings.length > 0 || i.diff.some((d: any) => d.kind !== 'update')).length;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<any>(`/import/runs/${run.id}/apply`, { method: 'POST', body: {} });
      toast(`Импорт применён: создано ${r.counts.created}, обновлено ${r.counts.updated}`);
      invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
      invalidate();
    }
    setBusy(false);
  };
  const chips = [
    { id: 'attention', label: 'Требуют внимания', n: attention },
    { id: 'create', label: 'Создать', n: s.create },
    { id: 'update', label: 'Обновить', n: s.update },
    { id: 'unchanged', label: 'Без изменений', n: s.unchanged },
    { id: 'duplicate', label: 'Возможные дубли', n: s.duplicate },
    { id: 'error', label: 'Ошибки', n: s.error },
    { id: 'all', label: 'Все строки', n: s.total },
  ];
  return (
    <div className="stack loose">
      <div className="row wrap">
        <button className="btn ghost sm" onClick={onClose}>Все источники</button>
        <span className="grow" />
        <span className="small muted">Предпросмотр от {fmtDateTime(run.created_at)}{run.created_by ? `, ${run.created_by}` : ''}</span>
      </div>
      {run.status === 'applied' && <Notice kind="ok">Импорт применён {fmtDateTime(run.applied_at)}{run.applied_by ? `, ${run.applied_by}` : ''}. Повторное применение невозможно — для новой синхронизации нажмите «Синхронизировать» у источника.</Notice>}
      {run.status === 'stale' && <Notice kind="warn">Таблица изменилась после предпросмотра. Сформируйте его заново — устаревшие изменения не применяются.</Notice>}
      {run.status === 'failed' && <Notice kind="danger">Ошибка записи: импорт отменён целиком, данные не изменены. {run.error}</Notice>}
      {run.status === 'discarded' && <Notice kind="info">Этот предпросмотр отменён.</Notice>}
      {(run.counts?.notes ?? []).length > 0 && <Notice kind="info">{run.counts.notes.join('. ')}</Notice>}
      <div className="summary-chips">
        {chips.map((c) => (
          <button key={c.id} className={filter === c.id ? 'on' : ''} onClick={() => setFilter(c.id)}>
            <b className="num">{c.n}</b><span>{c.label}</span>
          </button>
        ))}
      </div>
      {editable && run.unresolved.length > 0 && (
        <Notice kind="warn">
          <div className="stack tight">
            <b>Нужно решение по {run.unresolved.length} {run.unresolved.length === 1 ? 'пункту' : 'пунктам'}, прежде чем применять.</b>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{run.unresolved.slice(0, 6).map((u: string) => <li key={u}>{u}</li>)}{run.unresolved.length > 6 && <li>и ещё {run.unresolved.length - 6}</li>}</ul>
            <div className="row wrap">
              <button className="btn sm" onClick={() => mutate(`/import/runs/${run.id}/bulk`, 'POST', { action: 'link_exact_duplicates' })}>Дубли с точным совпадением названия — привязать</button>
              <button className="btn sm" onClick={() => mutate(`/import/runs/${run.id}/bulk`, 'POST', { action: 'create_duplicates' })}>Все нерешённые дубли — создать новыми</button>
              <button className="btn sm" onClick={() => mutate(`/import/runs/${run.id}/bulk`, 'POST', { action: 'skip_duplicates' })}>Пропустить все нерешённые дубли</button>
              <button className="btn sm" onClick={() => mutate(`/import/runs/${run.id}/bulk`, 'POST', { action: 'keep_local_conflicts' })}>Во всех конфликтах оставить значения системы</button>
            </div>
          </div>
        </Notice>
      )}
      <section className="panel">
        {items.length === 0 && <Empty title="Нет строк в этой категории" />}
        {items.map((it: any) => <ImportItem key={it.id} runId={run.id} it={it} editable={editable} />)}
      </section>
      {editable && (
        <div className="row" style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', padding: '12px 0' }}>
          <button className="btn primary" disabled={busy || run.unresolved.length > 0} onClick={apply}>{busy ? 'Применяем…' : 'Применить изменения'}</button>
          <button className="btn" disabled={busy} onClick={async () => { await mutate(`/import/runs/${run.id}/discard`, 'POST', {}, 'Предпросмотр отменён'); onClose(); }}>Отменить</button>
          <span className="small muted">Изменения применяются одной транзакцией: либо всё, либо ничего.{run.origin === 'file' ? ' Источник данных — загруженная выгрузка CSV.' : ''}</span>
        </div>
      )}
    </div>
  );
}

function ImportItem({ runId, it, editable }: { runId: string; it: any; editable: boolean }) {
  const res = it.resolution;
  const setRes = (resolution: any) => mutate(`/import/runs/${runId}/items/${it.id}`, 'PATCH', { resolution });
  const p = it.payload;
  const title = it.entity_type === 'relation' ? `${p.from_external_id} ${relLabel(p.relation_type)} ${p.to_external_id}` : p.title;
  const needs = editable && ((it.action === 'duplicate' && !res) || (it.action === 'update' && it.diff.some((d: any) => d.kind === 'conflict' && !res?.fields?.[d.field])));
  const skipped = res?.mode === 'skip';
  return (
    <div className={`import-item ${needs ? 'needs' : ''}`} style={skipped ? { opacity: 0.6 } : undefined}>
      <div className="row wrap">
        <span className={`pill ${ACTION_PILL[it.action]}`}>{ACTION_LABEL[it.action]}</span>
        <span className="small muted">{it.sheet}, строка {it.row_number}</span>
        <span className="small muted">{ENTITY_LABEL[it.entity_type]}</span>
        {it.external_id && it.entity_type !== 'relation' && <span className="key">{it.external_id}</span>}
        <b className="grow" style={{ minWidth: 200 }}>{title}</b>
        {skipped && <span className="pill outline">пропущено</span>}
        {editable && ['create', 'update'].includes(it.action) && (
          skipped
            ? <button className="btn ghost sm" onClick={() => setRes(it.action === 'create' ? { mode: 'create' } : { mode: 'update', targetId: it.target_id, fields: {}, protected: {} })}>Вернуть</button>
            : <button className="btn ghost sm" onClick={() => setRes({ mode: 'skip' })}>Пропустить</button>
        )}
      </div>
      {it.errors.length > 0 && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{it.errors.join('; ')}</div>}
      {it.warnings.length > 0 && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>{it.warnings.join('; ')}</div>}
      {it.action === 'create' && it.entity_type === 'feature' && (
        <div className="small muted" style={{ marginTop: 4 }}>
          {[
            p.assignee_name && `исполнитель ${p.assignee_name}`,
            p.planned_end && `срок ${fmtDate(p.planned_end)}`,
            (p.tags ?? []).length > 0 && `теги ${p.tags.join(', ')}`,
            Object.keys(p.estimates ?? {}).length > 0 && `часы ${Object.entries(p.estimates).map(([t, h]) => `${t.replace('team_', '')} ${h}`).join(', ')}`,
            p.epic_ext && `эпик ${p.epic_ext}`,
          ].filter(Boolean).join('; ')}
        </div>
      )}
      {it.action === 'duplicate' && (
        <div className="stack tight" style={{ marginTop: 8 }}>
          <div className="small">Похожие карточки уже есть. Автоматически не объединяем — выберите:</div>
          {it.candidates.map((c: any) => (
            <label key={c.id} className="check small">
              <input type="radio" name={`dup-${it.id}`} disabled={!editable} checked={res?.mode === 'link' && res.targetId === c.id} onChange={() => setRes({ mode: 'link', targetId: c.id })} />
              Это та же карточка: <b>{c.label}</b> <span className="muted">({c.reason}, сходство {Math.round(c.score * 100)}%)</span>
            </label>
          ))}
          <label className="check small"><input type="radio" name={`dup-${it.id}`} disabled={!editable} checked={res?.mode === 'create'} onChange={() => setRes({ mode: 'create' })} />Создать новую карточку</label>
          <label className="check small"><input type="radio" name={`dup-${it.id}`} disabled={!editable} checked={res?.mode === 'skip'} onChange={() => setRes({ mode: 'skip' })} />Пропустить строку</label>
          {res?.mode === 'link' && <div className="small muted">Источник будет привязан к выбранной карточке; её поля сейчас не перезаписываются.</div>}
        </div>
      )}
      {it.diff.length > 0 && !skipped && (
        <table className="diff-table">
          <thead><tr><th>Поле</th><th>В системе</th><th>В таблице</th><th>Решение</th></tr></thead>
          <tbody>
            {it.diff.map((d: any) => {
              const choice = d.kind === 'protected' ? (res?.protected?.[d.field] ? 'source' : 'local') : res?.fields?.[d.field] ?? (d.kind === 'update' ? 'source' : undefined);
              const set = (c: 'source' | 'local') => {
                const next = { mode: 'update', targetId: it.target_id, fields: { ...(res?.fields ?? {}) }, protected: { ...(res?.protected ?? {}) } };
                if (d.kind === 'protected') next.protected[d.field] = c === 'source';
                else next.fields[d.field] = c;
                setRes(next);
              };
              return (
                <tr key={d.field}>
                  <td>
                    {d.label}
                    {d.kind === 'conflict' && <div className="small" style={{ color: 'var(--warn)' }}>изменено и в системе, и в таблице</div>}
                    {d.kind === 'protected' && <div className="small muted">защищённое поле</div>}
                  </td>
                  <td className="val">{d.localLabel ?? fmtVal(d.local)}</td>
                  <td className="val">{d.sourceLabel ?? fmtVal(d.source)}</td>
                  <td>
                    {d.kind === 'protected' ? (
                      <label className="check small"><input type="checkbox" disabled={!editable} checked={choice === 'source'} onChange={(e) => set(e.target.checked ? 'source' : 'local')} />Перезаписать из таблицы</label>
                    ) : (
                      <div className="choice">
                        <button disabled={!editable} className={choice === 'local' ? 'on' : ''} onClick={() => set('local')}>Оставить</button>
                        <button disabled={!editable} className={choice === 'source' ? 'on' : ''} onClick={() => set('source')}>Из таблицы</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {it.target_id && it.entity_type === 'feature' && <div className="small" style={{ marginTop: 6 }}><a href="#" style={{ color: 'var(--info)' }} onClick={(e) => { e.preventDefault(); openFeature(it.target_id); }}>Открыть карточку</a></div>}
    </div>
  );
}

const relLabel = (t: string) => ({ blocks: 'блокирует', related_to: 'связана с', duplicate_of: 'дубль', affects_offer: 'влияет на оффер', belongs_to_epic: 'входит в эпик' } as Record<string, string>)[t] ?? t;
function fmtVal(v: unknown) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  const s = String(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

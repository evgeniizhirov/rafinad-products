// FR-08: export the current backlog selection (all pages) to XLSX or to the «Import» tab of the export spreadsheet.
import { useEffect, useState } from 'react';
import { api, ApiError, navigate, toast, useApi } from '../lib';
import { Loading, Modal, Notice } from '../ui';

export function ExportDialog({ query, onClose }: { query: string; onClose: () => void }) {
  const cfg = useApi<any>('/exports/config');
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    api<any>('/exports/preview', { method: 'POST', body: { query } }).then(setPreview).catch((e) => toast((e as Error).message, 'error'));
  }, [query]);

  const downloadXlsx = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/exports/xlsx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `Ошибка ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'tasks.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Выгружено задач: ${res.headers.get('x-export-count')}`);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };

  const toGoogle = async (flags: Record<string, boolean> = {}) => {
    setBusy(true);
    try {
      const r = await api<any>('/exports/google', { method: 'POST', body: { query, ...flags } });
      toast(`Во вкладку «Import» выгружено задач: ${r.count}`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'confirm_external' || e.code === 'confirm_internal')) setConfirm({ code: e.code, message: e.message });
      else toast((e as Error).message, 'error');
    }
    setBusy(false);
  };

  const g = cfg.data?.google;
  return (
    <Modal title="Экспорт задач" onClose={onClose}>
      {!preview ? <Loading rows={2} /> : (
        <div className="stack">
          <p style={{ margin: 0 }}>
            По текущим фильтрам — <b>{preview.count}</b> задач (все страницы списка), {preview.columns.length} колонок шаблона «TaskFlow». Права проверяет сервер: выгрузка содержит только то, что вы видите.
            {preview.internal_count > 0 && <> Внутренних задач продукта: <b>{preview.internal_count}</b>.</>}
          </p>
          <div className="row wrap">
            <button className="btn primary" disabled={busy || !preview.count} onClick={downloadXlsx}>Скачать Excel (.xlsx)</button>
            {g?.allowed && g.configured && <button className="btn" disabled={busy || !preview.count} onClick={() => toGoogle()}>Выгрузить в Google-таблицу</button>}
          </div>
          <a className="small" style={{ color: 'var(--info)' }} href={`/export?query=${encodeURIComponent(query)}`} onClick={(e) => { e.preventDefault(); onClose(); navigate(`/export?query=${encodeURIComponent(query)}`); }}>Настроить колонки, группировку и шаблоны в конструкторе экспорта →</a>
          {g?.allowed && !g.configured && <p className="small muted" style={{ margin: 0 }}>Выгрузка в Google станет доступна, когда администратор укажет таблицу экспорта.</p>}
          {g?.url && <a className="small" style={{ color: 'var(--info)' }} href={g.url} target="_blank" rel="noopener noreferrer">Открыть таблицу экспорта (вкладка «Import»)</a>}
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
        </div>
      )}
    </Modal>
  );
}

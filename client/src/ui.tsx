import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I } from './icons';
import { fmtH, useApp, useToasts, VISIBILITY_LABEL, type ApiError } from './lib';

export function Cubes({ score, size, showScore = true }: { score: number | null | undefined; size?: 'lg'; showScore?: boolean }) {
  const s = score ?? 0;
  return (
    <span className={`cubes ${size ?? ''} ${score == null ? 'none' : ''}`} title={score == null ? 'Нет оценок отделов' : `Приоритет ${score} из 5`}>
      <span className="cubes-row">
        {[1, 2, 3, 4, 5].map((i) => {
          const fill = Math.max(0, Math.min(1, s - (i - 1)));
          return (
            <span key={i} className="cube">
              {fill > 0 && <i style={{ width: `${fill * 100}%` }} />}
            </span>
          );
        })}
      </span>
      {showScore && <span className="score num">{score == null ? '—' : score.toFixed(score % 1 ? 2 : 0).replace('.', ',')}</span>}
    </span>
  );
}

export function ScoreCell({ score, onClick, title }: { score: number | null | undefined; onClick?: () => void; title?: string }) {
  return (
    <button type="button" className={`score-cell ${score ? `v${score}` : ''} ${onClick ? 'editable' : ''}`} onClick={onClick} disabled={!onClick} title={title} aria-label={title}>
      {score ?? '—'}
    </button>
  );
}

export function StatusPill({ status }: { status: { name: string; color?: string } | null | undefined }) {
  if (!status) return null;
  return (
    <span className="pill status" style={{ ['--c' as any]: status.color ?? '#8a94a6' }}>
      <span className="dot" />
      {status.name}
    </span>
  );
}

export function VisBadge({ v }: { v?: string }) {
  const { me } = useApp();
  if (!me || !v) return null;
  const Icon = v === 'public' ? I.eye : v === 'draft' ? I.draft : I.eyeOff;
  return (
    <span className={`vis ${v}`} title={v === 'public' ? 'Видна всем, включая гостей' : v === 'draft' ? 'Черновик: видна только продуктовой команде' : 'Видна только сотрудникам'}>
      <Icon />
      {VISIBILITY_LABEL[v]}
    </span>
  );
}

export function Meter({ value, max, color, over }: { value: number; max: number; color?: string; over?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : value > 0 ? 100 : 0;
  return (
    <div className={`meter ${over ? 'over' : ''}`} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <i style={{ width: `${pct}%`, ['--c' as any]: color }} />
    </div>
  );
}

export function LoadRow({ name, color, capacity, planned }: { name: string; color?: string; capacity: number; planned: number }) {
  const over = planned > capacity;
  return (
    <div className="load-row">
      <span className="ellipsis">{name}</span>
      <Meter value={planned} max={capacity} color={color} over={over} />
      <span className={`v num ${over ? 'over' : ''}`}>
        {Math.round(planned)} / {Math.round(capacity)} ч{over ? ` (+${Math.round(planned - capacity)})` : ''}
      </span>
    </div>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress">
      <Meter value={value} max={100} color="var(--ok)" />
      <span className="small num nowrap" style={{ minWidth: 34 }}>{label ?? `${value}%`}</span>
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — Rafinad Roadmap`;
  }, [title]);
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function GuestNote() {
  const { me } = useApp();
  if (me) return null;
  return (
    <div className="guest-note">
      <I.eye />
      <span>Вы смотрите опубликованную версию. Чтобы голосовать и редактировать, <a href="/login" style={{ color: 'var(--beet)', fontWeight: 500 }}>войдите</a>.</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: ApiError | Error | null }) {
  if (!error) return null;
  return (
    <div className="notice danger">
      <I.alert />
      <span>{error.message}</span>
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const Icon = kind === 'ok' ? I.check : kind === 'info' ? I.info : I.alert;
  return (
    <div className={`notice ${kind}`}>
      <Icon />
      <div className="grow">{children}</div>
    </div>
  );
}

/**
 * Dialog. Closes on ✕, «Отмена», Escape or a click on the backdrop — but only when the press
 * also STARTED on the backdrop (selecting text in a field and releasing outside never closes it).
 * With `dirty`, closing by Escape/backdrop asks for confirmation so typed changes are not lost.
 */
export function Modal({ title, onClose, children, footer, wide, dirty }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; dirty?: boolean }) {
  const pressedOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const softClose = () => {
    if (dirtyRef.current && !window.confirm('Закрыть без сохранения? Изменения будут потеряны.')) return;
    closeRef.current();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // only the top-most dialog reacts
      const wraps = document.querySelectorAll('.modal-wrap');
      if (wraps[wraps.length - 1] !== wrapRef.current) return;
      e.stopPropagation();
      softClose();
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wrapRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="scrim" style={{ zIndex: 59 }} />
      <div
        ref={wrapRef}
        className="modal-wrap"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
        onClick={(e) => {
          if (e.target === e.currentTarget && pressedOnBackdrop.current) softClose();
          pressedOnBackdrop.current = false;
        }}
      >
        <div className={`modal ${wide ? 'wide' : ''}`}>
          <div className="modal-head">
            <h3 className="grow">{title}</h3>
            <button className="btn ghost icon sm" onClick={() => onClose()} aria-label="Закрыть"><I.x /></button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    </>
  );
}

/** true when the form value differs from its initial value */
export function useDirty(value: unknown): boolean {
  const [initial] = useState(() => JSON.stringify(value));
  return JSON.stringify(value) !== initial;
}

/** Confirmation that requires a written reason (overload, approved release changes, admin overrides). */
export function ReasonModal({ title, children, confirmText, onConfirm, onClose }: { title: string; children: ReactNode; confirmText: string; onConfirm: (reason: string) => Promise<void> | void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); await onConfirm(reason.trim()); setBusy(false); }}>
            {confirmText}
          </button>
        </>
      }
    >
      <div className="stack">
        {children}
        <div className="field">
          <label htmlFor="reason">Причина (сохранится в журнале)</label>
          <textarea id="reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={500} />
        </div>
      </div>
    </Modal>
  );
}

export function Tabs<T extends string>({ value, onChange, items, boxed }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; n?: number | null }[]; boxed?: boolean }) {
  return (
    <div className={`tabs ${boxed ? 'boxed' : ''}`} role="tablist">
      {items.map((it) => (
        <button key={it.id} role="tab" aria-selected={value === it.id} className={value === it.id ? 'on' : ''} onClick={() => onChange(it.id)}>
          {it.label}
          {it.n != null && <span className="n">{it.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; title?: string }[] }) {
  return (
    <div className="seg">
      {items.map((it) => (
        <button key={it.id} className={value === it.id ? 'on' : ''} onClick={() => onChange(it.id)} title={it.title} aria-pressed={value === it.id}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const { list, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Скрыть">✕</button>
        </div>
      ))}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return <span className="avatar">{initials}</span>;
}

export function Hours({ value }: { value: number | null | undefined }) {
  return <span className="num nowrap">{fmtH(value)}</span>;
}

/** Text with safe auto-links (http/https only). Content is always rendered as text, never as HTML. */
export function RichText({ text }: { text: string | null | undefined }) {
  if (!text) return <span className="muted">Нет описания</span>;
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <p className="pre">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--info)', textDecoration: 'underline' }}>
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

export function Field({ label, hint, children, span2 }: { label: string; hint?: ReactNode; children: ReactNode; span2?: boolean }) {
  return (
    <div className={`field ${span2 ? 'span2' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

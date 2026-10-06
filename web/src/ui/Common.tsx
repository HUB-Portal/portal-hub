import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import type { Tone } from '../lib/format';

export function Button({ variant = 'secondary', loading, size, children, className = '', disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean; size?: 'sm' }) {
  return (
    <button {...rest} type={rest.type ?? 'button'} disabled={disabled || loading} className={`btn btn-${variant}${size ? ` btn-${size}` : ''} ${className}`.trim()} aria-busy={loading || undefined}>
      {loading ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: string; error?: string | null; children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode; className?: string }) {
  const id = useId();
  const desc = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': desc, 'aria-invalid': error ? true : undefined })}
      {hint ? <p className="hint" id={`${id}-h`}>{hint}</p> : null}
      {error ? <p className="field-error" id={`${id}-e`} role="alert">{error}</p> : null}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

const NOTICE_ICON = { info: Info, good: CheckCircle2, warn: AlertTriangle, bad: XCircle, neutral: Info } as const;
export function Notice({ tone = 'info', title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden="true" className="notice-icon" />
      <div className="notice-body">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner-row" role="status"><Loader2 className="spin" size={18} aria-hidden="true" /> {label}</div>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`.trim()}>
      {title || actions ? (
        <header className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pages">
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page.toLocaleString('en-GB')} of {pages.toLocaleString('en-GB')}</span>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </nav>
  );
}

export function Dialog({ open, title, onClose, children, footer, wide, dismissible = true }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; dismissible?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return <dialog ref={ref} className="dialog" aria-labelledby={titleId} />;
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (dismissible) onClose(); }}
      onMouseDown={(e) => { if (dismissible && e.target === ref.current) onClose(); }}
    >
      <div className="dialog-inner">
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-h` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="hint" id={`${id}-h`}>{hint}</p> : null}
    </div>
  );
}

/** Says which aligner an issue is about, for example "Lower, step 17". Empty when the issue has no aligner. */
function whereOf(i: { arch?: string | null; step?: number | null }): string {
  if (!i.arch) return '';
  const arch = i.arch === 'upper' ? 'Upper' : 'Lower';
  return typeof i.step === 'number' ? `${arch}, step ${i.step}` : arch;
}

export function IssueList({ items, tone }: { items: { message: string; arch?: 'upper' | 'lower' | null; step?: number | null }[]; tone: 'bad' | 'warn' }) {
  if (!items.length) return null;
  return (
    <ul className={`issues issues-${tone}`}>
      {items.map((i, n) => (
        <li key={n}>{tone === 'bad' ? <XCircle size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}<span>{i.message}{whereOf(i) ? <span className="muted"> ({whereOf(i)})</span> : null}</span></li>
      ))}
    </ul>
  );
}

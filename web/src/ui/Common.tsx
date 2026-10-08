import { createEffect, createUniqueId, For, type JSX, mergeProps, Show, splitProps } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-solid';
import type { Tone } from '../lib/format';

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean; size?: 'sm' }) {
  const [own, rest] = splitProps(mergeProps({ variant: 'secondary' as const }, props), ['variant', 'loading', 'size', 'children', 'class', 'disabled', 'type']);
  return (
    <button
      {...rest}
      type={own.type ?? 'button'}
      disabled={own.disabled || own.loading}
      class={`btn btn-${own.variant}${own.size ? ` btn-${own.size}` : ''} ${own.class ?? ''}`.trim()}
      aria-busy={own.loading || undefined}
    >
      <Show when={own.loading}><Loader2 class="spin" size={16} aria-hidden="true" /></Show>
      {own.children}
    </button>
  );
}

/** What a Field hands to the control inside it: spread it on the input. The values follow the field's hint and error. */
export interface FieldControlProps { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }

export function Field(props: { label: string; hint?: string; error?: string | null; children: (p: FieldControlProps) => JSX.Element; class?: string }) {
  const id = createUniqueId();
  const control: FieldControlProps = {
    id,
    get 'aria-describedby'() { return [props.hint ? `${id}-h` : '', props.error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined; },
    get 'aria-invalid'() { return props.error ? true : undefined; },
  };
  return (
    <div class={`field ${props.class ?? ''}`.trim()}>
      <label for={id}>{props.label}</label>
      {props.children(control)}
      <Show when={props.hint}><p class="hint" id={`${id}-h`}>{props.hint}</p></Show>
      <Show when={props.error}><p class="field-error" id={`${id}-e`} role="alert">{props.error}</p></Show>
    </div>
  );
}

export function Badge(props: { tone?: Tone; children: JSX.Element; title?: string }) {
  return <span class={`badge badge-${props.tone ?? 'neutral'}`} title={props.title}>{props.children}</span>;
}

const NOTICE_ICON = { info: Info, good: CheckCircle2, warn: AlertTriangle, bad: XCircle, neutral: Info } as const;
export function Notice(props: { tone?: Tone; title?: string; children?: JSX.Element; action?: JSX.Element }) {
  const tone = () => props.tone ?? 'info';
  return (
    <div class={`notice notice-${tone()}`} role={tone() === 'bad' ? 'alert' : 'status'}>
      <Dynamic component={NOTICE_ICON[tone()]} size={18} aria-hidden="true" class="notice-icon" />
      <div class="notice-body">
        <Show when={props.title}><strong>{props.title}</strong></Show>
        <Show when={props.children}><div>{props.children}</div></Show>
      </div>
      <Show when={props.action}><div class="notice-action">{props.action}</div></Show>
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return <div class="spinner-row" role="status"><Loader2 class="spin" size={18} aria-hidden="true" /> {props.label ?? 'Loading'}</div>;
}

export function Card(props: { title?: JSX.Element; actions?: JSX.Element; children: JSX.Element; class?: string }) {
  return (
    <section class={`card ${props.class ?? ''}`.trim()}>
      <Show when={props.title || props.actions}>
        <header class="card-head">
          <Show when={props.title} fallback={<span />}><h2>{props.title}</h2></Show>
          <Show when={props.actions}><div class="card-actions">{props.actions}</div></Show>
        </header>
      </Show>
      {props.children}
    </section>
  );
}

export function PageHeader(props: { title: JSX.Element; subtitle?: JSX.Element; actions?: JSX.Element }) {
  return (
    <div class="page-head">
      <div>
        <h1>{props.title}</h1>
        <Show when={props.subtitle}><p class="subtitle">{props.subtitle}</p></Show>
      </div>
      <Show when={props.actions}><div class="page-actions">{props.actions}</div></Show>
    </div>
  );
}

export function Empty(props: { title: string; children?: JSX.Element; action?: JSX.Element }) {
  return (
    <div class="empty">
      <h3>{props.title}</h3>
      <Show when={props.children}><p>{props.children}</p></Show>
      {props.action}
    </div>
  );
}

export function ProgressBar(props: { value: number; label: string }) {
  const pct = () => Math.max(0, Math.min(100, Math.round(props.value * 100)));
  return (
    <div class="progress" role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()}>
      <div class="progress-bar" style={{ width: `${pct()}%` }} />
    </div>
  );
}

export function Pagination(props: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.pageSize));
  return (
    <Show when={pages() > 1}>
      <nav class="pagination" aria-label="Pages">
        <Button size="sm" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>Previous</Button>
        <span>Page {props.page.toLocaleString('en-GB')} of {pages().toLocaleString('en-GB')}</span>
        <Button size="sm" disabled={props.page >= pages()} onClick={() => props.onPage(props.page + 1)}>Next</Button>
      </nav>
    </Show>
  );
}

export function Dialog(props: { open: boolean; title: string; onClose: () => void; children: JSX.Element; footer?: JSX.Element; wide?: boolean; dismissible?: boolean }) {
  let ref!: HTMLDialogElement;
  const titleId = createUniqueId();
  const dismissible = () => props.dismissible ?? true;
  createEffect(() => {
    const open = props.open;
    if (open && !ref.open) ref.showModal();
    if (!open && ref.open) ref.close();
  });
  return (
    <dialog
      ref={ref}
      class={`dialog${props.wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (dismissible()) props.onClose(); }}
      onMouseDown={(e) => { if (dismissible() && e.target === ref) props.onClose(); }}
    >
      <Show when={props.open}>
        <div class="dialog-inner">
          <h2 id={titleId}>{props.title}</h2>
          <div class="dialog-body">{props.children}</div>
          <Show when={props.footer}><div class="dialog-foot">{props.footer}</div></Show>
        </div>
      </Show>
    </dialog>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = createUniqueId();
  return (
    <div class="check">
      <input id={id} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} aria-describedby={props.hint ? `${id}-h` : undefined} />
      <label for={id}>{props.label}</label>
      <Show when={props.hint}><p class="hint" id={`${id}-h`}>{props.hint}</p></Show>
    </div>
  );
}

/** Says which aligner an issue is about, for example "Lower, step 17". Empty when the issue has no aligner. */
function whereOf(i: { arch?: string | null; step?: number | null }): string {
  if (!i.arch) return '';
  const arch = i.arch === 'upper' ? 'Upper' : 'Lower';
  return typeof i.step === 'number' ? `${arch}, step ${i.step}` : arch;
}

export function IssueList(props: { items: { message: string; arch?: 'upper' | 'lower' | null; step?: number | null }[]; tone: 'bad' | 'warn' }) {
  return (
    <Show when={props.items.length}>
      <ul class={`issues issues-${props.tone}`}>
        <For each={props.items}>
          {(i) => (
            <li>
              <Show when={props.tone === 'bad'} fallback={<AlertTriangle size={16} aria-hidden="true" />}><XCircle size={16} aria-hidden="true" /></Show>
              <span>{i.message}<Show when={whereOf(i)}><span class="muted"> ({whereOf(i)})</span></Show></span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

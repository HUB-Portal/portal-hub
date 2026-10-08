import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { Bell } from 'lucide-solid';
import { api, errorText } from '../lib/api';
import { useMenu } from '../lib/auth';
import { formatDateTime, formatNumber } from '../lib/format';

interface Notif {
  id: string;
  kind?: string;
  title: string;
  body?: string | null;
  data?: { caseId?: string; [k: string]: unknown } | null;
  read: boolean;
  createdAt: string;
}
/** Where a notification leads. Cases open in the case pages, registration news in the partner review or the overview. */
function linkFor(n: Notif, caseBase: string): string | null {
  const caseId = typeof n.data?.caseId === 'string' ? n.data.caseId : null;
  if (caseId) return `${caseBase}/${caseId}`;
  if (n.kind === 'signup_confirmed' || n.kind === 'signup_ceiling') return '/console/partners?tab=review';
  if (n.kind === 'org_approved') return '/portal';
  if (n.kind === 'org_logo_changed' || n.kind === 'org_logo_removed') return '/portal/company#logo';
  return null;
}
/** A link into a menu area the person may not see falls back to the overview (visibility only). */
function visibleLink(to: string | null, menu: { claims: boolean; spec: boolean; materials: boolean }): string | null {
  if (!to) return to;
  const path = to.split(/[?#]/)[0]!;
  const under = (base: string) => path === base || path.startsWith(`${base}/`);
  if ((under('/portal/claims') || /^\/portal\/cases\/[^/]+\/claim$/.test(path)) && !menu.claims) return '/portal';
  if (under('/portal/spec') && !menu.spec) return '/portal';
  if (under('/portal/materials') && !menu.materials) return '/portal';
  return to;
}
interface NotifResponse { items: Notif[]; unread: number }

/** Bell for both shells. Reads GET /api/notifications, marks with POST /api/notifications/read. */
export function NotificationBell(props: { caseBase: string }) {
  const qc = useQueryClient();
  const menu = useMenu();
  const [open, setOpen] = createSignal(false);
  let ref!: HTMLDivElement;
  const q = createQuery(() => ({
    queryKey: ['notifications'],
    queryFn: () => api<NotifResponse>('/api/notifications'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  }));
  const list = () => q.data?.items ?? [];
  const unread = () => q.data?.unread ?? 0;

  const mark = createMutation(() => ({
    mutationFn: (body: { ids: string[] } | { all: true }) => api('/api/notifications/read', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  }));

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => { if (ref && !ref.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); });
  });

  return (
    <div class="pop-wrap" ref={ref}>
      <button type="button" class="icon-btn" aria-label={unread() ? `Notifications, ${formatNumber(unread())} unread` : 'Notifications'} aria-expanded={open()} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
        <Bell size={20} aria-hidden="true" />
        <Show when={unread() > 0}><span class="bell-badge" aria-hidden="true">{unread() > 99 ? '99+' : unread()}</span></Show>
      </button>
      <Show when={open()}>
        <div class="popover wide" role="region" aria-label="Notifications">
          <div class="row" style={{ 'justify-content': 'space-between' }}>
            <h3>Notifications</h3>
            <Show when={unread() > 0}><button type="button" class="btn btn-sm btn-ghost" disabled={mark.isPending} onClick={() => mark.mutate({ all: true })}>Mark all as read</button></Show>
          </div>
          <Show when={q.isError}><p class="field-error" style={{ 'margin-top': '6px' }}>{errorText(q.error)}</p></Show>
          <Show when={!q.isError && list().length === 0}><p class="muted small" style={{ 'margin-top': '6px' }}>You have no notifications yet. Updates about your cases will appear here.</p></Show>
          <Show when={list().length}>
            <ul class="notif-list">
              <For each={list()}>
                {(n) => {
                  const to = () => visibleLink(linkFor(n, props.caseBase), menu);
                  const body = () => (
                    <>
                      <strong>{n.title}</strong>
                      {n.body ? <div class="small">{n.body}</div> : null}
                      <div class="muted small">{formatDateTime(n.createdAt)}</div>
                    </>
                  );
                  return (
                    <li class={n.read ? undefined : 'unread'}>
                      <Show
                        when={to()}
                        fallback={
                          <div>
                            {body()}
                            {!n.read ? <button type="button" class="btn btn-sm btn-ghost" onClick={() => mark.mutate({ ids: [n.id] })}>Mark as read</button> : null}
                          </div>
                        }
                      >
                        {(href) => (
                          <A href={href()} style={{ color: 'inherit', 'text-decoration': 'none', display: 'block' }} onClick={() => { if (!n.read) mark.mutate({ ids: [n.id] }); setOpen(false); }}>{body()}</A>
                        )}
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  );
}

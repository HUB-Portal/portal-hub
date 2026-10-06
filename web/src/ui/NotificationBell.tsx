import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
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
export function NotificationBell({ caseBase }: { caseBase: string }) {
  const qc = useQueryClient();
  const menu = useMenu();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotifResponse>('/api/notifications'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const list = q.data?.items ?? [];
  const unread = q.data?.unread ?? 0;

  const mark = useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) => api('/api/notifications/read', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="icon-btn" aria-label={unread ? `Notifications, ${formatNumber(unread)} unread` : 'Notifications'} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
        <Bell size={20} aria-hidden="true" />
        {unread > 0 ? <span className="bell-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span> : null}
      </button>
      {open ? (
        <div className="popover wide" role="region" aria-label="Notifications">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>Notifications</h3>
            {unread > 0 ? <button type="button" className="btn btn-sm btn-ghost" disabled={mark.isPending} onClick={() => mark.mutate({ all: true })}>Mark all as read</button> : null}
          </div>
          {q.isError ? <p className="field-error" style={{ marginTop: 6 }}>{errorText(q.error)}</p> : null}
          {!q.isError && list.length === 0 ? <p className="muted small" style={{ marginTop: 6 }}>You have no notifications yet. Updates about your cases will appear here.</p> : null}
          {list.length ? (
            <ul className="notif-list">
              {list.map((n) => {
                const to = visibleLink(linkFor(n, caseBase), menu);
                const body = (
                  <>
                    <strong>{n.title}</strong>
                    {n.body ? <div className="small">{n.body}</div> : null}
                    <div className="muted small">{formatDateTime(n.createdAt)}</div>
                  </>
                );
                return (
                  <li key={n.id} className={n.read ? undefined : 'unread'}>
                    {to ? (
                      <Link to={to} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }} onClick={() => { if (!n.read) mark.mutate({ ids: [n.id] }); setOpen(false); }}>{body}</Link>
                    ) : (
                      <div>
                        {body}
                        {!n.read ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => mark.mutate({ ids: [n.id] })}>Mark as read</button> : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

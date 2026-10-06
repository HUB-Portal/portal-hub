import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KLINE_ROLES } from '@shared/roles';
import { api, errorText } from '../../lib/api';
import { useSites, type SiteRow } from '../../lib/console';
import { formatDate } from '../../lib/format';
import type { TeamUser } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { ROLE_INFO } from '../partner/Team';

interface StaffUser extends TeamUser { siteIds?: string[]; siteCodes?: string[] }

function RoleFields({ roles, setRoles, siteIds, setSiteIds, sites }: { roles: string[]; setRoles: (v: string[]) => void; siteIds: string[]; setSiteIds: (v: string[]) => void; sites: SiteRow[] }) {
  const production = roles.includes('kl_production');
  return (
    <>
      <fieldset className="check-group">
        <legend>Roles</legend>
        {KLINE_ROLES.map((r) => (
          <div className="check" key={r}>
            <input id={`sr-${r}`} type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
            <label htmlFor={`sr-${r}`}>{ROLE_INFO[r]!.label}</label>
            <p className="hint">{ROLE_INFO[r]!.text}</p>
          </div>
        ))}
      </fieldset>
      {production ? (
        <fieldset className="check-group">
          <legend>Sites for production staff</legend>
          <p className="hint">Production staff only see and update cases at the sites you tick. With none ticked they see every site.</p>
          {sites.map((s) => (
            <div className="check" key={s.id}>
              <input id={`ss-${s.id}`} type="checkbox" checked={siteIds.includes(s.id)} onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))} />
              <label htmlFor={`ss-${s.id}`}>{s.code}, {s.name}</label>
            </div>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

export default function Staff() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['staff'], queryFn: () => api<{ users: StaffUser[] }>('/api/staff') });
  const sites = useSites();
  const [invite, setInvite] = useState(false);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [confirm, setConfirm] = useState<{ user: StaffUser; action: 'reset-mfa' | 'disable' } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const siteList = sites.data?.sites ?? [];
  const codeFor = (u: StaffUser) => u.siteCodes ?? (u.siteIds ?? []).map((id) => siteList.find((s) => s.id === id)?.code).filter((x): x is string => !!x);

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api(`/api/staff/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['staff'] });
      setNotice({ tone: 'good', text: ({ 'resend-invite': 'Invitation sent again.', enable: 'Access restored.', disable: 'Access removed.', 'reset-mfa': 'Authenticator reset. They will set it up again at their next sign in.', unlock: 'Unlocked. They can sign in again now.' } as Record<string, string>)[v.action] ?? 'Done.' });
      setConfirm(null);
    },
    onError: (e) => { setNotice({ tone: 'bad', text: errorText(e) }); setConfirm(null); },
  });

  return (
    <div className="page">
      <PageHeader title="Staff" subtitle="K Line people and what they can do." actions={<Button variant="primary" onClick={() => setInvite(true)}>Invite someone</Button>} />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <Card>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Roles</th><th>Sites</th><th>Status</th><th>Last sign in</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {q.data.users.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.name}</strong>{u.isYou ? <span className="muted"> (you)</span> : null}<div className="muted small">{u.email}</div></td>
                    <td>{u.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(', ')}</td>
                    <td>{u.roles.includes('kl_production') ? (codeFor(u).length ? codeFor(u).join(', ') : <span className="muted">All sites</span>) : <span className="muted">Not used</span>}</td>
                    <td>
                      <Badge tone={u.status === 'active' ? 'good' : u.status === 'invited' ? 'info' : 'bad'}>{u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Disabled'}</Badge>
                      {u.locked ? <div><Badge tone="warn">Locked</Badge></div> : null}
                      {u.status === 'active' && !u.mfaEnabled ? <div className="small muted">No authenticator</div> : null}
                    </td>
                    <td className="nowrap">{u.lastLoginAt ? formatDate(u.lastLoginAt) : 'Never'}</td>
                    <td>
                      {u.isYou ? null : (
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          {u.status === 'invited' ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'resend-invite' })} aria-label={`Send the invitation again to ${u.name}`}>Resend</Button> : null}
                          {u.status !== 'disabled' ? <Button size="sm" onClick={() => setEditing(u)} aria-label={`Change roles for ${u.name}`}>Roles</Button> : null}
                          {u.locked ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'unlock' })} aria-label={`Unlock ${u.name}`}>Unlock</Button> : null}
                          {u.status === 'active' ? <Button size="sm" onClick={() => setConfirm({ user: u, action: 'reset-mfa' })} aria-label={`Reset the authenticator for ${u.name}`}>Reset authenticator</Button> : null}
                          {u.status === 'disabled'
                            ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'enable' })} aria-label={`Enable ${u.name}`}>Enable</Button>
                            : <Button size="sm" variant="danger" onClick={() => setConfirm({ user: u, action: 'disable' })} aria-label={`Disable ${u.name}`}>Disable</Button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <InviteDialog open={invite} sites={siteList} onClose={() => setInvite(false)} onDone={() => { setInvite(false); qc.invalidateQueries({ queryKey: ['staff'] }); setNotice({ tone: 'good', text: 'Invitation sent.' }); }} />
      <RolesDialog user={editing} sites={siteList} onClose={() => setEditing(null)} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['staff'] }); setNotice({ tone: 'good', text: 'Roles changed. They will need to sign in again.' }); }} />
      <Dialog
        open={!!confirm}
        title={confirm?.action === 'disable' ? 'Disable this person?' : 'Reset their authenticator?'}
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" loading={act.isPending} onClick={() => confirm && act.mutate({ id: confirm.user.id, action: confirm.action })}>{confirm?.action === 'disable' ? 'Disable' : 'Reset authenticator'}</Button></>}
      >
        <p>
          {confirm?.action === 'disable'
            ? `${confirm.user.name} will be signed out and cannot sign in until you enable them again.`
            : `${confirm?.user.name} will be signed out and must set up their authenticator app again at their next sign in.`}
        </p>
      </Dialog>
    </div>
  );
}

function InviteDialog({ open, onClose, onDone, sites }: { open: boolean; onClose: () => void; onDone: () => void; sites: SiteRow[] }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['kl_intake']);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setEmail(''); setName(''); setRoles(['kl_intake']); setSiteIds([]); setError(null); } }, [open]);
  const m = useMutation({
    mutationFn: () => api('/api/staff/invite', { method: 'POST', body: { email: email.trim(), name: name.trim(), roles, siteIds: roles.includes('kl_production') ? siteIds : [] } }),
    onSuccess: onDone,
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={open} title="Invite a staff member" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Full name">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />}</Field>
        <RoleFields roles={roles} setRoles={setRoles} siteIds={siteIds} setSiteIds={setSiteIds} sites={sites} />
        <p className="small muted">You will be asked for your authenticator code to confirm.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email || !name || roles.length === 0}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RolesDialog({ user, sites, onClose, onDone }: { user: StaffUser | null; sites: SiteRow[]; onClose: () => void; onDone: () => void }) {
  const [roles, setRoles] = useState<string[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (user) { setRoles(user.roles); setSiteIds(user.siteIds ?? []); setError(null); } }, [user]);
  const m = useMutation({
    mutationFn: () => api(`/api/staff/${user!.id}/roles`, { method: 'POST', body: { roles, siteIds: roles.includes('kl_production') ? siteIds : [] } }),
    onSuccess: onDone,
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={!!user} title={user ? `Roles for ${user.name}` : 'Roles'} onClose={onClose}>
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <RoleFields roles={roles} setRoles={setRoles} siteIds={siteIds} setSiteIds={setSiteIds} sites={sites} />
        <p className="small muted">They are signed out everywhere when their roles change. You will be asked for your authenticator code.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={roles.length === 0} onClick={() => m.mutate()}>Save roles</Button>
        </div>
      </div>
    </Dialog>
  );
}

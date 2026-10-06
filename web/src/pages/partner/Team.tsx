import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { isNotApproved } from '../../lib/orgApi';
import { LockedNotice } from '../../ui/Locked';
import { PARTNER_ROLES } from '@shared/roles';
import { formatDate } from '../../lib/format';
import type { OrgInfo, TeamUser } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner } from '../../ui/Common';

export const ROLE_INFO: Record<string, { label: string; text: string }> = {
  admin: { label: 'Administrator', text: 'Everything, including the team and settings.' },
  uploader: { label: 'Uploader', text: 'Sends files and works on cases.' },
  quality: { label: 'Quality', text: 'Reviews cases, files and specifications.' },
  finance: { label: 'Finance', text: 'Sees cases and exports for invoicing.' },
  viewer: { label: 'Viewer', text: 'Can look but not change anything.' },
  kl_admin: { label: 'K Line administrator', text: 'Everything, including staff, sites, partners and the factory link.' },
  kl_intake: { label: 'K Line intake', text: 'Checks new cases, sends them to a site and puts them on hold.' },
  kl_production: { label: 'K Line production', text: 'Sees cases at their sites and updates production stages.' },
  kl_quality: { label: 'K Line quality', text: 'Reviews claims and specifications.' },
  kl_finance: { label: 'K Line finance', text: 'Sees cases and exports for invoicing.' },
};

export function RolePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="check-group">
      <legend>Roles</legend>
      {PARTNER_ROLES.map((r) => {
        const id = `role-${r}`;
        return (
          <div className="check" key={r}>
            <input id={id} type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
            <label htmlFor={id}>{ROLE_INFO[r]!.label}</label>
            <p className="hint">{ROLE_INFO[r]!.text}</p>
          </div>
        );
      })}
    </fieldset>
  );
}

export default function Team() {
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ['team'], queryFn: () => api<{ users: TeamUser[] }>('/api/team') });
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org') });
  const [invite, setInvite] = useState(false);
  const [editing, setEditing] = useState<TeamUser | null>(null);
  const [confirm, setConfirm] = useState<{ user: TeamUser; action: 'reset-mfa' | 'disable' } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api(`/api/team/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['team'] });
      setNotice({ tone: 'good', text: ({ 'resend-invite': 'Invitation sent again.', enable: 'Access restored.', disable: 'Access removed.', 'reset-mfa': 'Authenticator reset. They will set it up again at their next sign in.', unlock: 'Unlocked. They can sign in again now.' } as Record<string, string>)[v.action] ?? 'Done.' });
      setConfirm(null);
    },
    onError: (e) => { setNotice({ tone: 'bad', text: errorText(e) }); setConfirm(null); },
  });

  return (
    <div className="page">
      <PageHeader title="Team" subtitle="People in your organisation and what they can do." actions={<Button variant="primary" onClick={() => setInvite(true)}>Invite someone</Button>} />
      {org.data?.status === 'onboarding' ? <LockedNotice tone="info" what="invite people" /> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <Card>
        {team.isLoading ? <Spinner /> : null}
        {team.isError ? <Notice tone="bad">{errorText(team.error)}</Notice> : null}
        {team.data ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Roles</th><th>Status</th><th>Last sign in</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {team.data.users.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.name}</strong>{u.isYou ? <span className="muted"> (you)</span> : null}<div className="muted small">{u.email}</div></td>
                    <td>{u.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(', ')}</td>
                    <td>
                      <Badge tone={u.status === 'active' ? 'good' : u.status === 'invited' ? 'info' : 'bad'}>{u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Disabled'}</Badge>
                      {u.locked ? <div><Badge tone="warn">Locked</Badge></div> : null}
                      {u.status === 'active' && !u.mfaEnabled ? <div className="small muted">No authenticator</div> : null}
                    </td>
                    <td className="nowrap">{u.lastLoginAt ? formatDate(u.lastLoginAt) : 'Never'}</td>
                    <td>
                      {u.isYou ? null : (
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          {u.status !== 'disabled' ? <Button size="sm" onClick={() => setEditing(u)} aria-label={`Change roles for ${u.name}`}>Roles</Button> : null}
                          {u.status === 'invited' ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'resend-invite' })} aria-label={`Send the invitation again to ${u.name}`}>Resend</Button> : null}
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

      <InviteDialog open={invite} onClose={() => setInvite(false)} sites={org.data?.sites ?? []} onDone={() => { setInvite(false); qc.invalidateQueries({ queryKey: ['team'] }); setNotice({ tone: 'good', text: 'Invitation sent.' }); }} />
      <RolesDialog user={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['team'] }); setNotice({ tone: 'good', text: 'Roles changed. They will need to sign in again.' }); }} />
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

function InviteDialog({ open, onClose, onDone, sites }: { open: boolean; onClose: () => void; onDone: () => void; sites: OrgInfo['sites'] }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['uploader']);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const m = useMutation({
    mutationFn: () => api('/api/team/invite', { method: 'POST', body: { email: email.trim(), name: name.trim(), roles, ...(siteIds.length ? { siteIds } : {}) } }),
    onSuccess: () => { setEmail(''); setName(''); setRoles(['uploader']); setSiteIds([]); setError(null); setLocked(false); onDone(); },
    onError: (e) => { if (isNotApproved(e)) setLocked(true); else setError(errorText(e)); },
  });
  function submit(e: FormEvent) { e.preventDefault(); setError(null); setLocked(false); m.mutate(); }
  return (
    <Dialog open={open} title="Invite someone" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {locked ? <LockedNotice what="invite people" /> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Full name">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />}</Field>
        <RolePicker value={roles} onChange={setRoles} />
        {sites.length ? (
          <fieldset className="check-group">
            <legend>Sites (optional)</legend>
            {sites.map((s) => (
              <div className="check" key={s.id}>
                <input id={`site-${s.id}`} type="checkbox" checked={siteIds.includes(s.id)} onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))} />
                <label htmlFor={`site-${s.id}`}>{s.name}</label>
              </div>
            ))}
          </fieldset>
        ) : null}
        <p className="small muted">You will be asked for your authenticator code to confirm.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email || !name || roles.length === 0}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RolesDialog({ user, onClose, onDone }: { user: TeamUser | null; onClose: () => void; onDone: () => void }) {
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forId, setForId] = useState<string | null>(null);
  if (user && forId !== user.id) { setForId(user.id); setRoles(user.roles); setError(null); }
  const m = useMutation({
    mutationFn: () => api(`/api/team/${user!.id}/roles`, { method: 'POST', body: { roles } }),
    onSuccess: () => { setForId(null); onDone(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={!!user} title={user ? `Roles for ${user.name}` : 'Roles'} onClose={() => { setForId(null); onClose(); }}>
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <RolePicker value={roles} onChange={setRoles} />
        <p className="small muted">They are signed out everywhere when their roles change.</p>
        <div className="row-end">
          <Button onClick={() => { setForId(null); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={roles.length === 0} onClick={() => m.mutate()}>Save roles</Button>
        </div>
      </div>
    </Dialog>
  );
}

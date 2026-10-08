import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { api, errorText } from '../../lib/api';
import { isNotApproved } from '../../lib/orgApi';
import { LockedNotice } from '../../ui/Locked';
import { PARTNER_ROLES } from '@shared/roles';
import { formatDate } from '../../lib/format';
import type { OrgInfo, TeamUser } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { IfMfa } from '../../ui/IfMfa';
import { useMfaRequired } from '../../lib/orgApi';

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

export function RolePicker(props: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset class="check-group">
      <legend>Roles</legend>
      <For each={PARTNER_ROLES}>
        {(r) => {
          const id = `role-${r}`;
          return (
            <div class="check">
              <input id={id} type="checkbox" checked={props.value.includes(r)} onChange={(e) => props.onChange(e.currentTarget.checked ? [...props.value, r] : props.value.filter((x) => x !== r))} />
              <label for={id}>{ROLE_INFO[r]!.label}</label>
              <p class="hint">{ROLE_INFO[r]!.text}</p>
            </div>
          );
        }}
      </For>
    </fieldset>
  );
}

export default function Team() {
  const qc = useQueryClient();
  const mfa = useMfaRequired();
  const team = createQuery(() => ({ queryKey: ['team'], queryFn: () => api<{ users: TeamUser[] }>('/api/team') }));
  const org = createQuery(() => ({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org') }));
  const [invite, setInvite] = createSignal(false);
  const [editing, setEditing] = createSignal<TeamUser | null>(null);
  const [confirm, setConfirm] = createSignal<{ user: TeamUser; action: 'reset-mfa' | 'disable' } | null>(null);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const act = createMutation(() => ({
    mutationFn: ({ id, action }: { id: string; action: string }) => api(`/api/team/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d: unknown, v: { id: string; action: string }) => {
      qc.invalidateQueries({ queryKey: ['team'] });
      setNotice({ tone: 'good', text: ({ 'resend-invite': 'Invitation sent again.', enable: 'Access restored.', disable: 'Access removed.', 'reset-mfa': 'Authenticator reset. They will set it up again at their next sign in.', unlock: 'Unlocked. They can sign in again now.' } as Record<string, string>)[v.action] ?? 'Done.' });
      setConfirm(null);
    },
    onError: (e: unknown) => { setNotice({ tone: 'bad', text: errorText(e) }); setConfirm(null); },
  }));

  return (
    <div class="page">
      <PageHeader title="Team" subtitle="People in your organisation and what they can do." actions={<Button variant="primary" onClick={() => setInvite(true)}>Invite someone</Button>} />
      <Show when={org.data?.status === 'onboarding'}><LockedNotice tone="info" what="invite people" /></Show>
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <Card>
        <Show when={team.isLoading}><Spinner /></Show>
        <Show when={team.isError}><Notice tone="bad">{errorText(team.error)}</Notice></Show>
        <Show when={team.data}>
          {(t) => (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Name</th><th>Roles</th><th>Status</th><th>Last sign in</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  <For each={t().users}>
                    {(u) => (
                      <tr>
                        <td><strong>{u.name}</strong>{u.isYou ? <span class="muted"> (you)</span> : null}<div class="muted small">{u.email}</div></td>
                        <td>{u.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(', ')}</td>
                        <td>
                          <Badge tone={u.status === 'active' ? 'good' : u.status === 'invited' ? 'info' : 'bad'}>{u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Disabled'}</Badge>
                          <Show when={u.locked}><div><Badge tone="warn">Locked</Badge></div></Show>
                          <Show when={mfa() && u.status === 'active' && !u.mfaEnabled}><div class="small muted">No authenticator</div></Show>
                        </td>
                        <td class="nowrap">{u.lastLoginAt ? formatDate(u.lastLoginAt) : 'Never'}</td>
                        <td>
                          <Show when={!u.isYou}>
                            <div class="row" style={{ gap: '6px', 'justify-content': 'flex-end' }}>
                              <Show when={u.status !== 'disabled'}><Button size="sm" onClick={() => setEditing(u)} aria-label={`Change roles for ${u.name}`}>Roles</Button></Show>
                              <Show when={u.status === 'invited'}><Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'resend-invite' })} aria-label={`Send the invitation again to ${u.name}`}>Resend</Button></Show>
                              <Show when={u.locked}><Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'unlock' })} aria-label={`Unlock ${u.name}`}>Unlock</Button></Show>
                              <Show when={mfa() && u.status === 'active'}><Button size="sm" onClick={() => setConfirm({ user: u, action: 'reset-mfa' })} aria-label={`Reset the authenticator for ${u.name}`}>Reset authenticator</Button></Show>
                              <Show
                                when={u.status === 'disabled'}
                                fallback={<Button size="sm" variant="danger" onClick={() => setConfirm({ user: u, action: 'disable' })} aria-label={`Disable ${u.name}`}>Disable</Button>}
                              >
                                <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'enable' })} aria-label={`Enable ${u.name}`}>Enable</Button>
                              </Show>
                            </div>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )}
        </Show>
      </Card>

      <InviteDialog open={invite()} onClose={() => setInvite(false)} sites={org.data?.sites ?? []} onDone={() => { setInvite(false); qc.invalidateQueries({ queryKey: ['team'] }); setNotice({ tone: 'good', text: 'Invitation sent.' }); }} />
      <RolesDialog user={editing()} onClose={() => setEditing(null)} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['team'] }); setNotice({ tone: 'good', text: 'Roles changed. They will need to sign in again.' }); }} />
      <Dialog
        open={!!confirm()}
        title={confirm()?.action === 'disable' ? 'Disable this person?' : 'Reset their authenticator?'}
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" loading={act.isPending} onClick={() => { const c = confirm(); if (c) act.mutate({ id: c.user.id, action: c.action }); }}>{confirm()?.action === 'disable' ? 'Disable' : 'Reset authenticator'}</Button></>}
      >
        <p>
          {confirm()?.action === 'disable'
            ? `${confirm()?.user.name} will be signed out and cannot sign in until you enable them again.`
            : `${confirm()?.user.name} will be signed out and must set up their authenticator app again at their next sign in.`}
        </p>
      </Dialog>
    </div>
  );
}

function InviteDialog(props: { open: boolean; onClose: () => void; onDone: () => void; sites: OrgInfo['sites'] }) {
  const [email, setEmail] = createSignal('');
  const [name, setName] = createSignal('');
  const [roles, setRoles] = createSignal<string[]>(['uploader']);
  const [siteIds, setSiteIds] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [locked, setLocked] = createSignal(false);
  const m = createMutation(() => ({
    mutationFn: () => api('/api/team/invite', { method: 'POST', body: { email: email().trim(), name: name().trim(), roles: roles(), ...(siteIds().length ? { siteIds: siteIds() } : {}) } }),
    onSuccess: () => { setEmail(''); setName(''); setRoles(['uploader']); setSiteIds([]); setError(null); setLocked(false); props.onDone(); },
    onError: (e: unknown) => { if (isNotApproved(e)) setLocked(true); else setError(errorText(e)); },
  }));
  function submit(e: SubmitEvent) { e.preventDefault(); setError(null); setLocked(false); m.mutate(); }
  return (
    <Dialog open={props.open} title="Invite someone" onClose={props.onClose}>
      <form onSubmit={submit} class="stack">
        <Show when={locked()}><LockedNotice what="invite people" /></Show>
        <Show when={error()}>{(er) => <Notice tone="bad">{er()}</Notice>}</Show>
        <Field label="Full name">{(p) => <input {...p} value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxLength={120} autocomplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(p) => <input {...p} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required autocomplete="off" />}</Field>
        <RolePicker value={roles()} onChange={setRoles} />
        <Show when={props.sites.length}>
          <fieldset class="check-group">
            <legend>Sites (optional)</legend>
            <For each={props.sites}>
              {(s) => (
                <div class="check">
                  <input id={`site-${s.id}`} type="checkbox" checked={siteIds().includes(s.id)} onChange={(e) => setSiteIds(e.currentTarget.checked ? [...siteIds(), s.id] : siteIds().filter((x) => x !== s.id))} />
                  <label for={`site-${s.id}`}>{s.name}</label>
                </div>
              )}
            </For>
          </fieldset>
        </Show>
        <IfMfa><p class="small muted">You will be asked for your authenticator code to confirm.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email() || !name() || roles().length === 0}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RolesDialog(props: { user: TeamUser | null; onClose: () => void; onDone: () => void }) {
  const [roles, setRoles] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  // Start from the roles of the person being edited each time the dialog is opened for someone.
  createEffect(on(() => props.user, (u) => { if (u) { setRoles(u.roles); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/team/${props.user!.id}/roles`, { method: 'POST', body: { roles: roles() } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={!!props.user} title={props.user ? `Roles for ${props.user.name}` : 'Roles'} onClose={props.onClose}>
      <div class="stack">
        <Show when={error()}>{(er) => <Notice tone="bad">{er()}</Notice>}</Show>
        <RolePicker value={roles()} onChange={setRoles} />
        <p class="small muted">They are signed out everywhere when their roles change.</p>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={roles().length === 0} onClick={() => m.mutate()}>Save roles</Button>
        </div>
      </div>
    </Dialog>
  );
}

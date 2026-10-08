import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { KLINE_ROLES } from '@shared/roles';
import { api, errorText } from '../../lib/api';
import { useSites, type SiteRow } from '../../lib/console';
import { formatDate } from '../../lib/format';
import type { TeamUser } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { ROLE_INFO } from '../partner/Team';
import { IfMfa } from '../../ui/IfMfa';
import { useMfaRequired } from '../../lib/orgApi';

interface StaffUser extends TeamUser { siteIds?: string[]; siteCodes?: string[] }

function RoleFields(props: { roles: string[]; setRoles: (v: string[]) => void; siteIds: string[]; setSiteIds: (v: string[]) => void; sites: SiteRow[] }) {
  const production = () => props.roles.includes('kl_production');
  return (
    <>
      <fieldset class="check-group">
        <legend>Roles</legend>
        <For each={KLINE_ROLES}>
          {(r) => (
            <div class="check">
              <input id={`sr-${r}`} type="checkbox" checked={props.roles.includes(r)} onChange={(e) => props.setRoles(e.currentTarget.checked ? [...props.roles, r] : props.roles.filter((x) => x !== r))} />
              <label for={`sr-${r}`}>{ROLE_INFO[r]!.label}</label>
              <p class="hint">{ROLE_INFO[r]!.text}</p>
            </div>
          )}
        </For>
      </fieldset>
      <Show when={production()}>
        <fieldset class="check-group">
          <legend>Sites for production staff</legend>
          <p class="hint">Production staff only see and update cases at the sites you tick. With none ticked they see every site.</p>
          <For each={props.sites}>
            {(s) => (
              <div class="check">
                <input id={`ss-${s.id}`} type="checkbox" checked={props.siteIds.includes(s.id)} onChange={(e) => props.setSiteIds(e.currentTarget.checked ? [...props.siteIds, s.id] : props.siteIds.filter((x) => x !== s.id))} />
                <label for={`ss-${s.id}`}>{s.code}, {s.name}</label>
              </div>
            )}
          </For>
        </fieldset>
      </Show>
    </>
  );
}

export default function Staff() {
  const qc = useQueryClient();
  const mfa = useMfaRequired();
  const q = createQuery(() => ({ queryKey: ['staff'], queryFn: () => api<{ users: StaffUser[] }>('/api/staff') }));
  const sites = useSites();
  const [invite, setInvite] = createSignal(false);
  const [editing, setEditing] = createSignal<StaffUser | null>(null);
  const [confirm, setConfirm] = createSignal<{ user: StaffUser; action: 'reset-mfa' | 'disable' } | null>(null);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const siteList = () => sites.data?.sites ?? [];
  const codeFor = (u: StaffUser) => u.siteCodes ?? (u.siteIds ?? []).map((id) => siteList().find((s) => s.id === id)?.code).filter((x): x is string => !!x);

  const act = createMutation(() => ({
    mutationFn: ({ id, action }: { id: string; action: string }) => api(`/api/staff/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d: unknown, v: { id: string; action: string }) => {
      qc.invalidateQueries({ queryKey: ['staff'] });
      setNotice({ tone: 'good', text: ({ 'resend-invite': 'Invitation sent again.', enable: 'Access restored.', disable: 'Access removed.', 'reset-mfa': 'Authenticator reset. They will set it up again at their next sign in.', unlock: 'Unlocked. They can sign in again now.' } as Record<string, string>)[v.action] ?? 'Done.' });
      setConfirm(null);
    },
    onError: (e: unknown) => { setNotice({ tone: 'bad', text: errorText(e) }); setConfirm(null); },
  }));

  return (
    <div class="page">
      <PageHeader title="Staff" subtitle="K Line people and what they can do." actions={<Button variant="primary" onClick={() => setInvite(true)}>Invite someone</Button>} />
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <Card>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data}>
          {(d) => (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Name</th><th>Roles</th><th>Sites</th><th>Status</th><th>Last sign in</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  <For each={d().users}>
                    {(u) => (
                      <tr>
                        <td><strong>{u.name}</strong>{u.isYou ? <span class="muted"> (you)</span> : null}<div class="muted small">{u.email}</div></td>
                        <td>{u.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(', ')}</td>
                        <td>{u.roles.includes('kl_production') ? (codeFor(u).length ? codeFor(u).join(', ') : <span class="muted">All sites</span>) : <span class="muted">Not used</span>}</td>
                        <td>
                          <Badge tone={u.status === 'active' ? 'good' : u.status === 'invited' ? 'info' : 'bad'}>{u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Disabled'}</Badge>
                          {u.locked ? <div><Badge tone="warn">Locked</Badge></div> : null}
                          {mfa() && u.status === 'active' && !u.mfaEnabled ? <div class="small muted">No authenticator</div> : null}
                        </td>
                        <td class="nowrap">{u.lastLoginAt ? formatDate(u.lastLoginAt) : 'Never'}</td>
                        <td>
                          {u.isYou ? null : (
                            <div class="row" style={{ gap: '6px', 'justify-content': 'flex-end' }}>
                              {u.status === 'invited' ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'resend-invite' })} aria-label={`Send the invitation again to ${u.name}`}>Resend</Button> : null}
                              {u.status !== 'disabled' ? <Button size="sm" onClick={() => setEditing(u)} aria-label={`Change roles for ${u.name}`}>Roles</Button> : null}
                              {u.locked ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'unlock' })} aria-label={`Unlock ${u.name}`}>Unlock</Button> : null}
                              {mfa() && u.status === 'active' ? <Button size="sm" onClick={() => setConfirm({ user: u, action: 'reset-mfa' })} aria-label={`Reset the authenticator for ${u.name}`}>Reset authenticator</Button> : null}
                              {u.status === 'disabled'
                                ? <Button size="sm" onClick={() => act.mutate({ id: u.id, action: 'enable' })} aria-label={`Enable ${u.name}`}>Enable</Button>
                                : <Button size="sm" variant="danger" onClick={() => setConfirm({ user: u, action: 'disable' })} aria-label={`Disable ${u.name}`}>Disable</Button>}
                            </div>
                          )}
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

      <InviteDialog open={invite()} sites={siteList()} onClose={() => setInvite(false)} onDone={() => { setInvite(false); qc.invalidateQueries({ queryKey: ['staff'] }); setNotice({ tone: 'good', text: 'Invitation sent.' }); }} />
      <RolesDialog user={editing()} sites={siteList()} onClose={() => setEditing(null)} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['staff'] }); setNotice({ tone: 'good', text: 'Roles changed. They will need to sign in again.' }); }} />
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

function InviteDialog(props: { open: boolean; onClose: () => void; onDone: () => void; sites: SiteRow[] }) {
  const [email, setEmail] = createSignal('');
  const [name, setName] = createSignal('');
  const [roles, setRoles] = createSignal<string[]>(['kl_intake']);
  const [siteIds, setSiteIds] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setEmail(''); setName(''); setRoles(['kl_intake']); setSiteIds([]); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api('/api/staff/invite', { method: 'POST', body: { email: email().trim(), name: name().trim(), roles: roles(), siteIds: roles().includes('kl_production') ? siteIds() : [] } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title="Invite a staff member" onClose={props.onClose}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Full name">{(p) => <input {...p} value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxLength={120} autocomplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(p) => <input {...p} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required autocomplete="off" />}</Field>
        <RoleFields roles={roles()} setRoles={setRoles} siteIds={siteIds()} setSiteIds={setSiteIds} sites={props.sites} />
        <IfMfa><p class="small muted">You will be asked for your authenticator code to confirm.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email() || !name() || roles().length === 0}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RolesDialog(props: { user: StaffUser | null; sites: SiteRow[]; onClose: () => void; onDone: () => void }) {
  const [roles, setRoles] = createSignal<string[]>([]);
  const [siteIds, setSiteIds] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.user, (user) => { if (user) { setRoles(user.roles); setSiteIds(user.siteIds ?? []); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/staff/${props.user!.id}/roles`, { method: 'POST', body: { roles: roles(), siteIds: roles().includes('kl_production') ? siteIds() : [] } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={!!props.user} title={props.user ? `Roles for ${props.user.name}` : 'Roles'} onClose={props.onClose}>
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <RoleFields roles={roles()} setRoles={setRoles} siteIds={siteIds()} setSiteIds={setSiteIds} sites={props.sites} />
        <p class="small muted">They are signed out everywhere when their roles change.<IfMfa> You will be asked for your authenticator code.</IfMfa></p>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={roles().length === 0} onClick={() => m.mutate()}>Save roles</Button>
        </div>
      </div>
    </Dialog>
  );
}

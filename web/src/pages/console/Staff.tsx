import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { api, errorText } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { TeamUser } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { IfMfa } from '../../ui/IfMfa';
import { useMfaRequired } from '../../lib/orgApi';

export default function Staff() {
  const qc = useQueryClient();
  const mfa = useMfaRequired();
  const q = createQuery(() => ({ queryKey: ['staff'], queryFn: () => api<{ users: TeamUser[] }>('/api/staff') }));
  const [invite, setInvite] = createSignal(false);
  const [confirm, setConfirm] = createSignal<{ user: TeamUser; action: 'reset-mfa' | 'disable' } | null>(null);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

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
      <PageHeader title="Staff" subtitle="K Line people. Everyone here is a K Line administrator." actions={<Button variant="primary" onClick={() => setInvite(true)}>Invite someone</Button>} />
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <Card>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data}>
          {(d) => (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Name</th><th>Status</th><th>Last sign in</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  <For each={d().users}>
                    {(u) => (
                      <tr>
                        <td><strong>{u.name}</strong>{u.isYou ? <span class="muted"> (you)</span> : null}<div class="muted small">{u.email}</div></td>
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

      <InviteDialog open={invite()} onClose={() => setInvite(false)} onDone={() => { setInvite(false); qc.invalidateQueries({ queryKey: ['staff'] }); setNotice({ tone: 'good', text: 'Invitation sent.' }); }} />
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

function InviteDialog(props: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = createSignal('');
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setEmail(''); setName(''); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api('/api/staff/invite', { method: 'POST', body: { email: email().trim(), name: name().trim(), roles: ['kl_admin'] } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title="Invite a staff member" onClose={props.onClose}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Full name">{(p) => <input {...p} value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxLength={120} autocomplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(p) => <input {...p} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required autocomplete="off" />}</Field>
        <IfMfa><p class="small muted">You will be asked for your authenticator code to confirm.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email() || !name()}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

import { createSignal, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import type { SessionRow } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { CaseAddressCard } from './CaseAddressCard';
import { RecoveryCodes } from '../../ui/RecoveryCodes';
import { ROLE_INFO } from './Team';
import { PASSWORD_HINT } from '../auth/ResetPassword';
import { useMfaRequired } from '../../lib/orgApi';

function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
  return `${browser} on ${os}`;
}

function NotificationSettings() {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['account-notifications'], queryFn: () => api<{ email: boolean }>('/api/account/notifications') }));
  const [note, setNote] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const save = createMutation(() => ({
    mutationFn: (email: boolean) => api<{ email: boolean }>('/api/account/notifications', { method: 'PUT', body: { email } }),
    onSuccess: (r: { email: boolean } | undefined, email: boolean) => {
      qc.setQueryData(['account-notifications'], { email: typeof r?.email === 'boolean' ? r.email : email });
      setNote({ tone: 'good', text: (typeof r?.email === 'boolean' ? r.email : email) ? 'Email notifications are on.' : 'Email notifications are off. You will still see notices in the bell.' });
    },
    onError: (e: unknown) => setNote({ tone: 'bad', text: errorText(e) }),
  }));
  return (
    <Card title="Notifications">
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data}>
        {(d) => (
          <div class="stack">
            <Toggle
              checked={d().email}
              disabled={save.isPending}
              onChange={(v) => { setNote(null); save.mutate(v); }}
              label="Email notifications"
              hint="We email you short messages about cases, holds, claims and specifications. They only show references and link to the platform. They never show patient names. Notices in the bell always stay on."
            />
            <div role="status"><Show when={note()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show></div>
          </div>
        )}
      </Show>
    </Card>
  );
}

export default function Account() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [cur, setCur] = createSignal('');
  const [pw, setPw] = createSignal('');
  const [pw2, setPw2] = createSignal('');
  const [pwMsg, setPwMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const [confirmCodes, setConfirmCodes] = createSignal(false);
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const sessions = createQuery(() => ({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionRow[] }>('/api/auth/sessions') }));

  const change = createMutation(() => ({
    mutationFn: () => api('/api/auth/password/change', { method: 'POST', body: { currentPassword: cur(), newPassword: pw() } }),
    onSuccess: () => { setCur(''); setPw(''); setPw2(''); setPwMsg({ tone: 'good', text: 'Your password has been changed. Other devices were signed out.' }); qc.invalidateQueries({ queryKey: ['sessions'] }); },
    onError: (e: unknown) => setPwMsg({ tone: 'bad', text: errorText(e) }),
  }));
  function submitPw(e: SubmitEvent) {
    e.preventDefault();
    if (pw() !== pw2()) { setPwMsg({ tone: 'bad', text: 'The two passwords do not match.' }); return; }
    setPwMsg(null);
    change.mutate();
  }

  const revoke = createMutation(() => ({
    mutationFn: (id: string) => api(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: async (_d: unknown, id: string) => {
      const s = sessions.data?.sessions.find((x) => x.id === id);
      if (s?.current) { await refresh(); nav('/login', { replace: true }); return; }
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));
  const revokeOthers = createMutation(() => ({
    mutationFn: () => api<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST', body: {} }),
    onSuccess: (r: { revoked: number }) => { setMsg({ tone: 'good', text: r.revoked ? `Signed out of ${r.revoked} other ${r.revoked === 1 ? 'device' : 'devices'}.` : 'There were no other devices.' }); qc.invalidateQueries({ queryKey: ['sessions'] }); },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));
  const mfa = useMfaRequired();
  const regen = createMutation(() => ({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/api/auth/recovery-codes/regenerate', { method: 'POST', body: {} }),
    onSuccess: (r: { recoveryCodes: string[] }) => { setConfirmCodes(false); setCodes(r.recoveryCodes); refresh(); },
    onError: (e: unknown) => { setConfirmCodes(false); setMsg({ tone: 'bad', text: errorText(e) }); },
  }));

  return (
    <div class="page">
      <PageHeader title="Account" subtitle="Your details, password and sign in security." />
      <Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
      <div class="grid-2">
        <Card title="Your details">
          <dl class="facts">
            <dt>Name</dt><dd>{me()?.user.name}</dd>
            <dt>Email address</dt><dd>{me()?.user.email}</dd>
            <dt>Organisation</dt><dd>{me()?.org?.name}</dd>
            <dt>Roles</dt><dd>{me()?.user.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(', ')}</dd>
          </dl>
          <p class="small muted">To change your name or email address, ask an administrator in your organisation.</p>
        </Card>

        <Card title="Change password">
          <form onSubmit={submitPw} class="stack">
            <Show when={pwMsg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
            <Field label="Current password">{(p) => <input {...p} type="password" value={cur()} onInput={(e) => setCur(e.currentTarget.value)} autocomplete="current-password" required />}</Field>
            <Field label="New password" hint={PASSWORD_HINT}>{(p) => <input {...p} type="password" value={pw()} onInput={(e) => setPw(e.currentTarget.value)} autocomplete="new-password" minLength={12} required />}</Field>
            <Field label="Repeat the new password">{(p) => <input {...p} type="password" value={pw2()} onInput={(e) => setPw2(e.currentTarget.value)} autocomplete="new-password" required />}</Field>
            <div><Button type="submit" variant="primary" loading={change.isPending} disabled={!cur() || pw().length < 12}>Change password</Button></div>
          </form>
        </Card>
      </div>

      <Show when={me()?.org?.kind === 'partner'}><CaseAddressCard /></Show>

      <NotificationSettings />

      <Show when={mfa()}>
        <Card title="Recovery codes">
          <p>
            You have <strong>{me()?.user.recoveryCodesRemaining ?? 0}</strong> recovery {me()?.user.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left. Use one if you lose your phone.
          </p>
          <Show when={codes()}>{(c) => <RecoveryCodes codes={c()} />}</Show>
          <div><Button onClick={() => setConfirmCodes(true)}>Make new recovery codes</Button></div>
        </Card>
      </Show>

      <Card title="Where you are signed in" actions={<Button size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out other devices</Button>}>
        <Show when={sessions.isLoading}><Spinner /></Show>
        <Show when={sessions.data}>
          {(d) => (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Device</th><th>Last active</th><th>Started</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  <For each={d().sessions}>
                    {(s) => (
                      <tr>
                        <td>{deviceLabel(s.userAgent as string | null)} {s.current ? <Badge tone="good">This device</Badge> : null}{s.ip ? <div class="muted small">{String(s.ip)}</div> : null}</td>
                        <td class="nowrap">{formatDateTime(s.lastSeenAt as string)}</td>
                        <td class="nowrap">{formatDateTime(s.createdAt as string)}</td>
                        <td class="right"><Button size="sm" onClick={() => revoke.mutate(s.id)}>{s.current ? 'Sign out' : 'End session'}</Button></td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )}
        </Show>
      </Card>

      <Dialog open={confirmCodes()} title="Make new recovery codes?" onClose={() => setConfirmCodes(false)} footer={<><Button onClick={() => setConfirmCodes(false)}>Cancel</Button><Button variant="primary" loading={regen.isPending} onClick={() => regen.mutate()}>Make new codes</Button></>}>
        <p>Your old codes will stop working. You will be asked for your authenticator code.</p>
      </Dialog>
    </div>
  );
}

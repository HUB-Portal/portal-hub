import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import type { SessionRow } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { CaseAddressCard } from './CaseAddressCard';
import { RecoveryCodes } from '../../ui/RecoveryCodes';
import { ROLE_INFO } from './Team';
import { PASSWORD_HINT } from '../auth/ResetPassword';

function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
  return `${browser} on ${os}`;
}

function NotificationSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['account-notifications'], queryFn: () => api<{ email: boolean }>('/api/account/notifications') });
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const save = useMutation({
    mutationFn: (email: boolean) => api<{ email: boolean }>('/api/account/notifications', { method: 'PUT', body: { email } }),
    onSuccess: (r, email) => {
      qc.setQueryData(['account-notifications'], { email: typeof r?.email === 'boolean' ? r.email : email });
      setNote({ tone: 'good', text: (typeof r?.email === 'boolean' ? r.email : email) ? 'Email notifications are on.' : 'Email notifications are off. You will still see notices in the bell.' });
    },
    onError: (e) => setNote({ tone: 'bad', text: errorText(e) }),
  });
  return (
    <Card title="Notifications">
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data ? (
        <div className="stack">
          <Toggle
            checked={q.data.email}
            disabled={save.isPending}
            onChange={(v) => { setNote(null); save.mutate(v); }}
            label="Email notifications"
            hint="We email you short messages about cases, holds, claims and specifications. They only show references and link to the platform. They never show patient names. Notices in the bell always stay on."
          />
          <div role="status">{note ? <Notice tone={note.tone}>{note.text}</Notice> : null}</div>
        </div>
      ) : null}
    </Card>
  );
}

export default function Account() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwMsg, setPwMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmCodes, setConfirmCodes] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionRow[] }>('/api/auth/sessions') });

  const change = useMutation({
    mutationFn: () => api('/api/auth/password/change', { method: 'POST', body: { currentPassword: cur, newPassword: pw } }),
    onSuccess: () => { setCur(''); setPw(''); setPw2(''); setPwMsg({ tone: 'good', text: 'Your password has been changed. Other devices were signed out.' }); qc.invalidateQueries({ queryKey: ['sessions'] }); },
    onError: (e) => setPwMsg({ tone: 'bad', text: errorText(e) }),
  });
  function submitPw(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setPwMsg({ tone: 'bad', text: 'The two passwords do not match.' }); return; }
    setPwMsg(null);
    change.mutate();
  }

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: async (_d, id) => {
      const s = sessions.data?.sessions.find((x) => x.id === id);
      if (s?.current) { await refresh(); nav('/login', { replace: true }); return; }
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST', body: {} }),
    onSuccess: (r) => { setMsg({ tone: 'good', text: r.revoked ? `Signed out of ${r.revoked} other ${r.revoked === 1 ? 'device' : 'devices'}.` : 'There were no other devices.' }); qc.invalidateQueries({ queryKey: ['sessions'] }); },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });
  const regen = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/api/auth/recovery-codes/regenerate', { method: 'POST', body: {} }),
    onSuccess: (r) => { setConfirmCodes(false); setCodes(r.recoveryCodes); refresh(); },
    onError: (e) => { setConfirmCodes(false); setMsg({ tone: 'bad', text: errorText(e) }); },
  });

  return (
    <div className="page">
      <PageHeader title="Account" subtitle="Your details, password and sign in security." />
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <div className="grid-2">
        <Card title="Your details">
          <dl className="facts">
            <dt>Name</dt><dd>{me?.user.name}</dd>
            <dt>Email address</dt><dd>{me?.user.email}</dd>
            <dt>Organisation</dt><dd>{me?.org?.name}</dd>
            <dt>Roles</dt><dd>{me?.user.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(', ')}</dd>
          </dl>
          <p className="small muted">To change your name or email address, ask an administrator in your organisation.</p>
        </Card>

        <Card title="Change password">
          <form onSubmit={submitPw} className="stack">
            {pwMsg ? <Notice tone={pwMsg.tone}>{pwMsg.text}</Notice> : null}
            <Field label="Current password">{(p) => <input {...p} type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />}</Field>
            <Field label="New password" hint={PASSWORD_HINT}>{(p) => <input {...p} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} required />}</Field>
            <Field label="Repeat the new password">{(p) => <input {...p} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />}</Field>
            <div><Button type="submit" variant="primary" loading={change.isPending} disabled={!cur || pw.length < 12}>Change password</Button></div>
          </form>
        </Card>
      </div>

      {me?.org?.kind === 'partner' ? <CaseAddressCard /> : null}

      <NotificationSettings />

      <Card title="Recovery codes">
        <p>
          You have <strong>{me?.user.recoveryCodesRemaining ?? 0}</strong> recovery {me?.user.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left. Use one if you lose your phone.
        </p>
        {codes ? <RecoveryCodes codes={codes} /> : null}
        <div><Button onClick={() => setConfirmCodes(true)}>Make new recovery codes</Button></div>
      </Card>

      <Card title="Where you are signed in" actions={<Button size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out other devices</Button>}>
        {sessions.isLoading ? <Spinner /> : null}
        {sessions.data ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Device</th><th>Last active</th><th>Started</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {sessions.data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{deviceLabel(s.userAgent as string | null)} {s.current ? <Badge tone="good">This device</Badge> : null}{s.ip ? <div className="muted small">{String(s.ip)}</div> : null}</td>
                    <td className="nowrap">{formatDateTime(s.lastSeenAt as string)}</td>
                    <td className="nowrap">{formatDateTime(s.createdAt as string)}</td>
                    <td className="right"><Button size="sm" onClick={() => revoke.mutate(s.id)}>{s.current ? 'Sign out' : 'End session'}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Dialog open={confirmCodes} title="Make new recovery codes?" onClose={() => setConfirmCodes(false)} footer={<><Button onClick={() => setConfirmCodes(false)}>Cancel</Button><Button variant="primary" loading={regen.isPending} onClick={() => regen.mutate()}>Make new codes</Button></>}>
        <p>Your old codes will stop working. You will be asked for your authenticator code.</p>
      </Dialog>
    </div>
  );
}

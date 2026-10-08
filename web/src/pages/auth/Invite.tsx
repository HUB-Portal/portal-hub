import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice, Spinner } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT } from './ResetPassword';
import { useMfaRequired } from '../../lib/orgApi';

export default function Invite() {
  const mfa = useMfaRequired();
  const { token = '' } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<{ email: string; name: string; orgName: string }>(`/api/auth/invite/${encodeURIComponent(token)}`, { quiet401: true }),
    retry: false,
  });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string }>('/api/auth/invite/accept', { method: 'POST', body: { token, password: pw }, quiet401: true });
      setCsrf(r.csrfToken);
      const me = await refresh();
      nav(homeFor(me), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (info.isLoading) return <AuthLayout title="Accept your invitation"><Spinner /></AuthLayout>;
  if (info.isError || !info.data) {
    return (
      <AuthLayout title="Accept your invitation">
        <Notice tone="bad">{info.error instanceof ApiError ? info.error.message : 'This invitation is not valid or has expired. Ask for a new one.'}</Notice>
        <p className="small"><Link to="/login">Go to sign in</Link></p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={`Welcome to ${info.data.orgName}`} intro={`Hello ${info.data.name}. Choose a password for ${info.data.email}.${mfa ? ' Next you will set up your authenticator app.' : ''}`}>
      <form onSubmit={submit} className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Password" hint={PASSWORD_HINT}>
          {(p) => <input {...p} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus />}
        </Field>
        <Field label="Repeat the password">
          {(p) => <input {...p} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={pw.length < 12}>Continue</Button>
      </form>
    </AuthLayout>
  );
}

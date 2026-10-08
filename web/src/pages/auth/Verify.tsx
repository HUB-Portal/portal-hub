import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice, Spinner } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT } from './ResetPassword';
import { useMfaRequired } from '../../lib/orgApi';

interface VerifyInfo { email: string; name: string; orgName?: string; valid?: boolean }

export default function Verify() {
  const mfa = useMfaRequired();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const { refresh } = useAuth();
  const info = useQuery({
    queryKey: ['verify', token],
    enabled: !!token,
    queryFn: () => api<VerifyInfo>(`/api/auth/verify/${encodeURIComponent(token)}`, { quiet401: true }),
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
      const r = await api<{ csrfToken?: string }>('/api/auth/verify', { method: 'POST', body: { token, password: pw }, quiet401: true });
      if (r?.csrfToken) setCsrf(r.csrfToken);
      const me = await refresh();
      nav(homeFor(me), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const invalid = (
    <AuthLayout title="Confirm your email address">
      <Notice tone="bad">
        {info.error instanceof ApiError && info.error.status !== 404 ? info.error.message : 'This link is not valid or has expired. Register again to get a new one.'}
      </Notice>
      <p className="small"><Link to="/register">Register your company</Link> or <Link to="/login">go to sign in</Link></p>
    </AuthLayout>
  );

  if (!token) return invalid;
  if (info.isLoading) return <AuthLayout title="Confirm your email address"><Spinner /></AuthLayout>;
  if (info.isError || !info.data || info.data.valid === false) return invalid;

  const first = info.data.name.trim().split(/\s+/)[0] ?? '';
  return (
    <AuthLayout
      title="Confirm your email address"
      intro={`${first ? `Hello ${first}. ` : ''}Choose a password for ${info.data.email}.${mfa ? ' Next you will set up your authenticator app.' : ''} After that, K Line reviews your company.`}
    >
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

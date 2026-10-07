import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { usePublicConfig } from '../../lib/orgApi';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';

interface DemoAccounts {
  password: string;
  accounts: { email: string; name: string; roles: string[]; orgName: string; orgKind: string; code?: string; secondsLeft?: number }[];
}

export default function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const googleFailed = params.get('error') === 'google';
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const config = usePublicConfig();
  const demo = useQuery({
    queryKey: ['demo-accounts'],
    queryFn: () => api<DemoAccounts>('/api/demo/accounts', { quiet401: true }),
    retry: false,
    refetchInterval: (q) => (q.state.data ? 5000 : false),
    staleTime: 0,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ stage: string; csrfToken: string }>('/api/auth/login', { method: 'POST', body: { email: email.trim(), password }, quiet401: true });
      setCsrf(r.csrfToken);
      const me = await refresh();
      nav(homeFor(me), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in" intro={config.data?.mfaRequired === false ? 'Use your work email address and password.' : 'Use your work email address and password. You will be asked for a code from your authenticator app next.'}>
      <form onSubmit={submit} className="stack" noValidate>
        {googleFailed && !error ? <Notice tone="bad">We could not sign you in with Google. Use your email and password, or ask an administrator to check your account.</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Email address">
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />}
        </Field>
        <Field label="Password">
          {(p) => <input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>Sign in</Button>
        <p className="small"><Link to="/forgot-password">Forgot your password?</Link></p>
        {config.data?.signupEnabled ? <p className="small">New to the Portal Hub? <Link to="/register">Register your company</Link></p> : null}
        <p className="small"><Link to="/getting-started">How it works</Link></p>
      </form>

      {config.data?.googleSignIn ? (
        <div className="stack-sm">
          <div className="or-divider" role="separator"><span>or</span></div>
          <a className="btn" href="/api/auth/oidc/google/start">Sign in with Google (K Line staff)</a>
          <p className="small muted">For K Line staff only. Partners sign in with their email address and password.</p>
        </div>
      ) : null}

      {demo.data ? (
        <div className="demo-box">
          <strong>Demo accounts</strong>
          <p className="small muted">Choose one to fill in the form. The current authenticator code is shown so you can continue.</p>
          <div className="demo-list">
            {demo.data.accounts.map((a) => (
              <button key={a.email} type="button" className="demo-item" onClick={() => { setEmail(a.email); setPassword(demo.data!.password); setError(null); }}>
                <span>
                  <strong>{a.email}</strong>
                  <br /><span className="small muted">{a.orgName}, {a.roles.join(', ')}</span>
                </span>
                {a.code ? <span className="mono" aria-label={`Current code ${a.code}`}>{a.code}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </AuthLayout>
  );
}

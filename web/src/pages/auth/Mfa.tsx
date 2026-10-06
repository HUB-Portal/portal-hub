import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';

export default function Mfa() {
  const nav = useNavigate();
  const { me, refresh, signOut } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Demo mode only: keep the shown code fresh.
  const demoOn = me?.demo.enabled;
  useEffect(() => {
    if (!demoOn) return;
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [demoOn, refresh]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ csrfToken: string }>(recovery ? '/api/auth/mfa/recovery' : '/api/auth/mfa/verify', { method: 'POST', body: { code: code.trim() }, quiet401: true });
      setCsrf(r.csrfToken);
      const next = await refresh();
      nav(homeFor(next), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await refresh();
        nav('/login', { replace: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function other() {
    await signOut();
    nav('/login', { replace: true });
  }

  return (
    <AuthLayout
      title={recovery ? 'Use a recovery code' : 'Enter your code'}
      intro={recovery ? 'Enter one of the recovery codes you saved when you set up your authenticator. Each code works once.' : 'Open your authenticator app and enter the 6 digit code for Portal Hub.'}
    >
      <form onSubmit={submit} className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label={recovery ? 'Recovery code' : 'Authenticator code'}>
          {(p) => (
            <input {...p} value={code} onChange={(e) => setCode(e.target.value)} className={recovery ? undefined : 'code-input'} inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" maxLength={24} required autoFocus />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6}>Continue</Button>
      </form>
      {me?.demo.code ? (
        <Notice tone="info" title="Demo mode">
          The current code is <strong className="mono">{me.demo.code.code}</strong>. It changes in {me.demo.code.secondsLeft} seconds.
        </Notice>
      ) : null}
      <div className="row">
        <Button variant="ghost" size="sm" onClick={() => { setRecovery((v) => !v); setCode(''); setError(null); }}>
          {recovery ? 'Use my authenticator app' : 'Use a recovery code instead'}
        </Button>
        <Button variant="ghost" size="sm" onClick={other}>Use a different account</Button>
      </div>
    </AuthLayout>
  );
}

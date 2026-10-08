import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';
import { useMfaRequired } from '../../lib/orgApi';

export const PASSWORD_HINT = 'Use at least 12 characters. Do not use your name or email address, or a common password.';

export default function ResetPassword() {
  const mfa = useMfaRequired();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/password/reset', { method: 'POST', body: { token, newPassword: pw }, quiet401: true });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Choose a new password">
        <Notice tone="bad">This link is not complete. Ask for a new one.</Notice>
        <p className="small"><Link to="/forgot-password">Ask for a new link</Link></p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" intro={mfa ? 'After this you will sign in again with your authenticator app.' : 'After this you will sign in again with your new password.'}>
      {done ? (
        <>
          <Notice tone="good">Your password has been changed.</Notice>
          <Link className="btn btn-primary" to="/login">Go to sign in</Link>
        </>
      ) : (
        <form onSubmit={submit} className="stack">
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Field label="New password" hint={PASSWORD_HINT}>
            {(p) => <input {...p} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus />}
          </Field>
          <Field label="Repeat the new password">
            {(p) => <input {...p} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={pw.length < 12}>Change password</Button>
        </form>
      )}
    </AuthLayout>
  );
}

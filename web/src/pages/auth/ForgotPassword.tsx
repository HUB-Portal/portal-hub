import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message?: string }>('/api/auth/password/forgot', { method: 'POST', body: { email: email.trim() }, quiet401: true });
      setDone(r?.message ?? 'If that email address has an account, we have sent a link to reset the password.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Reset your password" intro="Enter your email address and we will send you a link.">
      {done ? (
        <Notice tone="good">{done}</Notice>
      ) : (
        <form onSubmit={submit} className="stack">
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Field label="Email address">
            {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!email}>Send the link</Button>
        </form>
      )}
      <p className="small"><Link to="/login">Back to sign in</Link></p>
    </AuthLayout>
  );
}

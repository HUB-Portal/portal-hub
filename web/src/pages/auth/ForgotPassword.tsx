import { createSignal, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { api, ApiError } from '../../lib/api';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';

export default function ForgotPassword() {
  const [email, setEmail] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message?: string }>('/api/auth/password/forgot', { method: 'POST', body: { email: email().trim() }, quiet401: true });
      setDone(r?.message ?? 'If that email address has an account, we have sent a link to reset the password.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Reset your password" intro="Enter your email address and we will send you a link.">
      <Show
        when={done()}
        fallback={
          <form onSubmit={submit} class="stack">
            <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
            <Field label="Email address">
              {(p) => <input {...p} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} autocomplete="username" required autofocus />}
            </Field>
            <Button type="submit" variant="primary" loading={busy()} disabled={!email()}>Send the link</Button>
          </form>
        }
      >
        <Notice tone="good">{done()}</Notice>
      </Show>
      <p class="small"><A href="/login">Back to sign in</A></p>
    </AuthLayout>
  );
}

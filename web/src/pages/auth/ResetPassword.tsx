import { createSignal, Show } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { api, ApiError } from '../../lib/api';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';
import { useMfaRequired } from '../../lib/orgApi';

export const PASSWORD_HINT = 'Use at least 12 characters. Do not use your name or email address, or a common password.';

export default function ResetPassword() {
  const mfa = useMfaRequired();
  const [params] = useSearchParams();
  const token = () => (Array.isArray(params.token) ? params.token[0] : params.token) ?? '';
  const [pw, setPw] = createSignal('');
  const [pw2, setPw2] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (pw() !== pw2()) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/password/reset', { method: 'POST', body: { token: token(), newPassword: pw() }, quiet401: true });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show
      when={token()}
      fallback={
        <AuthLayout title="Choose a new password">
          <Notice tone="bad">This link is not complete. Ask for a new one.</Notice>
          <p class="small"><A href="/forgot-password">Ask for a new link</A></p>
        </AuthLayout>
      }
    >
      <AuthLayout title="Choose a new password" intro={mfa() ? 'After this you will sign in again with your authenticator app.' : 'After this you will sign in again with your new password.'}>
        <Show
          when={done()}
          fallback={
            <form onSubmit={submit} class="stack">
              <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
              <Field label="New password" hint={PASSWORD_HINT}>
                {(p) => <input {...p} type="password" value={pw()} onInput={(e) => setPw(e.currentTarget.value)} autocomplete="new-password" minLength={12} required autofocus />}
              </Field>
              <Field label="Repeat the new password">
                {(p) => <input {...p} type="password" value={pw2()} onInput={(e) => setPw2(e.currentTarget.value)} autocomplete="new-password" required />}
              </Field>
              <Button type="submit" variant="primary" loading={busy()} disabled={pw().length < 12}>Change password</Button>
            </form>
          }
        >
          <Notice tone="good">Your password has been changed.</Notice>
          <A class="btn btn-primary" href="/login">Go to sign in</A>
        </Show>
      </AuthLayout>
    </Show>
  );
}

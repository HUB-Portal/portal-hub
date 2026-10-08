import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';

export default function Mfa() {
  const nav = useNavigate();
  const { me, refresh, signOut } = useAuth();
  const [recovery, setRecovery] = createSignal(false);
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Demo mode only: keep the shown code fresh.
  const demoOn = () => me()?.demo.enabled;
  createEffect(() => {
    if (!demoOn()) return;
    const t = setInterval(() => { void refresh(); }, 5000);
    onCleanup(() => clearInterval(t));
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ csrfToken: string }>(recovery() ? '/api/auth/mfa/recovery' : '/api/auth/mfa/verify', { method: 'POST', body: { code: code().trim() }, quiet401: true });
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
      title={recovery() ? 'Use a recovery code' : 'Enter your code'}
      intro={recovery() ? 'Enter one of the recovery codes you saved when you set up your authenticator. Each code works once.' : 'Open your authenticator app and enter the 6 digit code for Portal Hub.'}
    >
      <form onSubmit={submit} class="stack">
        <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
        <Field label={recovery() ? 'Recovery code' : 'Authenticator code'}>
          {(p) => (
            <input {...p} value={code()} onInput={(e) => setCode(e.currentTarget.value)} class={recovery() ? undefined : 'code-input'} inputMode={recovery() ? 'text' : 'numeric'} autocomplete="one-time-code" maxLength={24} required autofocus />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy()} disabled={code().trim().length < 6}>Continue</Button>
      </form>
      <Show when={me()?.demo.code}>
        {(c) => (
          <Notice tone="info" title="Demo mode">
            The current code is <strong class="mono">{c().code}</strong>. It changes in {c().secondsLeft} seconds.
          </Notice>
        )}
      </Show>
      <div class="row">
        <Button variant="ghost" size="sm" onClick={() => { setRecovery((v) => !v); setCode(''); setError(null); }}>
          {recovery() ? 'Use my authenticator app' : 'Use a recovery code instead'}
        </Button>
        <Button variant="ghost" size="sm" onClick={other}>Use a different account</Button>
      </div>
    </AuthLayout>
  );
}

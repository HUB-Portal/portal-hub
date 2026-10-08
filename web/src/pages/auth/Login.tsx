import { createSignal, For, Show } from 'solid-js';
import { A, useNavigate, useSearchParams } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
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
  const googleFailed = () => params.error === 'google';
  const { refresh } = useAuth();
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const config = usePublicConfig();
  const mfa = () => !!config.data?.mfaRequired;
  const demo = createQuery(() => ({
    queryKey: ['demo-accounts'],
    queryFn: () => api<DemoAccounts>('/api/demo/accounts', { quiet401: true }),
    retry: false,
    refetchInterval: (q) => (q.state.data ? 5000 : false),
    staleTime: 0,
  }));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ stage: string; csrfToken: string }>('/api/auth/login', { method: 'POST', body: { email: email().trim(), password: password() }, quiet401: true });
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
    <AuthLayout title="Sign in" intro={mfa() ? 'Use your work email address and password. You will be asked for a code from your authenticator app next.' : 'Use your work email address and password.'}>
      <form onSubmit={submit} class="stack" noValidate>
        <Show when={googleFailed() && !error()}><Notice tone="bad">We could not sign you in with Google. Use your email and password, or ask an administrator to check your account.</Notice></Show>
        <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
        <Field label="Email address">
          {(p) => <input {...p} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} autocomplete="username" required autofocus />}
        </Field>
        <Field label="Password">
          {(p) => <input {...p} type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} autocomplete="current-password" required />}
        </Field>
        <Button type="submit" variant="primary" loading={busy()} disabled={!email() || !password()}>Sign in</Button>
        <p class="small"><A href="/forgot-password">Forgot your password?</A></p>
        <Show when={config.data?.signupEnabled}><p class="small">New to the Portal Hub? <A href="/register">Register your company</A></p></Show>
        <p class="small"><A href="/getting-started">How it works</A></p>
      </form>

      <Show when={config.data?.googleSignIn}>
        <div class="stack-sm">
          <div class="or-divider" role="separator"><span>or</span></div>
          <a class="btn" href="/api/auth/oidc/google/start">Sign in with Google (K Line staff)</a>
          <p class="small muted">For K Line staff only. Partners sign in with their email address and password.</p>
        </div>
      </Show>

      <Show when={demo.data}>
        {(d) => (
          <div class="demo-box">
            <strong>Demo accounts</strong>
            <p class="small muted">{mfa() ? 'Choose one to fill in the form. The current authenticator code is shown so you can continue.' : 'Choose one to fill in the form.'}</p>
            <div class="demo-list">
              <For each={d().accounts}>
                {(a) => (
                  <button type="button" class="demo-item" onClick={() => { setEmail(a.email); setPassword(d().password); setError(null); }}>
                    <span>
                      <strong>{a.email}</strong>
                      <br /><span class="small muted">{a.orgName}, {a.roles.join(', ')}</span>
                    </span>
                    {mfa() && a.code ? <span class="mono" aria-label={`Current code ${a.code}`}>{a.code}</span> : null}
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </AuthLayout>
  );
}

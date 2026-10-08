import { createSignal, Match, Show, Switch } from 'solid-js';
import { A, useNavigate, useSearchParams } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice, Spinner } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT } from './ResetPassword';
import { useMfaRequired } from '../../lib/orgApi';

interface VerifyInfo { email: string; name: string; orgName?: string; valid?: boolean }

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

export default function Verify() {
  const mfa = useMfaRequired();
  const [params] = useSearchParams();
  const token = () => (Array.isArray(params.token) ? params.token[0] : params.token) ?? '';
  const nav = useNavigate();
  const { refresh } = useAuth();
  const info = createQuery(() => ({
    queryKey: ['verify', token()],
    enabled: !!token(),
    queryFn: () => api<VerifyInfo>(`/api/auth/verify/${encodeURIComponent(token())}`, { quiet401: true }),
    retry: false,
  }));
  const [pw, setPw] = createSignal('');
  const [pw2, setPw2] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (pw() !== pw2()) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken?: string }>('/api/auth/verify', { method: 'POST', body: { token: token(), password: pw() }, quiet401: true });
      if (r?.csrfToken) setCsrf(r.csrfToken);
      const me = await refresh();
      nav(homeFor(me), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const invalid = () => (
    <AuthLayout title="Confirm your email address">
      <Notice tone="bad">
        {info.error instanceof ApiError && info.error.status !== 404 ? info.error.message : 'This link is not valid or has expired. Register again to get a new one.'}
      </Notice>
      <p class="small"><A href="/register">Register your company</A> or <A href="/login">go to sign in</A></p>
    </AuthLayout>
  );

  return (
    <Switch>
      <Match when={!token()}>{invalid()}</Match>
      <Match when={info.isLoading}>
        <AuthLayout title="Confirm your email address"><Spinner /></AuthLayout>
      </Match>
      <Match when={info.isError || !info.data || info.data.valid === false}>{invalid()}</Match>
      <Match when={info.data}>
        {(d) => (
          <AuthLayout
            title="Confirm your email address"
            intro={`${firstName(d().name) ? `Hello ${firstName(d().name)}. ` : ''}Choose a password for ${d().email}.${mfa() ? ' Next you will set up your authenticator app.' : ''} After that, K Line reviews your company.`}
          >
            <form onSubmit={submit} class="stack">
              <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
              <Field label="Password" hint={PASSWORD_HINT}>
                {(p) => <input {...p} type="password" value={pw()} onInput={(e) => setPw(e.currentTarget.value)} autocomplete="new-password" minLength={12} required autofocus />}
              </Field>
              <Field label="Repeat the password">
                {(p) => <input {...p} type="password" value={pw2()} onInput={(e) => setPw2(e.currentTarget.value)} autocomplete="new-password" required />}
              </Field>
              <Button type="submit" variant="primary" loading={busy()} disabled={pw().length < 12}>Continue</Button>
            </form>
          </AuthLayout>
        )}
      </Match>
    </Switch>
  );
}

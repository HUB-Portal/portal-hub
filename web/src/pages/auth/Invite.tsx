import { createSignal, Match, Show, Switch } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice, Spinner } from '../../ui/Common';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT } from './ResetPassword';
import { useMfaRequired } from '../../lib/orgApi';

export default function Invite() {
  const mfa = useMfaRequired();
  const params = useParams();
  const token = () => params.token ?? '';
  const nav = useNavigate();
  const { refresh } = useAuth();
  const info = createQuery(() => ({
    queryKey: ['invite', token()],
    queryFn: () => api<{ email: string; name: string; orgName: string }>(`/api/auth/invite/${encodeURIComponent(token())}`, { quiet401: true }),
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
      const r = await api<{ csrfToken: string }>('/api/auth/invite/accept', { method: 'POST', body: { token: token(), password: pw() }, quiet401: true });
      setCsrf(r.csrfToken);
      const me = await refresh();
      nav(homeFor(me), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Switch>
      <Match when={info.isLoading}>
        <AuthLayout title="Accept your invitation"><Spinner /></AuthLayout>
      </Match>
      <Match when={info.isError || !info.data}>
        <AuthLayout title="Accept your invitation">
          <Notice tone="bad">{info.error instanceof ApiError ? info.error.message : 'This invitation is not valid or has expired. Ask for a new one.'}</Notice>
          <p class="small"><A href="/login">Go to sign in</A></p>
        </AuthLayout>
      </Match>
      <Match when={info.data}>
        {(d) => (
          <AuthLayout title={`Welcome to ${d().orgName}`} intro={`Hello ${d().name}. Choose a password for ${d().email}.${mfa() ? ' Next you will set up your authenticator app.' : ''}`}>
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

import { createSignal, onMount, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice, Spinner, Toggle } from '../../ui/Common';
import { RecoveryCodes } from '../../ui/RecoveryCodes';
import { AuthLayout } from './AuthLayout';

interface Setup { secret: string; otpauthUri: string; qrDataUrl: string }

export default function MfaSetup() {
  const nav = useNavigate();
  const { me, refresh, signOut } = useAuth();
  const [setup, setSetup] = createSignal<Setup | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const [saved, setSaved] = createSignal(false);

  onMount(() => {
    api<Setup>('/api/auth/mfa/setup', { method: 'POST', body: {} })
      .then(setSetup)
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : 'We could not start the setup. Please try again.'));
  });

  async function confirm(e: SubmitEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string; recoveryCodes: string[] }>('/api/auth/mfa/setup/confirm', { method: 'POST', body: { code: code().trim() }, quiet401: true });
      setCsrf(r.csrfToken);
      setCodes(r.recoveryCodes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { nav('/login', { replace: true }); return; }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    const next = await refresh();
    nav(homeFor(next), { replace: true });
  }

  return (
    <Show
      when={codes()}
      fallback={
        <AuthLayout title="Set up your authenticator" intro="Two step sign in keeps patient data safe. It takes about a minute." wide>
          <Show when={loadError()}><Notice tone="bad">{loadError()}</Notice></Show>
          <Show when={!setup() && !loadError()}><Spinner label="Preparing your setup" /></Show>
          <Show when={setup()}>
            {(s) => (
              <div class="stack">
                <ol class="stack-sm" style={{ 'padding-left': '20px', margin: '0' }}>
                  <li>Install an authenticator app on your phone if you do not have one.</li>
                  <li>Scan this picture with the app.</li>
                  <li>Enter the 6 digit code the app shows.</li>
                </ol>
                <div class="row" style={{ 'align-items': 'flex-start', gap: '20px' }}>
                  <img class="qr" src={s().qrDataUrl} alt="QR code for your authenticator app" width={200} height={200} />
                  <div class="stack-sm" style={{ 'min-width': '200px', flex: '1' }}>
                    <p class="small muted">Cannot scan? Type this key into the app instead.</p>
                    <code class="mono" style={{ 'word-break': 'break-all', 'user-select': 'all' }}>{s().secret}</code>
                  </div>
                </div>
                <form onSubmit={confirm} class="stack">
                  <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
                  <Field label="Authenticator code">
                    {(p) => <input {...p} class="code-input" value={code()} onInput={(e) => setCode(e.currentTarget.value)} inputMode="numeric" autocomplete="one-time-code" maxLength={12} required />}
                  </Field>
                  <Button type="submit" variant="primary" loading={busy()} disabled={code().trim().length < 6}>Confirm and continue</Button>
                </form>
                <Show when={me()?.demo.code}>{(c) => <Notice tone="info" title="Demo mode">The current code for this account is <strong class="mono">{c().code}</strong>.</Notice>}</Show>
              </div>
            )}
          </Show>
          <Button variant="ghost" size="sm" onClick={async () => { await signOut(); nav('/login', { replace: true }); }}>Sign out</Button>
        </AuthLayout>
      }
    >
      {(list) => (
        <AuthLayout title="Your authenticator is ready" intro="Keep your recovery codes somewhere safe, such as a password manager." wide>
          <RecoveryCodes codes={list()} />
          <Toggle checked={saved()} onChange={setSaved} label="I have saved my recovery codes" />
          <Button variant="primary" disabled={!saved()} onClick={finish}>Continue to the hub</Button>
        </AuthLayout>
      )}
    </Show>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setCsrf } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { Button, Field, Notice, Spinner, Toggle } from '../../ui/Common';
import { RecoveryCodes } from '../../ui/RecoveryCodes';
import { AuthLayout } from './AuthLayout';

interface Setup { secret: string; otpauthUri: string; qrDataUrl: string }

export default function MfaSetup() {
  const nav = useNavigate();
  const { me, refresh, signOut } = useAuth();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<Setup>('/api/auth/mfa/setup', { method: 'POST', body: {} })
      .then(setSetup)
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : 'We could not start the setup. Please try again.'));
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string; recoveryCodes: string[] }>('/api/auth/mfa/setup/confirm', { method: 'POST', body: { code: code.trim() }, quiet401: true });
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

  if (codes) {
    return (
      <AuthLayout title="Your authenticator is ready" intro="Keep your recovery codes somewhere safe, such as a password manager." wide>
        <RecoveryCodes codes={codes} />
        <Toggle checked={saved} onChange={setSaved} label="I have saved my recovery codes" />
        <Button variant="primary" disabled={!saved} onClick={finish}>Continue to the hub</Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set up your authenticator" intro="Two step sign in keeps patient data safe. It takes about a minute." wide>
      {loadError ? <Notice tone="bad">{loadError}</Notice> : null}
      {!setup && !loadError ? <Spinner label="Preparing your setup" /> : null}
      {setup ? (
        <div className="stack">
          <ol className="stack-sm" style={{ paddingLeft: 20, margin: 0 }}>
            <li>Install an authenticator app on your phone if you do not have one.</li>
            <li>Scan this picture with the app.</li>
            <li>Enter the 6 digit code the app shows.</li>
          </ol>
          <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
            <img className="qr" src={setup.qrDataUrl} alt="QR code for your authenticator app" width={200} height={200} />
            <div className="stack-sm" style={{ minWidth: 200, flex: 1 }}>
              <p className="small muted">Cannot scan? Type this key into the app instead.</p>
              <code className="mono" style={{ wordBreak: 'break-all', userSelect: 'all' }}>{setup.secret}</code>
            </div>
          </div>
          <form onSubmit={confirm} className="stack">
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Authenticator code">
              {(p) => <input {...p} className="code-input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={12} required />}
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6}>Confirm and continue</Button>
          </form>
          {me?.demo.code ? <Notice tone="info" title="Demo mode">The current code for this account is <strong className="mono">{me.demo.code.code}</strong>.</Notice> : null}
        </div>
      ) : null}
      <Button variant="ghost" size="sm" onClick={async () => { await signOut(); nav('/login', { replace: true }); }}>Sign out</Button>
    </AuthLayout>
  );
}

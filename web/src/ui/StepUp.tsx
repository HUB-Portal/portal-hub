import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, registerStepUp } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, Field } from './Common';

/** Global authenticator prompt. Mounted once; api() calls it when the server answers step_up_required. */
export function StepUpHost() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void)[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    setCode('');
    setError(null);
    const list = pending.current;
    pending.current = [];
    list.forEach((f) => f(ok));
  }, []);

  useEffect(() => {
    registerStepUp(() => new Promise<boolean>((resolve) => {
      pending.current.push(resolve);
      setOpen(true);
    }));
    return () => registerStepUp(null);
  }, []);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/step-up', { method: 'POST', body: { code: code.trim() } });
      qc.invalidateQueries({ queryKey: ['me'] });
      finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setCode('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Confirm it is you" onClose={() => finish(false)}>
      <form onSubmit={submit} className="stack">
        <p>This action needs a fresh code from your authenticator app.</p>
        <Field label="Authenticator code" error={error}>
          {(p) => (
            <input
              {...p}
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              required
              className="code-input"
            />
          )}
        </Field>
        <div className="row-end">
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6}>Confirm</Button>
        </div>
      </form>
    </Dialog>
  );
}

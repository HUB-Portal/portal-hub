import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { api, ApiError, registerStepUp } from '../lib/api';
import { useQueryClient } from '@tanstack/solid-query';
import { Button, Dialog, Field } from './Common';

/** Global authenticator prompt. Mounted once; api() calls it when the server answers step_up_required. */
export function StepUpHost() {
  const qc = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let pending: ((ok: boolean) => void)[] = [];
  let inputRef: HTMLInputElement | undefined;

  function finish(ok: boolean) {
    setOpen(false);
    setCode('');
    setError(null);
    const list = pending;
    pending = [];
    list.forEach((f) => f(ok));
  }

  onMount(() => {
    registerStepUp(() => new Promise<boolean>((resolve) => {
      pending.push(resolve);
      setOpen(true);
    }));
  });
  onCleanup(() => registerStepUp(null));

  createEffect(on(open, (o) => { if (o) setTimeout(() => inputRef?.focus(), 50); }));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/step-up', { method: 'POST', body: { code: code().trim() } });
      qc.invalidateQueries({ queryKey: ['me'] });
      finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setCode('');
      inputRef?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open()} title="Confirm it is you" onClose={() => finish(false)}>
      <form onSubmit={submit} class="stack">
        <p>This action needs a fresh code from your authenticator app.</p>
        <Field label="Authenticator code" error={error()}>
          {(p) => (
            <input
              {...p}
              ref={inputRef}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              inputMode="numeric"
              autocomplete="one-time-code"
              maxLength={12}
              required
              class="code-input"
            />
          )}
        </Field>
        <div class="row-end">
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy()} disabled={code().trim().length < 6}>Confirm</Button>
        </div>
      </form>
    </Dialog>
  );
}

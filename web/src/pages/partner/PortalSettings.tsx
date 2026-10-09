import { createEffect, createSignal, type JSX, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { api, errorText } from '../../lib/api';
import { Button, Card, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { PortalWebhookCard, type PortalWebhookInfo } from './PortalWebhookCard';
import { IfMfa } from '../../ui/IfMfa';

export interface PortalApi { configured: boolean; baseUrl: string | null; userUuid: string | null; doctorId: string | null; webhook?: PortalWebhookInfo }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The form for one organisation's K Line portal credentials. A partner uses it on its own page (`/api/org/portal-api`);
 * K Line staff use it for a partner (`/api/partners/:id/portal-api`). `who` names the company in the staff wording.
 */
export function PortalForm(props: { path: string; queryKey: unknown[]; who?: string; extra?: (d: PortalApi) => JSX.Element }) {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: props.queryKey, queryFn: () => api<PortalApi>(props.path) }));
  const [baseUrl, setBaseUrl] = createSignal('');
  const [apiKey, setApiKey] = createSignal('');
  const [userUuid, setUserUuid] = createSignal('');
  const [doctorId, setDoctorId] = createSignal('');
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [test, setTest] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  createEffect(() => {
    const d = q.data;
    if (d) { setBaseUrl(d.baseUrl ?? ''); setUserUuid(d.userUuid ?? ''); setDoctorId(d.doctorId ?? ''); }
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: props.queryKey }); qc.invalidateQueries({ queryKey: ['portal-connections'] }); };
  const save = createMutation(() => ({
    mutationFn: () => api(props.path, { method: 'PUT', body: { baseUrl: baseUrl().trim(), apiKey: apiKey(), userUuid: userUuid().trim(), ...(doctorId().trim() ? { doctorId: doctorId().trim() } : {}) } }),
    onSuccess: () => { setApiKey(''); setMsg({ tone: 'good', text: 'Saved. The API key is stored encrypted and will not be shown again.' }); refresh(); },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));
  const ping = createMutation(() => ({
    mutationFn: () => api<{ ok?: boolean; message?: string }>(`${props.path}/test`, { method: 'POST', body: {} }),
    onSuccess: (r: { ok?: boolean; message?: string } | undefined) => setTest({ tone: r?.ok === false ? 'bad' : 'good', text: r?.ok === false ? (r.message ?? 'The connection test failed.') : 'The connection works.' }),
    onError: (e: unknown) => setTest({ tone: 'bad', text: errorText(e) }),
  }));

  const urlOk = () => /^https:\/\/\S+$/i.test(baseUrl().trim());
  const uuidOk = () => UUID.test(userUuid().trim());
  const canSave = () => urlOk() && uuidOk() && apiKey().length >= 8;

  function submit(e: SubmitEvent) { e.preventDefault(); setMsg(null); save.mutate(); }

  return (
    <>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data}>
        {(d) => (
          <>
            <Card>
              <Notice tone={d().configured ? 'good' : 'warn'}>
                {d().configured
                  ? 'A connection is saved. Enter a new API key to change it.'
                  : props.who ? `No connection is saved yet. ${props.who} cannot send direct manufacturing cases until you add one.` : 'No connection is saved yet. Direct manufacturing cases cannot be sent until you add one.'}
              </Notice>
              <Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
              <form onSubmit={submit} class="stack">
                <Field label="Portal address" hint={props.who ? 'Starts with https://. The address of the K Line portal API.' : 'Starts with https://. Ask K Line for the address of your portal API.'}>
                  {(p) => <input {...p} type="url" value={baseUrl()} onInput={(e) => setBaseUrl(e.currentTarget.value)} placeholder="https://" autocomplete="off" required />}
                </Field>
                <Field label="API key" hint="Shown once. We store it encrypted and never display it again.">
                  {(p) => <input {...p} type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} autocomplete="new-password" required />}
                </Field>
                <Field label="User ID" hint={props.who ? 'The portal user UUID of this company.' : 'The user UUID that K Line gave you.'} error={userUuid() && !uuidOk() ? 'This does not look like a user ID.' : null}>
                  {(p) => <input {...p} value={userUuid()} onInput={(e) => setUserUuid(e.currentTarget.value)} autocomplete="off" required />}
                </Field>
                <Field label="Doctor ID (optional)">
                  {(p) => <input {...p} value={doctorId()} onInput={(e) => setDoctorId(e.currentTarget.value)} autocomplete="off" />}
                </Field>
                <IfMfa><p class="small muted">You will be asked for your authenticator code when you save.</p></IfMfa>
                <div class="row">
                  <Button type="submit" variant="primary" loading={save.isPending} disabled={!canSave()}>Save connection</Button>
                  <Button onClick={() => { setTest(null); ping.mutate(); }} loading={ping.isPending} disabled={!d().configured}>Test connection</Button>
                </div>
                <Show when={test()}>{(t) => <Notice tone={t().tone}>{t().text}</Notice>}</Show>
              </form>
            </Card>
            {props.extra?.(d())}
          </>
        )}
      </Show>
    </>
  );
}

export default function PortalSettings() {
  return (
    <div class="page page-narrow">
      <PageHeader title="Portal connection" subtitle="Settings for sending direct manufacturing cases to the K Line customer portal." />
      <PortalForm path="/api/org/portal-api" queryKey={['portal-api']} extra={(d) => <Show when={d.webhook}>{(w) => <PortalWebhookCard webhook={w()} />}</Show>} />
    </div>
  );
}

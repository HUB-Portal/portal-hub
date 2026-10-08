import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { Eye, History, KeyRound, Pencil, Play, RotateCw, Trash2 } from 'lucide-solid';
import { api, errorText, qs } from '../../../lib/api';
import { formatDateTime, formatNumber, plural } from '../../../lib/format';
import {
  DELIVERY_FILTERS, deliveryBadge, disabledText, eventLabel, normalizeDeliveries, normalizeTest, normalizeWebhooks, unwrapPayload,
  WEBHOOK_EVENTS, webhookUrlProblem, type DeliveryRow, type TestResult, type WebhookRow,
} from '../../../lib/integrations';
import { isNotApproved } from '../../../lib/orgApi';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, Pagination, Spinner } from '../../../ui/Common';
import { CopyButton } from '../../../ui/CopyButton';
import { LockedNotice } from '../../../ui/Locked';
import { SecretReveal } from '../../../ui/SecretReveal';

type Flash = { tone: 'good' | 'bad'; text: string } | null;

export function WebhooksTab(props: { locked: boolean }) {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['webhooks'], queryFn: async () => normalizeWebhooks(await api<unknown>('/api/webhooks')) }));
  const [editing, setEditing] = createSignal<WebhookRow | 'new' | null>(null);
  const [secret, setSecret] = createSignal<{ value: string; url: string; rotated: boolean } | null>(null);
  const [deleting, setDeleting] = createSignal<WebhookRow | null>(null);
  const [rotating, setRotating] = createSignal<WebhookRow | null>(null);
  const [history, setHistory] = createSignal<WebhookRow | null>(null);
  const [tests, setTests] = createSignal<Record<string, TestResult | 'running' | { failed: string }>>({});
  const [flash, setFlash] = createSignal<Flash>(null);

  const lockedByServer = () => isNotApproved(q.error);
  const items = () => q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });

  const remove = createMutation(() => ({
    mutationFn: (w: WebhookRow) => api(`/api/webhooks/${w.id}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleting(null); setFlash({ tone: 'good', text: 'The webhook was deleted. Nothing more will be sent to it.' }); refresh(); },
    onError: (e: unknown) => { setDeleting(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  }));
  const rotate = createMutation(() => ({
    mutationFn: (w: WebhookRow) => api<{ secret: string }>(`/api/webhooks/${w.id}/rotate-secret`, { method: 'POST', body: {} }),
    onSuccess: (r: { secret: string }, w: WebhookRow) => { setRotating(null); setSecret({ value: r.secret, url: w.url, rotated: true }); },
    onError: (e: unknown) => { setRotating(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  }));
  const reenable = createMutation(() => ({
    mutationFn: (w: WebhookRow) => api(`/api/webhooks/${w.id}`, { method: 'PATCH', body: { active: true } }),
    onSuccess: () => { setFlash({ tone: 'good', text: 'The webhook is on again. New events will be sent to it.' }); refresh(); },
    onError: (e: unknown) => setFlash({ tone: 'bad', text: errorText(e) }),
  }));

  async function runTest(w: WebhookRow) {
    setTests((t) => ({ ...t, [w.id]: 'running' }));
    try {
      const r = normalizeTest(await api<unknown>(`/api/webhooks/${w.id}/test`, { method: 'POST', body: {} }));
      setTests((t) => ({ ...t, [w.id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [w.id]: { failed: errorText(e) } }));
    }
  }

  return (
    <>
      <Card title="Webhooks" actions={<Button variant="primary" disabled={props.locked || lockedByServer()} onClick={() => { setEditing('new'); setFlash(null); }}>Add a webhook</Button>}>
        <p class="muted">
          A webhook tells your system when something happens, for example when a case ships. We send a short message to your address. It holds references and counts only. It never holds patient names.
        </p>
        <Show when={props.locked || lockedByServer()}><LockedNotice what="add webhooks" tone="info" /></Show>
        <Show when={flash()}>{(f) => <Notice tone={f().tone}>{f().text}</Notice>}</Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError && !lockedByServer()}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data && items().length === 0}><Empty title="No webhooks yet">Add one to get a message whenever a case changes.</Empty></Show>
        <Show when={items().length}>
          <ul class="wh-list" aria-label="Webhooks">
            <For each={items()}>
              {(w) => {
                const t = () => tests()[w.id];
                return (
                  <li class={`wh-item${w.active ? '' : ' wh-off'}`}>
                    <div class="row" style={{ 'justify-content': 'space-between', 'align-items': 'flex-start' }}>
                      <div style={{ 'min-width': '0' }}>
                        <div class="wh-url mono">{w.url}</div>
                        <Show when={w.description}><div class="muted small">{w.description}</div></Show>
                      </div>
                      <Badge tone={w.active ? 'good' : 'warn'}>{w.active ? 'On' : 'Off'}</Badge>
                    </div>
                    <Show when={!w.active}>
                      <Notice
                        tone="warn"
                        title="This webhook is switched off"
                        action={<Button size="sm" variant="primary" loading={reenable.isPending && reenable.variables?.id === w.id} onClick={() => reenable.mutate(w)}>Turn it on again</Button>}
                      >
                        {disabledText(w.disabledReason)} No events are sent while it is off. Check that your address works, use Send a test, then turn it on again.
                        {w.disabledAt ? ` Switched off on ${formatDateTime(w.disabledAt)}.` : ''}
                      </Notice>
                    </Show>
                    <div class="inline-badges" aria-label="Events sent">
                      <For each={w.events}>{(ev) => <Badge title={ev}>{eventLabel(ev)}</Badge>}</For>
                    </div>
                    <div class="wh-meta">
                      <span>Last delivery: {w.lastDeliveryAt ? <>{formatDateTime(w.lastDeliveryAt)}{w.lastStatus ? <>, {deliveryBadge(w.lastStatus).label.toLowerCase()}</> : null}{w.lastStatusCode ? ` (${w.lastStatusCode})` : ''}</> : 'none yet'}</span>
                      <span>Failed in a row: {formatNumber(w.failures)}</span>
                    </div>
                    <div class="wh-actions">
                      <Button size="sm" onClick={() => setHistory(w)}><History size={15} aria-hidden="true" /> Deliveries</Button>
                      <Button size="sm" onClick={() => runTest(w)} loading={t() === 'running'}><Play size={15} aria-hidden="true" /> Send a test</Button>
                      <Button size="sm" disabled={props.locked} onClick={() => { setEditing(w); setFlash(null); }}><Pencil size={15} aria-hidden="true" /> Edit</Button>
                      <Button size="sm" disabled={props.locked} onClick={() => setRotating(w)}><KeyRound size={15} aria-hidden="true" /> New secret</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(w)} aria-label={`Delete webhook ${w.url}`}><Trash2 size={15} aria-hidden="true" /> Delete</Button>
                    </div>
                    <Show when={t()}>
                      {(r) => <Show when={r() !== 'running'}><TestOutcome result={r() as TestResult | { failed: string }} /></Show>}
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Card>

      <WebhookDialog
        target={editing()}
        onClose={() => setEditing(null)}
        onSaved={(res) => {
          const wasNew = editing() === 'new';
          const url = res.url;
          setEditing(null);
          refresh();
          if (wasNew && res.secret) setSecret({ value: res.secret, url, rotated: false });
          else setFlash({ tone: 'good', text: 'The webhook was saved.' });
        }}
      />
      <SecretReveal
        open={!!secret()}
        title={secret()?.rotated ? 'Copy your new signing secret now' : 'Copy your signing secret now'}
        subject={secret()?.url ?? ''}
        secret={secret()?.value ?? ''}
        kindLabel="signing secret"
        onClose={() => setSecret(null)}
      >
        <p class="small muted">
          Use it to check the signature on each message, so you know it really came from K Line. The Developer notes tab has a code example.
          {secret()?.rotated ? ' The old secret no longer works.' : ''}
        </p>
      </SecretReveal>
      <Dialog
        open={!!rotating()}
        title="Make a new signing secret?"
        onClose={() => setRotating(null)}
        footer={<><Button onClick={() => setRotating(null)}>Cancel</Button><Button variant="primary" loading={rotate.isPending} onClick={() => { const w = rotating(); if (w) rotate.mutate(w); }}>Make a new secret</Button></>}
      >
        <p>The old secret stops working straight away. Messages will fail your signature check until you update your system with the new one. You will be asked for your authenticator code.</p>
      </Dialog>
      <Dialog
        open={!!deleting()}
        title="Delete this webhook?"
        onClose={() => setDeleting(null)}
        footer={<><Button onClick={() => setDeleting(null)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => { const w = deleting(); if (w) remove.mutate(w); }}>Delete webhook</Button></>}
      >
        <p>We stop sending messages to <span class="mono">{deleting()?.url}</span> and its delivery history is removed. You will be asked for your authenticator code.</p>
      </Dialog>
      <Show when={history()}>{(h) => <DeliveriesDialog webhook={h()} onClose={() => setHistory(null)} />}</Show>
    </>
  );
}

function TestOutcome(props: { result: TestResult | { failed: string } }) {
  const failed = () => ('failed' in props.result ? props.result.failed : null);
  const r = () => props.result as TestResult;
  const ms = () => (r().durationMs !== null ? ` in ${formatNumber(Math.round(r().durationMs!))} ms` : '');
  return (
    <Show
      when={failed() === null}
      fallback={<Notice tone="bad" title="The test could not be sent">{failed()}</Notice>}
    >
      <Show
        when={r().ok}
        fallback={
          <Notice tone="bad" title="Test failed">
            {r().status ? `Your address answered with status ${r().status}${ms()}. Anything from 200 to 299 counts as success.` : `We could not get an answer${ms()}.${r().error ? ` ${r().error}` : ''} Check that the address is public, uses https and has a valid certificate.`}
          </Notice>
        }
      >
        <Notice tone="good" title="Test delivered">Your address answered with status {r().status ?? 'OK'}{ms()}.</Notice>
      </Show>
    </Show>
  );
}

// ---- create and edit ---------------------------------------------------------------------------------------------------

function WebhookDialog(props: { target: WebhookRow | 'new' | null; onClose: () => void; onSaved: (r: { secret?: string; url: string }) => void }) {
  const isNew = () => props.target === 'new';
  const existing = () => (props.target && props.target !== 'new' ? props.target : null);
  const [url, setUrl] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [events, setEvents] = createSignal<string[]>([]);
  const [active, setActive] = createSignal(true);
  const [error, setError] = createSignal<{ locked: boolean; text: string } | null>(null);

  createEffect(on(() => props.target, (target) => {
    if (!target) return;
    setError(null);
    if (target === 'new') { setUrl('https://'); setDescription(''); setEvents(['case.shipped']); setActive(true); }
    else { setUrl(target.url); setDescription(target.description ?? ''); setEvents(target.events); setActive(target.active); }
  }));

  const problem = () => webhookUrlProblem(url());
  const canSave = () => url().trim().length > 8 && !problem() && events().length > 0;

  const save = createMutation(() => ({
    mutationFn: () => {
      const base = { url: url().trim(), events: WEBHOOK_EVENTS.map((e) => e.id).filter((id) => events().includes(id)) };
      const note = description().trim();
      return isNew()
        ? api<{ secret?: string }>('/api/webhooks', { method: 'POST', body: { ...base, ...(note ? { description: note } : {}) } })
        : api<{ secret?: string }>(`/api/webhooks/${existing()!.id}`, { method: 'PATCH', body: { ...base, description: note, active: active() } });
    },
    onSuccess: (r: { secret?: string } | undefined) => { const u = url().trim(); props.onSaved({ url: u, ...(r?.secret ? { secret: r.secret } : {}) }); save.reset(); },
    onError: (e: unknown) => setError({ locked: isNotApproved(e), text: errorText(e) }),
  }));

  return (
    <Dialog open={!!props.target} title={isNew() ? 'Add a webhook' : 'Edit webhook'} onClose={props.onClose} wide>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}>
        <Show when={error()}>
          {(er) => <Show when={er().locked} fallback={<Notice tone="bad">{er().text}</Notice>}><LockedNotice what="change webhooks" /></Show>}
        </Show>
        <Field
          label="Address to send messages to"
          hint="Must start with https:// and be reachable from the internet. Addresses on private or local networks are refused."
          error={problem()}
        >
          {(f) => <input {...f} type="url" value={url()} maxLength={500} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="https://erp.example.com/hooks/kline" required autocomplete="off" spellcheck={false} />}
        </Field>
        <Field label="Note (optional)" hint="Something to help you remember what this is for.">
          {(f) => <input {...f} value={description()} maxLength={200} onInput={(e) => setDescription(e.currentTarget.value)} autocomplete="off" />}
        </Field>
        <fieldset class="check-group">
          <legend>Send a message when</legend>
          <div class="event-grid">
            <For each={WEBHOOK_EVENTS}>
              {(ev) => {
                const id = `ev-${ev.id.replace(/[._]/g, '-')}`;
                return (
                  <div class="check">
                    <input id={id} type="checkbox" checked={events().includes(ev.id)} onChange={(e) => setEvents(e.currentTarget.checked ? [...events(), ev.id] : events().filter((x) => x !== ev.id))} aria-describedby={`${id}-h`} />
                    <label for={id}>{ev.label}</label>
                    <p class="hint" id={`${id}-h`}>{ev.text}</p>
                  </div>
                );
              }}
            </For>
          </div>
          <Show when={events().length === 0}><p class="field-error" role="alert">Choose at least one event.</p></Show>
        </fieldset>
        <Show when={!isNew()}><div class="check"><input id="wh-active" type="checkbox" checked={active()} onChange={(e) => setActive(e.currentTarget.checked)} /><label for="wh-active">Send messages to this address</label><p class="hint">Untick to pause the webhook without deleting it.</p></div></Show>
        <p class="small muted">
          {isNew() ? 'You will be asked for your authenticator code. The signing secret is shown once after you save.' : 'You will be asked for your authenticator code when you save.'} You can have up to 10 webhooks.
        </p>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!canSave()}>{isNew() ? 'Add webhook' : 'Save changes'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- delivery history --------------------------------------------------------------------------------------------------

function DeliveriesDialog(props: { webhook: WebhookRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = createSignal('');
  const [page, setPage] = createSignal(1);
  const [viewing, setViewing] = createSignal<DeliveryRow | null>(null);
  const [flash, setFlash] = createSignal<Flash>(null);

  const q = createQuery(() => ({
    queryKey: ['webhook-deliveries', props.webhook.id, status(), page()],
    queryFn: async () => normalizeDeliveries(await api<unknown>(`/api/webhooks/${props.webhook.id}/deliveries${qs({ status: status(), page: page() })}`)),
    placeholderData: (prev: ReturnType<typeof normalizeDeliveries> | undefined) => prev,
  }));
  const retry = createMutation(() => ({
    mutationFn: (d: DeliveryRow) => api(`/api/webhooks/${props.webhook.id}/deliveries/${d.id}/retry`, { method: 'POST', body: {} }),
    onSuccess: () => { setFlash({ tone: 'good', text: 'The delivery is queued to be sent again.' }); qc.invalidateQueries({ queryKey: ['webhook-deliveries', props.webhook.id] }); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
    onError: (e: unknown) => setFlash({ tone: 'bad', text: errorText(e) }),
  }));

  return (
    <>
      <Dialog open title="Delivery history" onClose={props.onClose} wide footer={<Button onClick={props.onClose}>Close</Button>}>
        <div class="stack">
          <p class="mono small" style={{ 'overflow-wrap': 'anywhere' }}>{props.webhook.url}</p>
          <p class="small muted">We try a message up to 8 times over about a day. Payloads are kept for 90 days.</p>
          <div class="tabs" role="group" aria-label="Filter by status">
            <For each={DELIVERY_FILTERS}>
              {(f) => (
                <button type="button" class="tab" aria-pressed={status() === f.id} onClick={() => { setStatus(f.id); setPage(1); }}>{f.label}</button>
              )}
            </For>
          </div>
          <Show when={flash()}>{(f) => <Notice tone={f().tone}>{f().text}</Notice>}</Show>
          <Show when={q.isLoading}><Spinner /></Show>
          <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
          <Show when={q.data && q.data.items.length === 0}><Empty title="No deliveries here">{status() ? 'Nothing matches this filter.' : 'Messages will show up here once events happen or you send a test.'}</Empty></Show>
          <Show when={q.data && q.data.items.length}>
            <div class="table-wrap">
              <table class="table">
                <caption class="sr-only">Deliveries, {plural(q.data!.total, 'result')}</caption>
                <thead><tr><th>Event</th><th>Status</th><th class="num">Tries</th><th>Answer</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  <For each={q.data!.items}>
                    {(r) => {
                      const b = deliveryBadge(r.status);
                      return (
                        <tr>
                          <td>{eventLabel(r.event)}<div class="muted small mono">{r.event}</div></td>
                          <td>
                            <Badge tone={b.tone}>{b.label}</Badge>
                            {r.deliveredAt ? <div class="muted small">{formatDateTime(r.deliveredAt)}</div> : null}
                            {r.status !== 'delivered' && r.status !== 'dead' && r.nextAttemptAt ? <div class="muted small">Next try {formatDateTime(r.nextAttemptAt)}</div> : null}
                          </td>
                          <td class="num">{formatNumber(r.attempts)}</td>
                          <td>{r.lastStatusCode ? <span class="mono">{r.lastStatusCode}</span> : <span class="muted">None</span>}{r.lastError ? <div class="small muted">{r.lastError}</div> : null}</td>
                          <td class="nowrap">{formatDateTime(r.createdAt)}</td>
                          <td class="right">
                            <div class="stack-sm" style={{ 'justify-items': 'end' }}>
                              <Button size="sm" onClick={() => setViewing(r)} aria-label={`View payload of ${eventLabel(r.event)}, ${formatDateTime(r.createdAt)}`}><Eye size={15} aria-hidden="true" /> Payload</Button>
                              <Show when={r.status !== 'pending'}>
                                <Button size="sm" loading={retry.isPending && retry.variables?.id === r.id} onClick={() => { setFlash(null); retry.mutate(r); }} aria-label={`Retry ${eventLabel(r.event)}, ${formatDateTime(r.createdAt)}`}><RotateCw size={15} aria-hidden="true" /> Retry</Button>
                              </Show>
                            </div>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
          <Show when={q.data}>{(d) => <Pagination page={d().page} pageSize={d().pageSize} total={d().total} onPage={setPage} />}</Show>
        </div>
      </Dialog>
      <Show when={viewing()}>{(v) => <PayloadDialog webhookId={props.webhook.id} delivery={v()} onClose={() => setViewing(null)} />}</Show>
    </>
  );
}

function PayloadDialog(props: { webhookId: string; delivery: DeliveryRow; onClose: () => void }) {
  const q = createQuery(() => ({
    queryKey: ['webhook-payload', props.webhookId, props.delivery.id],
    queryFn: async () => JSON.stringify(unwrapPayload(await api<unknown>(`/api/webhooks/${props.webhookId}/deliveries/${props.delivery.id}`)), null, 2),
    staleTime: 60_000,
  }));
  return (
    <Dialog open title="Message sent" onClose={props.onClose} wide footer={<Button onClick={props.onClose}>Close</Button>}>
      <div class="stack">
        <p class="small muted">{eventLabel(props.delivery.event)}, {formatDateTime(props.delivery.createdAt)}. This is exactly what your system receives in the body of the request.</p>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data}>
          {(d) => (
            <>
              <pre class="code-block" tabIndex={0} aria-label="Payload as formatted JSON">{d()}</pre>
              <CopyButton text={d()} label="Copy" what="payload" />
            </>
          )}
        </Show>
      </div>
    </Dialog>
  );
}

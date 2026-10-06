import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, History, KeyRound, Pencil, Play, RotateCw, Trash2 } from 'lucide-react';
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

export function WebhooksTab({ locked }: { locked: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: async () => normalizeWebhooks(await api<unknown>('/api/webhooks')) });
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null);
  const [secret, setSecret] = useState<{ value: string; url: string; rotated: boolean } | null>(null);
  const [deleting, setDeleting] = useState<WebhookRow | null>(null);
  const [rotating, setRotating] = useState<WebhookRow | null>(null);
  const [history, setHistory] = useState<WebhookRow | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | 'running' | { failed: string }>>({});
  const [flash, setFlash] = useState<Flash>(null);

  const lockedByServer = isNotApproved(q.error);
  const items = q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });

  const remove = useMutation({
    mutationFn: (w: WebhookRow) => api(`/api/webhooks/${w.id}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleting(null); setFlash({ tone: 'good', text: 'The webhook was deleted. Nothing more will be sent to it.' }); refresh(); },
    onError: (e) => { setDeleting(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  });
  const rotate = useMutation({
    mutationFn: (w: WebhookRow) => api<{ secret: string }>(`/api/webhooks/${w.id}/rotate-secret`, { method: 'POST', body: {} }),
    onSuccess: (r, w) => { setRotating(null); setSecret({ value: r.secret, url: w.url, rotated: true }); },
    onError: (e) => { setRotating(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  });
  const reenable = useMutation({
    mutationFn: (w: WebhookRow) => api(`/api/webhooks/${w.id}`, { method: 'PATCH', body: { active: true } }),
    onSuccess: () => { setFlash({ tone: 'good', text: 'The webhook is on again. New events will be sent to it.' }); refresh(); },
    onError: (e) => setFlash({ tone: 'bad', text: errorText(e) }),
  });

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
      <Card title="Webhooks" actions={<Button variant="primary" disabled={locked || lockedByServer} onClick={() => { setEditing('new'); setFlash(null); }}>Add a webhook</Button>}>
        <p className="muted">
          A webhook tells your system when something happens, for example when a case ships. We send a short message to your address. It holds references and counts only. It never holds patient names.
        </p>
        {locked || lockedByServer ? <LockedNotice what="add webhooks" tone="info" /> : null}
        {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.isError && !lockedByServer ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data && items.length === 0 ? <Empty title="No webhooks yet">Add one to get a message whenever a case changes.</Empty> : null}
        {items.length ? (
          <ul className="wh-list" aria-label="Webhooks">
            {items.map((w) => {
              const t = tests[w.id];
              return (
                <li key={w.id} className={`wh-item${w.active ? '' : ' wh-off'}`}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="wh-url mono">{w.url}</div>
                      {w.description ? <div className="muted small">{w.description}</div> : null}
                    </div>
                    <Badge tone={w.active ? 'good' : 'warn'}>{w.active ? 'On' : 'Off'}</Badge>
                  </div>
                  {!w.active ? (
                    <Notice
                      tone="warn"
                      title="This webhook is switched off"
                      action={<Button size="sm" variant="primary" loading={reenable.isPending && reenable.variables?.id === w.id} onClick={() => reenable.mutate(w)}>Turn it on again</Button>}
                    >
                      {disabledText(w.disabledReason)} No events are sent while it is off. Check that your address works, use Send a test, then turn it on again.
                      {w.disabledAt ? ` Switched off on ${formatDateTime(w.disabledAt)}.` : ''}
                    </Notice>
                  ) : null}
                  <div className="inline-badges" aria-label="Events sent">
                    {w.events.map((ev) => <Badge key={ev} title={ev}>{eventLabel(ev)}</Badge>)}
                  </div>
                  <div className="wh-meta">
                    <span>Last delivery: {w.lastDeliveryAt ? <>{formatDateTime(w.lastDeliveryAt)}{w.lastStatus ? <>, {deliveryBadge(w.lastStatus).label.toLowerCase()}</> : null}{w.lastStatusCode ? ` (${w.lastStatusCode})` : ''}</> : 'none yet'}</span>
                    <span>Failed in a row: {formatNumber(w.failures)}</span>
                  </div>
                  <div className="wh-actions">
                    <Button size="sm" onClick={() => setHistory(w)}><History size={15} aria-hidden="true" /> Deliveries</Button>
                    <Button size="sm" onClick={() => runTest(w)} loading={t === 'running'}><Play size={15} aria-hidden="true" /> Send a test</Button>
                    <Button size="sm" disabled={locked} onClick={() => { setEditing(w); setFlash(null); }}><Pencil size={15} aria-hidden="true" /> Edit</Button>
                    <Button size="sm" disabled={locked} onClick={() => setRotating(w)}><KeyRound size={15} aria-hidden="true" /> New secret</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(w)} aria-label={`Delete webhook ${w.url}`}><Trash2 size={15} aria-hidden="true" /> Delete</Button>
                  </div>
                  {t && t !== 'running' ? <TestOutcome result={t} /> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Card>

      <WebhookDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={(res) => {
          const wasNew = editing === 'new';
          const url = res.url;
          setEditing(null);
          refresh();
          if (wasNew && res.secret) setSecret({ value: res.secret, url, rotated: false });
          else setFlash({ tone: 'good', text: 'The webhook was saved.' });
        }}
      />
      <SecretReveal
        open={!!secret}
        title={secret?.rotated ? 'Copy your new signing secret now' : 'Copy your signing secret now'}
        subject={secret?.url ?? ''}
        secret={secret?.value ?? ''}
        kindLabel="signing secret"
        onClose={() => setSecret(null)}
      >
        <p className="small muted">
          Use it to check the signature on each message, so you know it really came from K Line. The Developer notes tab has a code example.
          {secret?.rotated ? ' The old secret no longer works.' : ''}
        </p>
      </SecretReveal>
      <Dialog
        open={!!rotating}
        title="Make a new signing secret?"
        onClose={() => setRotating(null)}
        footer={<><Button onClick={() => setRotating(null)}>Cancel</Button><Button variant="primary" loading={rotate.isPending} onClick={() => rotating && rotate.mutate(rotating)}>Make a new secret</Button></>}
      >
        <p>The old secret stops working straight away. Messages will fail your signature check until you update your system with the new one. You will be asked for your authenticator code.</p>
      </Dialog>
      <Dialog
        open={!!deleting}
        title="Delete this webhook?"
        onClose={() => setDeleting(null)}
        footer={<><Button onClick={() => setDeleting(null)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>Delete webhook</Button></>}
      >
        <p>We stop sending messages to <span className="mono">{deleting?.url}</span> and its delivery history is removed. You will be asked for your authenticator code.</p>
      </Dialog>
      {history ? <DeliveriesDialog webhook={history} onClose={() => setHistory(null)} /> : null}
    </>
  );
}

function TestOutcome({ result }: { result: TestResult | { failed: string } }) {
  if ('failed' in result) return <Notice tone="bad" title="The test could not be sent">{result.failed}</Notice>;
  const ms = result.durationMs !== null ? ` in ${formatNumber(Math.round(result.durationMs))} ms` : '';
  if (result.ok) return <Notice tone="good" title="Test delivered">Your address answered with status {result.status ?? 'OK'}{ms}.</Notice>;
  return (
    <Notice tone="bad" title="Test failed">
      {result.status ? `Your address answered with status ${result.status}${ms}. Anything from 200 to 299 counts as success.` : `We could not get an answer${ms}.${result.error ? ` ${result.error}` : ''} Check that the address is public, uses https and has a valid certificate.`}
    </Notice>
  );
}

// ---- create and edit ---------------------------------------------------------------------------------------------------

function WebhookDialog({ target, onClose, onSaved }: { target: WebhookRow | 'new' | null; onClose: () => void; onSaved: (r: { secret?: string; url: string }) => void }) {
  const isNew = target === 'new';
  const existing = target && target !== 'new' ? target : null;
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<{ locked: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!target) return;
    setError(null);
    if (target === 'new') { setUrl('https://'); setDescription(''); setEvents(['case.shipped']); setActive(true); }
    else { setUrl(target.url); setDescription(target.description ?? ''); setEvents(target.events); setActive(target.active); }
  }, [target]);

  const problem = webhookUrlProblem(url);
  const canSave = url.trim().length > 8 && !problem && events.length > 0;

  const save = useMutation({
    mutationFn: () => {
      const base = { url: url.trim(), events: WEBHOOK_EVENTS.map((e) => e.id).filter((id) => events.includes(id)) };
      const note = description.trim();
      return isNew
        ? api<{ secret?: string }>('/api/webhooks', { method: 'POST', body: { ...base, ...(note ? { description: note } : {}) } })
        : api<{ secret?: string }>(`/api/webhooks/${existing!.id}`, { method: 'PATCH', body: { ...base, description: note, active } });
    },
    onSuccess: (r) => { const u = url.trim(); onSaved({ url: u, ...(r?.secret ? { secret: r.secret } : {}) }); save.reset(); },
    onError: (e) => setError({ locked: isNotApproved(e), text: errorText(e) }),
  });

  return (
    <Dialog open={!!target} title={isNew ? 'Add a webhook' : 'Edit webhook'} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}>
        {error ? (error.locked ? <LockedNotice what="change webhooks" /> : <Notice tone="bad">{error.text}</Notice>) : null}
        <Field
          label="Address to send messages to"
          hint="Must start with https:// and be reachable from the internet. Addresses on private or local networks are refused."
          error={problem}
        >
          {(f) => <input {...f} type="url" value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://erp.example.com/hooks/kline" required autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Note (optional)" hint="Something to help you remember what this is for.">
          {(f) => <input {...f} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />}
        </Field>
        <fieldset className="check-group">
          <legend>Send a message when</legend>
          <div className="event-grid">
            {WEBHOOK_EVENTS.map((ev) => {
              const id = `ev-${ev.id.replace(/[._]/g, '-')}`;
              return (
                <div className="check" key={ev.id}>
                  <input id={id} type="checkbox" checked={events.includes(ev.id)} onChange={(e) => setEvents(e.target.checked ? [...events, ev.id] : events.filter((x) => x !== ev.id))} aria-describedby={`${id}-h`} />
                  <label htmlFor={id}>{ev.label}</label>
                  <p className="hint" id={`${id}-h`}>{ev.text}</p>
                </div>
              );
            })}
          </div>
          {events.length === 0 ? <p className="field-error" role="alert">Choose at least one event.</p> : null}
        </fieldset>
        {!isNew ? <div className="check"><input id="wh-active" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><label htmlFor="wh-active">Send messages to this address</label><p className="hint">Untick to pause the webhook without deleting it.</p></div> : null}
        <p className="small muted">
          {isNew ? 'You will be asked for your authenticator code. The signing secret is shown once after you save.' : 'You will be asked for your authenticator code when you save.'} You can have up to 10 webhooks.
        </p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!canSave}>{isNew ? 'Add webhook' : 'Save changes'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- delivery history --------------------------------------------------------------------------------------------------

function DeliveriesDialog({ webhook, onClose }: { webhook: WebhookRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<DeliveryRow | null>(null);
  const [flash, setFlash] = useState<Flash>(null);

  const q = useQuery({
    queryKey: ['webhook-deliveries', webhook.id, status, page],
    queryFn: async () => normalizeDeliveries(await api<unknown>(`/api/webhooks/${webhook.id}/deliveries${qs({ status, page })}`)),
    placeholderData: (prev) => prev,
  });
  const retry = useMutation({
    mutationFn: (d: DeliveryRow) => api(`/api/webhooks/${webhook.id}/deliveries/${d.id}/retry`, { method: 'POST', body: {} }),
    onSuccess: () => { setFlash({ tone: 'good', text: 'The delivery is queued to be sent again.' }); qc.invalidateQueries({ queryKey: ['webhook-deliveries', webhook.id] }); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
    onError: (e) => setFlash({ tone: 'bad', text: errorText(e) }),
  });

  const d = q.data;
  return (
    <>
      <Dialog open title="Delivery history" onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
        <div className="stack">
          <p className="mono small" style={{ overflowWrap: 'anywhere' }}>{webhook.url}</p>
          <p className="small muted">We try a message up to 8 times over about a day. Payloads are kept for 90 days.</p>
          <div className="tabs" role="group" aria-label="Filter by status">
            {DELIVERY_FILTERS.map((f) => (
              <button key={f.id} type="button" className="tab" aria-pressed={status === f.id} onClick={() => { setStatus(f.id); setPage(1); }}>{f.label}</button>
            ))}
          </div>
          {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}
          {q.isLoading ? <Spinner /> : null}
          {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
          {d && d.items.length === 0 ? <Empty title="No deliveries here">{status ? 'Nothing matches this filter.' : 'Messages will show up here once events happen or you send a test.'}</Empty> : null}
          {d && d.items.length ? (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Deliveries, {plural(d.total, 'result')}</caption>
                <thead><tr><th>Event</th><th>Status</th><th className="num">Tries</th><th>Answer</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {d.items.map((r) => {
                    const b = deliveryBadge(r.status);
                    return (
                      <tr key={r.id}>
                        <td>{eventLabel(r.event)}<div className="muted small mono">{r.event}</div></td>
                        <td>
                          <Badge tone={b.tone}>{b.label}</Badge>
                          {r.deliveredAt ? <div className="muted small">{formatDateTime(r.deliveredAt)}</div> : null}
                          {r.status !== 'delivered' && r.status !== 'dead' && r.nextAttemptAt ? <div className="muted small">Next try {formatDateTime(r.nextAttemptAt)}</div> : null}
                        </td>
                        <td className="num">{formatNumber(r.attempts)}</td>
                        <td>{r.lastStatusCode ? <span className="mono">{r.lastStatusCode}</span> : <span className="muted">None</span>}{r.lastError ? <div className="small muted">{r.lastError}</div> : null}</td>
                        <td className="nowrap">{formatDateTime(r.createdAt)}</td>
                        <td className="right">
                          <div className="stack-sm" style={{ justifyItems: 'end' }}>
                          <Button size="sm" onClick={() => setViewing(r)} aria-label={`View payload of ${eventLabel(r.event)}, ${formatDateTime(r.createdAt)}`}><Eye size={15} aria-hidden="true" /> Payload</Button>
                          {r.status !== 'pending' ? <Button size="sm" loading={retry.isPending && retry.variables?.id === r.id} onClick={() => { setFlash(null); retry.mutate(r); }} aria-label={`Retry ${eventLabel(r.event)}, ${formatDateTime(r.createdAt)}`}><RotateCw size={15} aria-hidden="true" /> Retry</Button> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {d ? <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /> : null}
        </div>
      </Dialog>
      {viewing ? <PayloadDialog webhookId={webhook.id} delivery={viewing} onClose={() => setViewing(null)} /> : null}
    </>
  );
}

function PayloadDialog({ webhookId, delivery, onClose }: { webhookId: string; delivery: DeliveryRow; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['webhook-payload', webhookId, delivery.id],
    queryFn: async () => JSON.stringify(unwrapPayload(await api<unknown>(`/api/webhooks/${webhookId}/deliveries/${delivery.id}`)), null, 2),
    staleTime: 60_000,
  });
  return (
    <Dialog open title="Message sent" onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        <p className="small muted">{eventLabel(delivery.event)}, {formatDateTime(delivery.createdAt)}. This is exactly what your system receives in the body of the request.</p>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data ? (
          <>
            <pre className="code-block" tabIndex={0} aria-label="Payload as formatted JSON">{q.data}</pre>
            <CopyButton text={q.data} label="Copy" what="payload" />
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

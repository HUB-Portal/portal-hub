import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { Copy } from 'lucide-solid';
import { KLINE_API_SCOPES } from '@shared/roles';
import { api, errorText } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { IfMfa } from '../../ui/IfMfa';

interface ServiceKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  cidrs: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  status: 'active' | 'expired' | 'revoked';
}

const SCOPE_INFO: Record<string, string> = {
  'mes:intake': 'List new cases and confirm receipt',
  'mes:files': 'Download case files',
  'mes:events': 'Send production events and read the stage map',
};

const CIDR_LINE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

function keyState(k: ServiceKey): { label: string; tone: 'good' | 'bad' | 'warn' } {
  if (k.status === 'revoked') return { label: 'Revoked', tone: 'bad' };
  if (k.status === 'expired') return { label: 'Expired', tone: 'warn' };
  return { label: 'Active', tone: 'good' };
}

export default function ServiceKeys() {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['service-keys'], queryFn: () => api<{ items: ServiceKey[] }>('/api/service-keys') }));
  const [creating, setCreating] = createSignal(false);
  const [created, setCreated] = createSignal<{ key: string; name: string } | null>(null);
  const [revoking, setRevoking] = createSignal<ServiceKey | null>(null);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const revoke = createMutation(() => ({
    mutationFn: (k: ServiceKey) => api(`/api/service-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRevoking(null); setNotice({ tone: 'good', text: 'The key was revoked. It stops working straight away.' }); qc.invalidateQueries({ queryKey: ['service-keys'] }); },
    onError: (e: unknown) => { setRevoking(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));

  return (
    <div class="page">
      <PageHeader title="Service keys" subtitle="Keys the factory system uses to talk to the Portal Hub. They never work on partner routes." actions={<Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Create a key</Button>} />
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <Card>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data && q.data.items.length === 0}><Empty title="No service keys yet">Create one for the factory system.</Empty></Show>
        <Show when={q.data && q.data.items.length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Key starts with</th><th>Can do</th><th>Allowed addresses</th><th>Expires</th><th>Last used</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                <For each={q.data?.items}>
                  {(k) => {
                    const s = keyState(k);
                    return (
                      <tr>
                        <td><strong>{k.name}</strong><div class="muted small">Created {formatDate(k.createdAt)}</div></td>
                        <td class="mono">{k.prefix}</td>
                        <td>{k.scopes.join(', ')}</td>
                        <td class="mono small">{k.cidrs.length ? k.cidrs.join(', ') : <span class="muted">Any address</span>}</td>
                        <td class="nowrap">{formatDate(k.expiresAt)}</td>
                        <td class="nowrap">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : 'Never'}</td>
                        <td><Badge tone={s.tone}>{s.label}</Badge></td>
                        <td class="right">{k.status !== 'revoked' ? <Button size="sm" variant="danger" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button> : null}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>

      <CreateKey open={creating()} onClose={() => setCreating(false)} onCreated={(key, name) => { setCreating(false); setCreated({ key, name }); qc.invalidateQueries({ queryKey: ['service-keys'] }); }} />
      <ShowKey created={created()} onClose={() => setCreated(null)} />
      <Dialog
        open={!!revoking()}
        title="Revoke this key?"
        onClose={() => setRevoking(null)}
        footer={<><Button onClick={() => setRevoking(null)}>Keep it</Button><Button variant="danger" loading={revoke.isPending} onClick={() => { const k = revoking(); if (k) revoke.mutate(k); }}>Revoke key</Button></>}
      >
        <p>{revoking()?.name} stops working straight away. Anything using it must be given a new key.<IfMfa> You will be asked for your authenticator code.</IfMfa></p>
      </Dialog>
    </div>
  );
}

function CreateKey(props: { open: boolean; onClose: () => void; onCreated: (key: string, name: string) => void }) {
  const [name, setName] = createSignal('');
  const [scopes, setScopes] = createSignal<string[]>([...KLINE_API_SCOPES]);
  const [cidrText, setCidrText] = createSignal('');
  const [days, setDays] = createSignal('365');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setName(''); setScopes([...KLINE_API_SCOPES]); setCidrText(''); setDays('365'); setError(null); } }));

  const cidrs = () => cidrText().split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const badCidr = () => cidrs().find((c) => !CIDR_LINE.test(c));
  const d = () => Number(days());
  const daysOk = () => Number.isInteger(d()) && d() >= 1 && d() <= 730;

  const m = createMutation(() => ({
    mutationFn: () => api<{ key: string }>('/api/service-keys', { method: 'POST', body: { name: name().trim(), scopes: scopes(), cidrs: cidrs(), expiresInDays: d() } }),
    onSuccess: (r: { key: string }) => props.onCreated(r.key, name().trim()),
    onError: (e: unknown) => setError(errorText(e)),
  }));

  return (
    <Dialog open={props.open} title="Create a service key" onClose={props.onClose} wide>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Name" hint="For example, Chaves factory MES.">{(f) => <input {...f} value={name()} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} required autocomplete="off" />}</Field>
        <fieldset class="check-group">
          <legend>What the key can do</legend>
          <For each={KLINE_API_SCOPES}>
            {(s) => (
              <div class="check">
                <input id={`scope-${s}`} type="checkbox" checked={scopes().includes(s)} onChange={(e) => setScopes(e.currentTarget.checked ? [...scopes(), s] : scopes().filter((x) => x !== s))} />
                <label for={`scope-${s}`}><span class="mono">{s}</span></label>
                <p class="hint">{SCOPE_INFO[s]}</p>
              </div>
            )}
          </For>
        </fieldset>
        <Field label="Allowed addresses (optional)" hint="One per line, for example 203.0.113.0/24. Leave empty to allow any address." error={badCidr() ? `"${badCidr()}" is not a valid address or range.` : null}>
          {(f) => <textarea {...f} class="textarea-mono" rows={3} value={cidrText()} onInput={(e) => setCidrText(e.currentTarget.value)} spellcheck={false} style={{ 'min-height': '80px' }} />}
        </Field>
        <Field label="Valid for (days)" hint="Between 1 and 730 days." error={days() && !daysOk() ? 'Enter a whole number from 1 to 730.' : null}>
          {(f) => <input {...f} type="number" min={1} max={730} value={days()} onInput={(e) => setDays(e.currentTarget.value)} required />}
        </Field>
        <p class="small muted"><IfMfa>You will be asked for your authenticator code. </IfMfa>The key is shown once.</p>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!name().trim() || scopes().length === 0 || !!badCidr() || !daysOk()}>Create key</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ShowKey(props: { created: { key: string; name: string } | null; onClose: () => void }) {
  const [copied, setCopied] = createSignal<'yes' | 'no' | null>(null);
  createEffect(on(() => props.created, () => { setCopied(null); }));
  async function copy() {
    const c = props.created;
    if (!c) return;
    try { await navigator.clipboard.writeText(c.key); setCopied('yes'); } catch { setCopied('no'); }
  }
  return (
    <Dialog open={!!props.created} title="Copy your new key now" onClose={props.onClose} dismissible={false} wide footer={<Button variant="primary" onClick={props.onClose}>I have saved the key</Button>}>
      <div class="stack">
        <Notice tone="warn" title="This is the only time you will see it">We store only a fingerprint. If you lose the key, revoke it and create a new one.</Notice>
        <p>Key for <strong>{props.created?.name}</strong></p>
        <div class="key-box" data-testid="new-service-key">{props.created?.key}</div>
        <div class="row">
          <Button onClick={copy}><Copy size={16} aria-hidden="true" /> Copy key</Button>
          <span role="status" class="small">{copied() === 'yes' ? 'Copied.' : copied() === 'no' ? 'Copying was blocked. Select the key and copy it by hand.' : ''}</span>
        </div>
      </div>
    </Dialog>
  );
}

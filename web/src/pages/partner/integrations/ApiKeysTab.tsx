import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { PARTNER_API_SCOPES } from '@shared/roles';
import { api, errorText } from '../../../lib/api';
import { formatDate, formatDateTime, plural } from '../../../lib/format';
import { daysUntil, EXPIRY_CHOICES, keyStatusBadge, normalizeKeys, parseCidrs, SCOPE_INFO, type ApiKeyRow } from '../../../lib/integrations';
import { isNotApproved } from '../../../lib/orgApi';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, Spinner } from '../../../ui/Common';
import { LockedNotice } from '../../../ui/Locked';
import { SecretReveal } from '../../../ui/SecretReveal';

interface Created { key: string; name: string; prefix: string | null; expiresAt: string | null }

export function ApiKeysTab(props: { locked: boolean }) {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['api-keys'], queryFn: async () => normalizeKeys(await api<unknown>('/api/api-keys')) }));
  const [creating, setCreating] = createSignal(false);
  const [created, setCreated] = createSignal<Created | null>(null);
  const [revoking, setRevoking] = createSignal<ApiKeyRow | null>(null);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const revoke = createMutation(() => ({
    mutationFn: (k: ApiKeyRow) => api(`/api/api-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRevoking(null); setNotice({ tone: 'good', text: 'The key was revoked. It stops working straight away.' }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: unknown) => { setRevoking(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));

  const lockedByServer = () => isNotApproved(q.error);
  const items = () => q.data ?? [];

  return (
    <>
      <Card
        title="API keys"
        actions={<Button variant="primary" disabled={props.locked || lockedByServer()} onClick={() => { setCreating(true); setNotice(null); }}>Create a key</Button>}
      >
        <p class="muted">
          An API key lets your ERP or another system work with your cases without a person signing in. Each key only does what you allow. Keep keys secret and give every system its own key.
        </p>
        <Show when={props.locked || lockedByServer()}><LockedNotice what="create API keys" tone="info" /></Show>
        <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError && !lockedByServer()}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data && items().length === 0}><Empty title="No API keys yet">Create a key when you are ready to connect a system.</Empty></Show>
        <Show when={items().length}>
          <div class="table-wrap">
            <table class="table">
              <caption class="sr-only">API keys</caption>
              <thead><tr><th>Name and key</th><th>Can do</th><th>Allowed addresses</th><th>Expires</th><th>Last used</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                <For each={items()}>
                  {(k) => {
                    const s = keyStatusBadge(k.status);
                    const left = daysUntil(k.expiresAt);
                    return (
                      <tr>
                        <td><strong>{k.name}</strong><div class="mono small" title="The start of the key. The rest is secret.">{k.prefix}...</div><div class="muted small">Created {formatDate(k.createdAt)}{k.createdByName ? ` by ${k.createdByName}` : ''}</div></td>
                        <td>
                          <span class="inline-badges">
                            <For each={k.scopes}>{(sc) => <Badge tone={sc === 'patients:read' ? 'warn' : 'neutral'} title={SCOPE_INFO[sc]?.text}>{SCOPE_INFO[sc]?.label ?? sc}</Badge>}</For>
                          </span>
                        </td>
                        <td class="mono small">{k.cidrs.length ? k.cidrs.join(', ') : <span class="muted">Any address</span>}</td>
                        <td class="nowrap">
                          {formatDate(k.expiresAt)}
                          {k.status === 'active' && left !== null && left <= 14 ? <div class="small late">{left <= 0 ? 'Expires today' : `In ${plural(left, 'day')}`}</div> : null}
                        </td>
                        <td class="nowrap">
                          {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : <span class="muted">Never</span>}
                          {k.lastUsedIp ? <div class="muted small mono">{k.lastUsedIp}</div> : null}
                        </td>
                        <td><Badge tone={s.tone}>{s.label}</Badge></td>
                        <td class="right">{k.status !== 'revoked' ? <Button size="sm" variant="danger" onClick={() => { setRevoking(k); setNotice(null); }} aria-label={`Revoke ${k.name}`}>Revoke</Button> : null}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>

      <CreateKeyDialog
        open={creating()}
        onClose={() => setCreating(false)}
        onCreated={(c) => { setCreating(false); setCreated(c); qc.invalidateQueries({ queryKey: ['api-keys'] }); }}
      />
      <SecretReveal
        open={!!created()}
        title="Copy your new API key now"
        subject={created()?.name ?? ''}
        secret={created()?.key ?? ''}
        kindLabel="key"
        onClose={() => setCreated(null)}
      >
        <p class="small muted">
          Starts with <span class="mono">{created()?.prefix}</span>. Valid until {formatDate(created()?.expiresAt)}. Send it as a Bearer token in the Authorization header.
        </p>
      </SecretReveal>
      <Dialog
        open={!!revoking()}
        title="Revoke this key?"
        onClose={() => setRevoking(null)}
        footer={<><Button onClick={() => setRevoking(null)}>Keep it</Button><Button variant="danger" loading={revoke.isPending} onClick={() => { const k = revoking(); if (k) revoke.mutate(k); }}>Revoke key</Button></>}
      >
        <p>{revoking()?.name} stops working straight away. Any system using it will need a new key. You will be asked for your authenticator code.</p>
      </Dialog>
    </>
  );
}

function CreateKeyDialog(props: { open: boolean; onClose: () => void; onCreated: (c: Created) => void }) {
  const [name, setName] = createSignal('');
  const [scopes, setScopes] = createSignal<string[]>(['cases:read']);
  const [cidrText, setCidrText] = createSignal('');
  const [days, setDays] = createSignal(365);
  const [error, setError] = createSignal<{ locked: boolean; text: string } | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setName(''); setScopes(['cases:read']); setCidrText(''); setDays(365); setError(null); } }));

  const cidr = () => parseCidrs(cidrText());
  const cidrError = () => {
    const c = cidr();
    return c.bad ? `"${c.bad}" is not a valid address or range. Use a form like 203.0.113.0/24 or 2001:db8::/32.` : c.tooMany ? 'You can add at most 20 addresses or ranges.' : null;
  };

  function toggle(scope: string, on: boolean) {
    setScopes((cur) => {
      let next = on ? [...cur, scope] : cur.filter((s) => s !== scope);
      if (on && scope === 'patients:read' && !next.includes('cases:read')) next = [...next, 'cases:read'];
      return next;
    });
  }

  const m = createMutation(() => ({
    mutationFn: () => api<{ key: string; prefix?: string; expiresAt?: string }>('/api/api-keys', {
      method: 'POST',
      body: { name: name().trim(), scopes: PARTNER_API_SCOPES.filter((s) => scopes().includes(s)), ...(cidr().list.length ? { cidrs: cidr().list } : {}), expiresInDays: days() },
    }),
    onSuccess: (r: { key: string; prefix?: string; expiresAt?: string }) => {
      props.onCreated({ key: r.key, name: name().trim(), prefix: r.prefix ?? null, expiresAt: r.expiresAt ?? null });
      m.reset();
    },
    onError: (e: unknown) => setError({ locked: isNotApproved(e), text: errorText(e) }),
  }));

  const canCreate = () => !!name().trim() && scopes().length > 0 && !cidr().bad && !cidr().tooMany;

  return (
    <Dialog open={props.open} title="Create an API key" onClose={props.onClose} wide>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>
          {(er) => <Show when={er().locked} fallback={<Notice tone="bad">{er().text}</Notice>}><LockedNotice what="create API keys" /></Show>}
        </Show>
        <Field label="Name" hint="Say which system will use it, for example Main ERP.">
          {(f) => <input {...f} value={name()} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} required autocomplete="off" />}
        </Field>
        <fieldset class="check-group">
          <legend>What the key can do</legend>
          <div class="scope-list">
            <For each={PARTNER_API_SCOPES}>
              {(s) => {
                const info = SCOPE_INFO[s];
                const id = `scope-${s.replace(':', '-')}`;
                const needed = () => s === 'cases:read' && scopes().includes('patients:read');
                return (
                  <div class="stack-sm">
                    <div class="check">
                      <input id={id} type="checkbox" checked={scopes().includes(s)} disabled={needed()} onChange={(e) => toggle(s, e.currentTarget.checked)} aria-describedby={`${id}-h`} />
                      <label for={id}>{info?.label ?? s} <span class="mono muted small">{s}</span></label>
                      <p class="hint" id={`${id}-h`}>{info?.text}{needed() ? ' Needed for patient names.' : ''}</p>
                    </div>
                    <Show when={s === 'patients:read' && scopes().includes(s)}><Notice tone="warn" title="Patient names will leave the platform">{info?.warn}</Notice></Show>
                  </div>
                );
              }}
            </For>
          </div>
        </fieldset>
        <Field
          label="Allowed addresses (optional)"
          hint="One internet address or range per line, for example 203.0.113.0/24. The key then only works from those addresses. Leave empty to allow any address."
          error={cidrError()}
        >
          {(f) => <textarea {...f} class="textarea-mono" rows={3} value={cidrText()} onInput={(e) => setCidrText(e.currentTarget.value)} spellcheck={false} autocomplete="off" style={{ 'min-height': '80px' }} />}
        </Field>
        <Field label="Valid for" hint="After this time the key stops working. You can always make a new one.">
          {(f) => (
            <select {...f} value={String(days())} onChange={(e) => setDays(Number(e.currentTarget.value))}>
              <For each={EXPIRY_CHOICES}>{(c) => <option value={c.days} selected={days() === c.days}>{c.label}</option>}</For>
            </select>
          )}
        </Field>
        <p class="small muted">You will be asked for your authenticator code. The key is shown once. You can have up to 20 active keys.</p>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!canCreate()}>Create key</Button>
        </div>
      </form>
    </Dialog>
  );
}

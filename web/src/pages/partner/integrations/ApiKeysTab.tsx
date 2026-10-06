import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PARTNER_API_SCOPES } from '@shared/roles';
import { api, errorText } from '../../../lib/api';
import { formatDate, formatDateTime, plural } from '../../../lib/format';
import { daysUntil, EXPIRY_CHOICES, keyStatusBadge, normalizeKeys, parseCidrs, SCOPE_INFO, type ApiKeyRow } from '../../../lib/integrations';
import { isNotApproved } from '../../../lib/orgApi';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, Spinner } from '../../../ui/Common';
import { LockedNotice } from '../../../ui/Locked';
import { SecretReveal } from '../../../ui/SecretReveal';

interface Created { key: string; name: string; prefix: string | null; expiresAt: string | null }

export function ApiKeysTab({ locked }: { locked: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['api-keys'], queryFn: async () => normalizeKeys(await api<unknown>('/api/api-keys')) });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const revoke = useMutation({
    mutationFn: (k: ApiKeyRow) => api(`/api/api-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRevoking(null); setNotice({ tone: 'good', text: 'The key was revoked. It stops working straight away.' }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => { setRevoking(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });

  const lockedByServer = isNotApproved(q.error);
  const items = q.data ?? [];

  return (
    <>
      <Card
        title="API keys"
        actions={<Button variant="primary" disabled={locked || lockedByServer} onClick={() => { setCreating(true); setNotice(null); }}>Create a key</Button>}
      >
        <p className="muted">
          An API key lets your ERP or another system work with your cases without a person signing in. Each key only does what you allow. Keep keys secret and give every system its own key.
        </p>
        {locked || lockedByServer ? <LockedNotice what="create API keys" tone="info" /> : null}
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.isError && !lockedByServer ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data && items.length === 0 ? <Empty title="No API keys yet">Create a key when you are ready to connect a system.</Empty> : null}
        {items.length ? (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">API keys</caption>
              <thead><tr><th>Name and key</th><th>Can do</th><th>Allowed addresses</th><th>Expires</th><th>Last used</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {items.map((k) => {
                  const s = keyStatusBadge(k.status);
                  const left = daysUntil(k.expiresAt);
                  return (
                    <tr key={k.id}>
                      <td><strong>{k.name}</strong><div className="mono small" title="The start of the key. The rest is secret.">{k.prefix}...</div><div className="muted small">Created {formatDate(k.createdAt)}{k.createdByName ? ` by ${k.createdByName}` : ''}</div></td>
                      <td>
                        <span className="inline-badges">
                          {k.scopes.map((sc) => <Badge key={sc} tone={sc === 'patients:read' ? 'warn' : 'neutral'} title={SCOPE_INFO[sc]?.text}>{SCOPE_INFO[sc]?.label ?? sc}</Badge>)}
                        </span>
                      </td>
                      <td className="mono small">{k.cidrs.length ? k.cidrs.join(', ') : <span className="muted">Any address</span>}</td>
                      <td className="nowrap">
                        {formatDate(k.expiresAt)}
                        {k.status === 'active' && left !== null && left <= 14 ? <div className="small late">{left <= 0 ? 'Expires today' : `In ${plural(left, 'day')}`}</div> : null}
                      </td>
                      <td className="nowrap">
                        {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : <span className="muted">Never</span>}
                        {k.lastUsedIp ? <div className="muted small mono">{k.lastUsedIp}</div> : null}
                      </td>
                      <td><Badge tone={s.tone}>{s.label}</Badge></td>
                      <td className="right">{k.status !== 'revoked' ? <Button size="sm" variant="danger" onClick={() => { setRevoking(k); setNotice(null); }} aria-label={`Revoke ${k.name}`}>Revoke</Button> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <CreateKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => { setCreating(false); setCreated(c); qc.invalidateQueries({ queryKey: ['api-keys'] }); }}
      />
      <SecretReveal
        open={!!created}
        title="Copy your new API key now"
        subject={created?.name ?? ''}
        secret={created?.key ?? ''}
        kindLabel="key"
        onClose={() => setCreated(null)}
      >
        <p className="small muted">
          Starts with <span className="mono">{created?.prefix}</span>. Valid until {formatDate(created?.expiresAt)}. Send it as a Bearer token in the Authorization header.
        </p>
      </SecretReveal>
      <Dialog
        open={!!revoking}
        title="Revoke this key?"
        onClose={() => setRevoking(null)}
        footer={<><Button onClick={() => setRevoking(null)}>Keep it</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking)}>Revoke key</Button></>}
      >
        <p>{revoking?.name} stops working straight away. Any system using it will need a new key. You will be asked for your authenticator code.</p>
      </Dialog>
    </>
  );
}

function CreateKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Created) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['cases:read']);
  const [cidrText, setCidrText] = useState('');
  const [days, setDays] = useState(365);
  const [error, setError] = useState<{ locked: boolean; text: string } | null>(null);
  useEffect(() => { if (open) { setName(''); setScopes(['cases:read']); setCidrText(''); setDays(365); setError(null); } }, [open]);

  const cidr = parseCidrs(cidrText);
  const cidrError = cidr.bad ? `"${cidr.bad}" is not a valid address or range. Use a form like 203.0.113.0/24 or 2001:db8::/32.` : cidr.tooMany ? 'You can add at most 20 addresses or ranges.' : null;

  function toggle(scope: string, on: boolean) {
    setScopes((cur) => {
      let next = on ? [...cur, scope] : cur.filter((s) => s !== scope);
      if (on && scope === 'patients:read' && !next.includes('cases:read')) next = [...next, 'cases:read'];
      return next;
    });
  }

  const m = useMutation({
    mutationFn: () => api<{ key: string; prefix?: string; expiresAt?: string }>('/api/api-keys', {
      method: 'POST',
      body: { name: name.trim(), scopes: PARTNER_API_SCOPES.filter((s) => scopes.includes(s)), ...(cidr.list.length ? { cidrs: cidr.list } : {}), expiresInDays: days },
    }),
    onSuccess: (r) => {
      onCreated({ key: r.key, name: name.trim(), prefix: r.prefix ?? null, expiresAt: r.expiresAt ?? null });
      m.reset();
    },
    onError: (e) => setError({ locked: isNotApproved(e), text: errorText(e) }),
  });

  const canCreate = !!name.trim() && scopes.length > 0 && !cidr.bad && !cidr.tooMany;

  return (
    <Dialog open={open} title="Create an API key" onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? (error.locked ? <LockedNotice what="create API keys" /> : <Notice tone="bad">{error.text}</Notice>) : null}
        <Field label="Name" hint="Say which system will use it, for example Main ERP.">
          {(f) => <input {...f} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required autoComplete="off" />}
        </Field>
        <fieldset className="check-group">
          <legend>What the key can do</legend>
          <div className="scope-list">
            {PARTNER_API_SCOPES.map((s) => {
              const info = SCOPE_INFO[s];
              const id = `scope-${s.replace(':', '-')}`;
              const needed = s === 'cases:read' && scopes.includes('patients:read');
              return (
                <div key={s} className="stack-sm">
                  <div className="check">
                    <input id={id} type="checkbox" checked={scopes.includes(s)} disabled={needed} onChange={(e) => toggle(s, e.target.checked)} aria-describedby={`${id}-h`} />
                    <label htmlFor={id}>{info?.label ?? s} <span className="mono muted small">{s}</span></label>
                    <p className="hint" id={`${id}-h`}>{info?.text}{needed ? ' Needed for patient names.' : ''}</p>
                  </div>
                  {s === 'patients:read' && scopes.includes(s) ? <Notice tone="warn" title="Patient names will leave the platform">{info?.warn}</Notice> : null}
                </div>
              );
            })}
          </div>
        </fieldset>
        <Field
          label="Allowed addresses (optional)"
          hint="One internet address or range per line, for example 203.0.113.0/24. The key then only works from those addresses. Leave empty to allow any address."
          error={cidrError}
        >
          {(f) => <textarea {...f} className="textarea-mono" rows={3} value={cidrText} onChange={(e) => setCidrText(e.target.value)} spellCheck={false} autoComplete="off" style={{ minHeight: 80 }} />}
        </Field>
        <Field label="Valid for" hint="After this time the key stops working. You can always make a new one.">
          {(f) => (
            <select {...f} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
            </select>
          )}
        </Field>
        <p className="small muted">You will be asked for your authenticator code. The key is shown once. You can have up to 20 active keys.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!canCreate}>Create key</Button>
        </div>
      </form>
    </Dialog>
  );
}

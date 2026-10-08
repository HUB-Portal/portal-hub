import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
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
  const q = useQuery({ queryKey: ['service-keys'], queryFn: () => api<{ items: ServiceKey[] }>('/api/service-keys') });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<ServiceKey | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const revoke = useMutation({
    mutationFn: (k: ServiceKey) => api(`/api/service-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRevoking(null); setNotice({ tone: 'good', text: 'The key was revoked. It stops working straight away.' }); qc.invalidateQueries({ queryKey: ['service-keys'] }); },
    onError: (e) => { setRevoking(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });

  return (
    <div className="page">
      <PageHeader title="Service keys" subtitle="Keys the factory system uses to talk to the Portal Hub. They never work on partner routes." actions={<Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Create a key</Button>} />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <Card>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data && q.data.items.length === 0 ? <Empty title="No service keys yet">Create one for the factory system.</Empty> : null}
        {q.data && q.data.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Key starts with</th><th>Can do</th><th>Allowed addresses</th><th>Expires</th><th>Last used</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {q.data.items.map((k) => {
                  const s = keyState(k);
                  return (
                    <tr key={k.id}>
                      <td><strong>{k.name}</strong><div className="muted small">Created {formatDate(k.createdAt)}</div></td>
                      <td className="mono">{k.prefix}</td>
                      <td>{k.scopes.join(', ')}</td>
                      <td className="mono small">{k.cidrs.length ? k.cidrs.join(', ') : <span className="muted">Any address</span>}</td>
                      <td className="nowrap">{formatDate(k.expiresAt)}</td>
                      <td className="nowrap">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : 'Never'}</td>
                      <td><Badge tone={s.tone}>{s.label}</Badge></td>
                      <td className="right">{k.status !== 'revoked' ? <Button size="sm" variant="danger" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <CreateKey open={creating} onClose={() => setCreating(false)} onCreated={(key, name) => { setCreating(false); setCreated({ key, name }); qc.invalidateQueries({ queryKey: ['service-keys'] }); }} />
      <ShowKey created={created} onClose={() => setCreated(null)} />
      <Dialog
        open={!!revoking}
        title="Revoke this key?"
        onClose={() => setRevoking(null)}
        footer={<><Button onClick={() => setRevoking(null)}>Keep it</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking)}>Revoke key</Button></>}
      >
        <p>{revoking?.name} stops working straight away. Anything using it must be given a new key.<IfMfa> You will be asked for your authenticator code.</IfMfa></p>
      </Dialog>
    </div>
  );
}

function CreateKey({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (key: string, name: string) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([...KLINE_API_SCOPES]);
  const [cidrText, setCidrText] = useState('');
  const [days, setDays] = useState('365');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(''); setScopes([...KLINE_API_SCOPES]); setCidrText(''); setDays('365'); setError(null); } }, [open]);

  const cidrs = cidrText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const badCidr = cidrs.find((c) => !CIDR_LINE.test(c));
  const d = Number(days);
  const daysOk = Number.isInteger(d) && d >= 1 && d <= 730;

  const m = useMutation({
    mutationFn: () => api<{ key: string }>('/api/service-keys', { method: 'POST', body: { name: name.trim(), scopes, cidrs, expiresInDays: d } }),
    onSuccess: (r) => onCreated(r.key, name.trim()),
    onError: (e) => setError(errorText(e)),
  });

  return (
    <Dialog open={open} title="Create a service key" onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Name" hint="For example, Chaves factory MES.">{(f) => <input {...f} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required autoComplete="off" />}</Field>
        <fieldset className="check-group">
          <legend>What the key can do</legend>
          {KLINE_API_SCOPES.map((s) => (
            <div className="check" key={s}>
              <input id={`scope-${s}`} type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
              <label htmlFor={`scope-${s}`}><span className="mono">{s}</span></label>
              <p className="hint">{SCOPE_INFO[s]}</p>
            </div>
          ))}
        </fieldset>
        <Field label="Allowed addresses (optional)" hint="One per line, for example 203.0.113.0/24. Leave empty to allow any address." error={badCidr ? `"${badCidr}" is not a valid address or range.` : null}>
          {(f) => <textarea {...f} className="textarea-mono" rows={3} value={cidrText} onChange={(e) => setCidrText(e.target.value)} spellCheck={false} style={{ minHeight: 80 }} />}
        </Field>
        <Field label="Valid for (days)" hint="Between 1 and 730 days." error={days && !daysOk ? 'Enter a whole number from 1 to 730.' : null}>
          {(f) => <input {...f} type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} required />}
        </Field>
        <p className="small muted"><IfMfa>You will be asked for your authenticator code. </IfMfa>The key is shown once.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!name.trim() || scopes.length === 0 || !!badCidr || !daysOk}>Create key</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ShowKey({ created, onClose }: { created: { key: string; name: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  useEffect(() => { setCopied(null); }, [created]);
  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.key); setCopied('yes'); } catch { setCopied('no'); }
  }
  return (
    <Dialog open={!!created} title="Copy your new key now" onClose={onClose} dismissible={false} wide footer={<Button variant="primary" onClick={onClose}>I have saved the key</Button>}>
      <div className="stack">
        <Notice tone="warn" title="This is the only time you will see it">We store only a fingerprint. If you lose the key, revoke it and create a new one.</Notice>
        <p>Key for <strong>{created?.name}</strong></p>
        <div className="key-box" data-testid="new-service-key">{created?.key}</div>
        <div className="row">
          <Button onClick={copy}><Copy size={16} aria-hidden="true" /> Copy key</Button>
          <span role="status" className="small">{copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Copying was blocked. Select the key and copy it by hand.' : ''}</span>
        </div>
      </div>
    </Dialog>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { Button, Card, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { PortalWebhookCard, type PortalWebhookInfo } from './PortalWebhookCard';
import { IfMfa } from '../../ui/IfMfa';

interface PortalApi { configured: boolean; baseUrl: string | null; userUuid: string | null; doctorId: string | null; webhook?: PortalWebhookInfo }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PortalSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal-api'], queryFn: () => api<PortalApi>('/api/org/portal-api') });
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [userUuid, setUserUuid] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [test, setTest] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (q.data) { setBaseUrl(q.data.baseUrl ?? ''); setUserUuid(q.data.userUuid ?? ''); setDoctorId(q.data.doctorId ?? ''); }
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api('/api/org/portal-api', { method: 'PUT', body: { baseUrl: baseUrl.trim(), apiKey, userUuid: userUuid.trim(), ...(doctorId.trim() ? { doctorId: doctorId.trim() } : {}) } }),
    onSuccess: () => { setApiKey(''); setMsg({ tone: 'good', text: 'Saved. The API key is stored encrypted and will not be shown again.' }); qc.invalidateQueries({ queryKey: ['portal-api'] }); },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });
  const ping = useMutation({
    mutationFn: () => api<{ ok?: boolean; message?: string }>('/api/org/portal-api/test', { method: 'POST', body: {} }),
    onSuccess: (r) => setTest({ tone: r?.ok === false ? 'bad' : 'good', text: r?.ok === false ? (r.message ?? 'The connection test failed.') : 'The connection works.' }),
    onError: (e) => setTest({ tone: 'bad', text: errorText(e) }),
  });

  const urlOk = /^https:\/\/\S+$/i.test(baseUrl.trim());
  const uuidOk = UUID.test(userUuid.trim());
  const canSave = urlOk && uuidOk && apiKey.length >= 8;

  function submit(e: FormEvent) { e.preventDefault(); setMsg(null); save.mutate(); }

  return (
    <div className="page page-narrow">
      <PageHeader title="Portal connection" subtitle="Settings for sending direct manufacturing cases to the K Line customer portal." />
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data ? (
        <Card>
          <Notice tone={q.data.configured ? 'good' : 'warn'}>{q.data.configured ? 'A connection is saved. Enter a new API key to change it.' : 'No connection is saved yet. Direct manufacturing cases cannot be sent until you add one.'}</Notice>
          {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
          <form onSubmit={submit} className="stack">
            <Field label="Portal address" hint="Starts with https://. Ask K Line for the address of your portal API.">
              {(p) => <input {...p} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" autoComplete="off" required />}
            </Field>
            <Field label="API key" hint="Shown once. We store it encrypted and never display it again.">
              {(p) => <input {...p} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" required />}
            </Field>
            <Field label="User ID" hint="The user UUID that K Line gave you." error={userUuid && !uuidOk ? 'This does not look like a user ID.' : null}>
              {(p) => <input {...p} value={userUuid} onChange={(e) => setUserUuid(e.target.value)} autoComplete="off" required />}
            </Field>
            <Field label="Doctor ID (optional)">
              {(p) => <input {...p} value={doctorId} onChange={(e) => setDoctorId(e.target.value)} autoComplete="off" />}
            </Field>
            <IfMfa><p className="small muted">You will be asked for your authenticator code when you save.</p></IfMfa>
            <div className="row">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!canSave}>Save connection</Button>
              <Button onClick={() => { setTest(null); ping.mutate(); }} loading={ping.isPending} disabled={!q.data.configured}>Test connection</Button>
            </div>
            {test ? <Notice tone={test.tone}>{test.text}</Notice> : null}
          </form>
        </Card>
      ) : null}
      {q.data?.webhook ? <PortalWebhookCard webhook={q.data.webhook} /> : null}
    </div>
  );
}

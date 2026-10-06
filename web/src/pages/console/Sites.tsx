import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isAdequate, isEea } from '@shared/geo';
import { api, errorText } from '../../lib/api';
import { useSites, type SiteRow } from '../../lib/console';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';

const CODE_RE = /^[A-Z]{2}-[A-Z0-9]{2,6}$/;

export default function Sites() {
  const qc = useQueryClient();
  const q = useSites();
  const [editing, setEditing] = useState<SiteRow | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = q.data?.sites ?? [];
  return (
    <div className="page">
      <PageHeader title="Sites" subtitle="Factories that can make cases. The country decides where EEA partner cases may go." actions={<Button variant="primary" onClick={() => { setEditing('new'); setNotice(null); }}>Add a site</Button>} />
      {notice ? <Notice tone="good">{notice}</Notice> : null}
      <Card>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data && rows.length === 0 ? <Empty title="No sites yet">Add the first factory site.</Empty> : null}
        {rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Country</th><th>EEA</th><th>Adequacy decision</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.code}</strong></td>
                    <td>{s.name}</td>
                    <td>{s.country}</td>
                    <td>{s.inEea ? 'Yes' : 'No'}</td>
                    <td>{s.hasAdequacy ? 'Yes' : 'No'}</td>
                    <td><Badge tone={s.active ? 'good' : 'neutral'}>{s.active ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="right"><Button size="sm" onClick={() => { setEditing(s); setNotice(null); }} aria-label={`Edit ${s.code}`}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <SiteDialog
        site={editing}
        onClose={() => setEditing(null)}
        onDone={(text) => { setEditing(null); setNotice(text); qc.invalidateQueries({ queryKey: ['sites'] }); qc.invalidateQueries({ queryKey: ['partner'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); }}
      />
    </div>
  );
}

function SiteDialog({ site, onClose, onDone }: { site: SiteRow | 'new' | null; onClose: () => void; onDone: (text: string) => void }) {
  const isNew = site === 'new';
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [inEea, setInEea] = useState(false);
  const [adequacy, setAdequacy] = useState(false);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!site) return;
    setError(null);
    if (site === 'new') { setCode(''); setName(''); setCountry(''); setInEea(false); setAdequacy(false); setActive(true); }
    else { setCode(site.code); setName(site.name); setCountry(site.country); setInEea(site.inEea); setAdequacy(site.hasAdequacy); setActive(site.active); }
  }, [site]);

  function changeCountry(v: string) {
    const c = v.toUpperCase().slice(0, 2);
    setCountry(c);
    if (c.length === 2) { setInEea(isEea(c)); setAdequacy(isAdequate(c)); }
  }

  const codeOk = CODE_RE.test(code);
  const body = { name: name.trim(), country: country.trim().toUpperCase(), inEea, hasAdequacy: adequacy, active };
  const m = useMutation({
    mutationFn: () => (isNew ? api('/api/sites', { method: 'POST', body: { code, ...body } }) : api(`/api/sites/${(site as SiteRow).id}`, { method: 'PATCH', body })),
    onSuccess: () => onDone(isNew ? 'Site added.' : 'Site saved.'),
    onError: (e) => setError(errorText(e)),
  });

  return (
    <Dialog open={!!site} title={isNew ? 'Add a site' : `Edit ${(site as SiteRow | null)?.code ?? ''}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Code" hint="Country, a dash, then the place. For example PT-CHV." error={isNew && code && !codeOk ? 'Use two capital letters, a dash, then 2 to 6 capital letters or numbers.' : null}>
          {(f) => <input {...f} value={code} disabled={!isNew} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={9} required autoComplete="off" />}
        </Field>
        <Field label="Name">{(f) => <input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoComplete="off" />}</Field>
        <Field label="Country code" hint="Two letters, for example PT. This fills in the two boxes below.">
          {(f) => <input {...f} value={country} onChange={(e) => changeCountry(e.target.value)} maxLength={2} required autoComplete="off" />}
        </Field>
        <Toggle checked={inEea} onChange={setInEea} label="In the European Economic Area" />
        <Toggle checked={adequacy} onChange={setAdequacy} label="Has an EU adequacy decision" hint="Only for countries outside the EEA." />
        <Toggle checked={active} onChange={setActive} label="Active" hint="Inactive sites cannot be chosen for new cases." />
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!name.trim() || country.trim().length !== 2 || (isNew && !codeOk)}>{isNew ? 'Add site' : 'Save site'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

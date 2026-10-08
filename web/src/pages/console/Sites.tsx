import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { isAdequate, isEea } from '@shared/geo';
import { api, errorText } from '../../lib/api';
import { useSites, type SiteRow } from '../../lib/console';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';

const CODE_RE = /^[A-Z]{2}-[A-Z0-9]{2,6}$/;

export default function Sites() {
  const qc = useQueryClient();
  const q = useSites();
  const [editing, setEditing] = createSignal<SiteRow | 'new' | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const rows = () => q.data?.sites ?? [];
  return (
    <div class="page">
      <PageHeader title="Sites" subtitle="Factories that can make cases. The country decides where EEA partner cases may go." actions={<Button variant="primary" onClick={() => { setEditing('new'); setNotice(null); }}>Add a site</Button>} />
      <Show when={notice()}>{(n) => <Notice tone="good">{n()}</Notice>}</Show>
      <Card>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data && rows().length === 0}><Empty title="No sites yet">Add the first factory site.</Empty></Show>
        <Show when={rows().length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Code</th><th>Name</th><th>Country</th><th>EEA</th><th>Adequacy decision</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(s) => (
                    <tr>
                      <td><strong>{s.code}</strong></td>
                      <td>{s.name}</td>
                      <td>{s.country}</td>
                      <td>{s.inEea ? 'Yes' : 'No'}</td>
                      <td>{s.hasAdequacy ? 'Yes' : 'No'}</td>
                      <td><Badge tone={s.active ? 'good' : 'neutral'}>{s.active ? 'Active' : 'Inactive'}</Badge></td>
                      <td class="right"><Button size="sm" onClick={() => { setEditing(s); setNotice(null); }} aria-label={`Edit ${s.code}`}>Edit</Button></td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>
      <SiteDialog
        site={editing()}
        onClose={() => setEditing(null)}
        onDone={(text) => { setEditing(null); setNotice(text); qc.invalidateQueries({ queryKey: ['sites'] }); qc.invalidateQueries({ queryKey: ['partner'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); }}
      />
    </div>
  );
}

function SiteDialog(props: { site: SiteRow | 'new' | null; onClose: () => void; onDone: (text: string) => void }) {
  const isNew = () => props.site === 'new';
  const [code, setCode] = createSignal('');
  const [name, setName] = createSignal('');
  const [country, setCountry] = createSignal('');
  const [inEea, setInEea] = createSignal(false);
  const [adequacy, setAdequacy] = createSignal(false);
  const [active, setActive] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.site, (site) => {
    if (!site) return;
    setError(null);
    if (site === 'new') { setCode(''); setName(''); setCountry(''); setInEea(false); setAdequacy(false); setActive(true); }
    else { setCode(site.code); setName(site.name); setCountry(site.country); setInEea(site.inEea); setAdequacy(site.hasAdequacy); setActive(site.active); }
  }));

  function changeCountry(v: string) {
    const c = v.toUpperCase().slice(0, 2);
    setCountry(c);
    if (c.length === 2) { setInEea(isEea(c)); setAdequacy(isAdequate(c)); }
  }

  const codeOk = () => CODE_RE.test(code());
  const body = () => ({ name: name().trim(), country: country().trim().toUpperCase(), inEea: inEea(), hasAdequacy: adequacy(), active: active() });
  const m = createMutation(() => ({
    mutationFn: () => (isNew() ? api('/api/sites', { method: 'POST', body: { code: code(), ...body() } }) : api(`/api/sites/${(props.site as SiteRow).id}`, { method: 'PATCH', body: body() })),
    onSuccess: () => props.onDone(isNew() ? 'Site added.' : 'Site saved.'),
    onError: (e: unknown) => setError(errorText(e)),
  }));

  return (
    <Dialog open={!!props.site} title={isNew() ? 'Add a site' : `Edit ${(props.site as SiteRow | null)?.code ?? ''}`} onClose={props.onClose}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Code" hint="Country, a dash, then the place. For example PT-CHV." error={isNew() && code() && !codeOk() ? 'Use two capital letters, a dash, then 2 to 6 capital letters or numbers.' : null}>
          {(f) => <input {...f} value={code()} disabled={!isNew()} onInput={(e) => setCode(e.currentTarget.value.toUpperCase())} maxLength={9} required autocomplete="off" />}
        </Field>
        <Field label="Name">{(f) => <input {...f} value={name()} onInput={(e) => setName(e.currentTarget.value)} maxLength={120} required autocomplete="off" />}</Field>
        <Field label="Country code" hint="Two letters, for example PT. This fills in the two boxes below.">
          {(f) => <input {...f} value={country()} onInput={(e) => changeCountry(e.currentTarget.value)} maxLength={2} required autocomplete="off" />}
        </Field>
        <Toggle checked={inEea()} onChange={(v) => setInEea(v)} label="In the European Economic Area" />
        <Toggle checked={adequacy()} onChange={(v) => setAdequacy(v)} label="Has an EU adequacy decision" hint="Only for countries outside the EEA." />
        <Toggle checked={active()} onChange={(v) => setActive(v)} label="Active" hint="Inactive sites cannot be chosen for new cases." />
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!name().trim() || country().trim().length !== 2 || (isNew() && !codeOk())}>{isNew() ? 'Add site' : 'Save site'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { ClipboardCheck, SlidersHorizontal } from 'lucide-solid';
import { api, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilterOptions, useSites } from '../../lib/console';
import { formatDate, formatNumber } from '../../lib/format';
import { normalizeMaterials, normalizeShipmentPage, shipmentStatusLabel, shipmentStatusTone, type Material, type Shipment } from '../../lib/quality';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';
import { ShipmentLines, StockTable } from '../partner/Materials';

/** A search parameter as plain text: empty when it is missing. */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

function ReceiveDialog(props: { shipment: Shipment | null; onClose: () => void; onDone: (text: string) => void }) {
  const [qty, setQty] = createSignal<Record<string, string>>({});
  const [note, setNote] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.shipment, (shipment) => {
    if (!shipment) return;
    setQty(Object.fromEntries(shipment.lines.map((l) => [l.id, String(l.quantity)])));
    setNote('');
    setError(null);
  }));

  const valid = () => !!props.shipment && props.shipment.lines.every((l) => qty()[l.id] !== undefined && qty()[l.id] !== '' && Number.isInteger(Number(qty()[l.id])) && Number(qty()[l.id]) >= 0);
  const differs = () => !!props.shipment && props.shipment.lines.some((l) => Number(qty()[l.id]) !== l.quantity);
  const m = createMutation(() => ({
    mutationFn: () => api<{ status?: string; shipment?: { status?: string } }>(`/api/console/material-shipments/${props.shipment!.id}/receive`, {
      method: 'POST',
      body: { lines: props.shipment!.lines.map((l) => ({ lineId: l.id, receivedQuantity: Number(qty()[l.id]) })), ...(note().trim() ? { note: note().trim() } : {}) },
    }),
    onSuccess: () => props.onDone(differs() ? `${props.shipment!.number} was booked in with differences. The partner has been told.` : `${props.shipment!.number} was booked in.`),
    onError: (e: unknown) => setError(errorText(e)),
  }));

  return (
    <Dialog
      open={!!props.shipment}
      title={props.shipment ? `Receive ${props.shipment.number}` : 'Receive'}
      wide
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!valid()} onClick={() => { setError(null); m.mutate(); }}>{differs() ? 'Book in with differences' : 'Book in'}</Button></>}
    >
      <Show when={props.shipment}>
        {(shipment) => (
          <div class="stack">
            <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
            <p class="muted small">{shipment().orgName ? `${shipment().orgName}, ` : ''}to {shipment().siteCode}. Count what arrived and enter it. Stock is booked with these numbers.</p>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Material</th><th class="num">Declared</th><th>Received</th><th>Difference</th></tr></thead>
                <tbody>
                  <For each={shipment().lines}>
                    {(l) => {
                      const diff = () => Number(qty()[l.id] ?? l.quantity) - l.quantity;
                      return (
                        <tr class={diff() !== 0 ? 'row-low' : undefined}>
                          <td>{l.name ?? 'Material'}{l.sku ? <span class="muted small"> {l.sku}</span> : null}</td>
                          <td class="num">{formatNumber(l.quantity)}</td>
                          <td style={{ width: '140px' }}>
                            <label class="sr-only" for={`rq-${l.id}`}>Received quantity for {l.name ?? 'material'}</label>
                            <input id={`rq-${l.id}`} type="number" min={0} step={1} value={qty()[l.id] ?? ''} onInput={(e) => setQty({ ...qty(), [l.id]: e.currentTarget.value })} />
                          </td>
                          <td>{diff() === 0 ? <Badge tone="good">Matches</Badge> : <Badge tone="warn">{diff() > 0 ? '+' : ''}{formatNumber(diff())}</Badge>}</td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={differs()}><Notice tone="warn" title="The counts differ from what was declared">The shipment is marked as received with differences and the partner is told. Add a note to explain.</Notice></Show>
            <Field label="Note for the partner (optional)" hint="For example: one box arrived damaged.">
              {(p) => <textarea {...p} value={note()} maxLength={500} rows={3} onInput={(e) => setNote(e.currentTarget.value)} />}
            </Field>
          </div>
        )}
      </Show>
    </Dialog>
  );
}

function AdjustDialog(props: { open: boolean; orgId: string; materials: Material[]; onClose: () => void; onDone: () => void }) {
  const sites = useSites();
  const [materialId, setMaterialId] = createSignal('');
  const [siteCode, setSiteCode] = createSignal('');
  const [quantity, setQuantity] = createSignal('');
  const [reason, setReason] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setMaterialId(''); setSiteCode(''); setQuantity(''); setReason(''); setError(null); } }));

  const material = () => props.materials.find((m) => m.id === materialId());
  const siteOptions = createMemo(() => {
    const set = new Set<string>();
    for (const m of props.materials) for (const s of m.stock) set.add(s.siteCode);
    for (const s of sites.data?.sites ?? []) if (s.active) set.add(s.code);
    return [...set].sort();
  });
  const current = () => material()?.stock.find((s) => s.siteCode === siteCode());
  const q = () => Number(quantity());
  const valid = () => !!materialId() && !!siteCode() && quantity() !== '' && Number.isInteger(q()) && q() !== 0 && reason().trim().length >= 3;

  const m = createMutation(() => ({
    mutationFn: () => api('/api/console/materials/adjust', { method: 'POST', body: { orgId: props.orgId, materialId: materialId(), siteCode: siteCode(), quantity: q(), reason: reason().trim() } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));

  return (
    <Dialog open={props.open} title="Correct stock" onClose={props.onClose} footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!valid()} onClick={() => { setError(null); m.mutate(); }}>Book the correction</Button></>}>
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Material">
          {(p) => (
            <select {...p} value={materialId()} onChange={(e) => setMaterialId(e.currentTarget.value)}>
              <option value="" selected={materialId() === ''}>Choose a material</option>
              <For each={props.materials}>{(mm) => <option value={mm.id} selected={mm.id === materialId()}>{mm.name} ({mm.sku})</option>}</For>
            </select>
          )}
        </Field>
        <Field label="Site">
          {(p) => (
            <select {...p} value={siteCode()} onChange={(e) => setSiteCode(e.currentTarget.value)}>
              <option value="" selected={siteCode() === ''}>Choose a site</option>
              <For each={siteOptions()}>{(s) => <option value={s} selected={s === siteCode()}>{s}</option>}</For>
            </select>
          )}
        </Field>
        <Show when={siteCode() ? material() : undefined}>{(mat) => <p class="small muted">On hand now: {formatNumber(current()?.onHand ?? 0)} {mat().unit}.</p>}</Show>
        <Field label="Change in quantity" hint="Use a plus number to add stock and a minus number to remove it. For example -12 after a count.">
          {(p) => <input {...p} type="number" step={1} value={quantity()} onInput={(e) => setQuantity(e.currentTarget.value)} />}
        </Field>
        <Show when={material() && current() && Number.isInteger(q()) && q() !== 0}><p class="small">New stock will be <strong>{formatNumber(current()!.onHand + q())}</strong> {material()!.unit}.</p></Show>
        <Field label="Reason" hint="Recorded in the audit log and shown to the partner.">
          {(p) => <input {...p} value={reason()} maxLength={200} onInput={(e) => setReason(e.currentTarget.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export default function ConsoleMaterials() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = () => (params.tab === 'stock' ? 'stock' : 'shipments');
  const status = () => one(params.status) || 'in_transit';
  const siteCode = () => one(params.siteCode);
  const orgId = () => one(params.orgId);
  const page = () => Math.max(1, Number(params.page ?? 1) || 1);
  const [receiving, setReceiving] = createSignal<Shipment | null>(null);
  const [adjust, setAdjust] = createSignal(false);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const opts = useFilterOptions();

  const ships = createQuery(() => ({
    queryKey: ['console-material-shipments', { status: status(), siteCode: siteCode(), page: page() }],
    queryFn: async () => normalizeShipmentPage(await api(`/api/console/material-shipments${qs({ status: status() === 'all' ? '' : status(), siteCode: siteCode(), page: page(), pageSize: 25 })}`)),
  }));
  const mats = createQuery(() => ({
    queryKey: ['console-materials', orgId()],
    enabled: tab() === 'stock',
    queryFn: async () => normalizeMaterials(await api(`/api/console/materials${qs({ orgId: orgId() })}`)),
  }));

  function setParam(key: string, value: string) {
    setParams({ [key]: value || undefined, ...(key !== 'page' ? { page: undefined } : {}) }, { replace: true });
  }
  const refresh = () => { for (const k of ['console-material-shipments', 'console-materials']) qc.invalidateQueries({ queryKey: [k] }); };

  // Staff who cannot list partners still see the partners that have shipments.
  const partnerOptions = createMemo(() => {
    const map = new Map(opts.partners.map((p) => [p.id, p.name]));
    for (const s of ships.data?.items ?? []) if (s.orgId && !map.has(s.orgId)) map.set(s.orgId, s.orgName ?? 'Partner');
    for (const m of mats.data ?? []) if (m.orgId && !map.has(m.orgId)) map.set(m.orgId, m.orgName ?? 'Partner');
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  const canReceive = () => can('material.receive');

  return (
    <div class="page">
      <PageHeader title="Partner materials" subtitle="Receive the boxes, bags and inserts partners send, and keep their stock right." />
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <div class="tabs" role="group" aria-label="Section">
        <button type="button" class="tab" aria-pressed={tab() === 'shipments'} onClick={() => setParam('tab', '')}>Shipments</button>
        <button type="button" class="tab" aria-pressed={tab() === 'stock'} onClick={() => setParam('tab', 'stock')}>Stock</button>
      </div>

      <Show
        when={tab() === 'shipments'}
        fallback={
          <Card
            title="Stock by partner"
            actions={canReceive() && mats.data && mats.data.length ? <Button disabled={!orgId()} title={orgId() ? undefined : 'Choose a partner first'} onClick={() => setAdjust(true)}><SlidersHorizontal size={16} aria-hidden="true" /> Correct stock</Button> : undefined}
          >
            <div class="toolbar">
              <div class="field" style={{ 'min-width': '200px', 'flex-basis': '260px' }}>
                <label for="ms-partner">Partner</label>
                <select id="ms-partner" value={orgId()} onChange={(e) => setParam('orgId', e.currentTarget.value)}>
                  <option value="" selected={orgId() === ''}>All partners</option>
                  <For each={partnerOptions()}>{(p) => <option value={p.id} selected={p.id === orgId()}>{p.name}</option>}</For>
                </select>
              </div>
            </div>
            <Show when={!orgId() && canReceive()}><p class="muted small">Choose one partner to correct their stock.</p></Show>
            <Show when={mats.isLoading}><Spinner /></Show>
            <Show when={mats.isError}><Notice tone="bad">{errorText(mats.error)}</Notice></Show>
            <Show when={mats.data}>{(d) => <StockTable materials={d()} showOrg={!orgId()} />}</Show>
          </Card>
        }
      >
        <Card>
          <div class="toolbar">
            <div class="field" style={{ 'min-width': '170px', 'flex-basis': '200px' }}>
              <label for="ms-status">Status</label>
              <select id="ms-status" value={status()} onChange={(e) => setParam('status', e.currentTarget.value || 'all')}>
                <option value="in_transit" selected={status() === 'in_transit'}>On their way</option>
                <option value="discrepancy" selected={status() === 'discrepancy'}>Received with differences</option>
                <option value="received" selected={status() === 'received'}>Received</option>
                <option value="cancelled" selected={status() === 'cancelled'}>Cancelled</option>
                <option value="all" selected={status() === 'all'}>Any status</option>
              </select>
            </div>
            <div class="field" style={{ 'min-width': '130px', 'flex-basis': '140px' }}>
              <label for="ms-site">Site</label>
              <select id="ms-site" value={siteCode()} onChange={(e) => setParam('siteCode', e.currentTarget.value)}>
                <option value="" selected={siteCode() === ''}>All sites</option>
                <For each={opts.siteCodes}>{(s) => <option value={s} selected={s === siteCode()}>{s}</option>}</For>
              </select>
            </div>
          </div>
          <Show when={ships.isLoading}><Spinner /></Show>
          <Show when={ships.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => ships.refetch()}>Try again</Button>}>{errorText(ships.error)}</Notice></Show>
          <Show when={ships.data && ships.data.items.length === 0}><Empty title="No shipments here">{status() === 'in_transit' ? 'Nothing is on its way right now.' : 'Try a different filter.'}</Empty></Show>
          <div class="stack">
            <For each={ships.data?.items}>
              {(s) => (
                <details class="case-row" open={s.status === 'in_transit' || s.status === 'discrepancy'}>
                  <summary>
                    <div class="case-sum">
                      <span class="id">{s.number}</span>
                      <Badge tone={shipmentStatusTone(s.status)}>{shipmentStatusLabel(s.status)}</Badge>
                      <span>{s.orgName ?? ''}</span>
                      <span class="muted small">To {s.siteCode}</span>
                      {s.expectedDate && s.status === 'in_transit' ? <span class="muted small">Expected {formatDate(s.expectedDate)}</span> : null}
                    </div>
                  </summary>
                  <div class="case-body">
                    <dl class="facts">
                      <dt>Carrier</dt><dd>{s.carrier ?? 'Not given'}</dd>
                      <dt>Tracking number</dt><dd>{s.tracking ? <span class="mono">{s.tracking}</span> : 'Not given'}</dd>
                      <dt>Declared</dt><dd>{formatDate(s.createdAt)}</dd>
                      {s.receivedAt ? <><dt>Received</dt><dd>{formatDate(s.receivedAt)}</dd></> : null}
                      {s.note ? <><dt>Note</dt><dd style={{ 'white-space': 'pre-wrap' }}>{s.note}</dd></> : null}
                    </dl>
                    <ShipmentLines s={s} highlight />
                    {s.status === 'in_transit' && canReceive() ? <div><Button variant="primary" onClick={() => setReceiving(s)}><ClipboardCheck size={16} aria-hidden="true" /> Receive</Button></div> : null}
                  </div>
                </details>
              )}
            </For>
          </div>
          <Show when={ships.data}>{(d) => <Pagination page={page()} pageSize={d().pageSize} total={d().total} onPage={(p) => setParam('page', String(p))} />}</Show>
        </Card>
      </Show>

      <ReceiveDialog shipment={receiving()} onClose={() => setReceiving(null)} onDone={(text) => { setReceiving(null); setNotice({ tone: 'good', text }); refresh(); }} />
      <AdjustDialog open={adjust()} orgId={orgId()} materials={mats.data ?? []} onClose={() => setAdjust(false)} onDone={() => { setAdjust(false); setNotice({ tone: 'good', text: 'The correction was booked.' }); refresh(); }} />
    </div>
  );
}

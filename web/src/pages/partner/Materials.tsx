import { createEffect, createMemo, createSignal, For, Index, on, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { AlertTriangle, PackagePlus, Pencil, Plus, Trash2, Truck } from 'lucide-solid';
import { api, ApiError, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatNumber } from '../../lib/format';
import {
  MATERIAL_CATEGORIES, MAX_SHIPMENT_DOC_BYTES, MAX_SHIPMENT_DOCS, categoryLabel, coverText, isLow, normalizeMaterials, normalizeShipmentPage, shipmentStatusLabel, shipmentStatusTone,
  type Material, type Shipment, type StockRow,
} from '../../lib/quality';
import type { OrgInfo } from '../../lib/types';
import type { FileStatus } from '../../lib/upload';
import { AttachmentPicker, uploadPending, usePending } from '../../ui/Attachments';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Pagination, Spinner, Toggle } from '../../ui/Common';

export function StockTable(props: { materials: Material[]; showOrg?: boolean }) {
  const rows = createMemo((): { m: Material; s: StockRow | null }[] => props.materials.flatMap((m): { m: Material; s: StockRow | null }[] => (m.stock.length ? m.stock.map((s) => ({ m, s })) : [{ m, s: null }])));
  return (
    <Show when={rows().length} fallback={<Empty title="No materials yet">Materials appear here once they are set up.</Empty>}>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><Show when={props.showOrg}><th>Partner</th></Show><th>Material</th><th>Site</th><th class="num">On hand</th><th class="num">On the way</th><th class="num">Used in 28 days</th><th>Days of cover</th><th>Minimum</th></tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => {
                const low = () => (r.s ? isLow(r.m, r.s) : false);
                const short = () => r.s && r.s.daysOfCover !== null && r.s.daysOfCover < 14;
                return (
                  <tr class={low() ? 'row-low' : undefined}>
                    <Show when={props.showOrg}><td>{r.m.orgName ?? ''}</td></Show>
                    <td><strong>{r.m.name}</strong><div class="muted small">{r.m.sku}, {categoryLabel(r.m.category)}</div></td>
                    <td>{r.s ? r.s.siteCode : <span class="muted">No stock recorded</span>}</td>
                    <td class="num">{r.s ? <>{formatNumber(r.s.onHand)} <span class="muted small">{r.m.unit}</span></> : ''}</td>
                    <td class="num">{r.s ? formatNumber(r.s.inTransit) : ''}</td>
                    <td class="num">{r.s ? formatNumber(r.s.used28d) : ''}</td>
                    <td>{r.s ? <span class={short() ? 'late' : undefined}>{coverText(r.s.daysOfCover)}</span> : ''}</td>
                    <td>{r.m.minStock ? <>{formatNumber(r.m.minStock)} {low() ? <Badge tone="bad"><AlertTriangle size={12} aria-hidden="true" /> Low stock</Badge> : null}</> : <span class="muted">Not set</span>}</td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}

export function ShipmentLines(props: { s: Shipment; highlight?: boolean }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Material</th><th class="num">Declared</th><th class="num">Received</th><th class="num">Difference</th></tr></thead>
        <tbody>
          <For each={props.s.lines}>
            {(l) => {
              const diff = () => (l.receivedQuantity === null ? null : l.receivedQuantity - l.quantity);
              return (
                <tr class={props.highlight && diff() !== null && diff() !== 0 ? 'row-low' : undefined}>
                  <td>{l.name ?? 'Material'}{l.sku ? <span class="muted small"> {l.sku}</span> : null}</td>
                  <td class="num">{formatNumber(l.quantity)}</td>
                  <td class="num">{l.receivedQuantity === null ? <span class="muted">Not received</span> : formatNumber(l.receivedQuantity)}</td>
                  <td class="num">{diff() === null ? '' : diff() === 0 ? <Badge tone="good">Matches</Badge> : <Badge tone="warn">{diff()! > 0 ? '+' : ''}{formatNumber(diff()!)}</Badge>}</td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </div>
  );
}

const BLANK_ITEM = { sku: '', name: '', category: 'box', unit: 'pieces', perCase: '0', perAligner: '0', minStock: '0', active: true };

function ItemDialog(props: { open: boolean; item: Material | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = createStore({ ...BLANK_ITEM });
  const [error, setError] = createSignal<string | null>(null);
  // The form starts again whenever the dialog opens or is opened for another item, but not when the list behind it refreshes.
  createEffect(on([() => props.open, () => props.item], ([open, item]) => {
    if (!open) return;
    setError(null);
    setF(reconcile(item ? { sku: item.sku, name: item.name, category: item.category, unit: item.unit, perCase: String(item.perCase), perAligner: String(item.perAligner), minStock: String(item.minStock), active: item.active } : { ...BLANK_ITEM }));
  }));
  const n = (v: string) => Number(v);
  const bad = () => !f.sku.trim() || !f.name.trim() || [f.perCase, f.perAligner, f.minStock].some((v) => v === '' || !(n(v) >= 0));
  const m = createMutation(() => ({
    mutationFn: () => api(props.item ? `/api/materials/${props.item.id}` : '/api/materials', {
      method: props.item ? 'PATCH' : 'POST',
      body: { sku: f.sku.trim(), name: f.name.trim(), category: f.category, unit: f.unit.trim() || 'pieces', perCase: n(f.perCase), perAligner: n(f.perAligner), minStock: n(f.minStock), ...(props.item ? { active: f.active } : {}) },
    }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(e instanceof ApiError && e.code === 'sku_exists' ? 'You already have an item with this SKU.' : errorText(e)),
  }));
  return (
    <Dialog open={props.open} title={props.item ? 'Change this item' : 'Add an item'} wide onClose={props.onClose} footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={bad()} onClick={() => { setError(null); m.mutate(); }}>{props.item ? 'Save' : 'Add item'}</Button></>}>
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <div class="form-grid">
          <Field label="SKU" hint="Your own code for this item. It must be unique.">{(p) => <input {...p} value={f.sku} maxLength={60} onInput={(e) => setF('sku', e.currentTarget.value)} />}</Field>
          <Field label="Name">{(p) => <input {...p} value={f.name} maxLength={120} onInput={(e) => setF('name', e.currentTarget.value)} />}</Field>
          <Field label="Category">{(p) => <select {...p} value={f.category} onChange={(e) => setF('category', e.currentTarget.value)}><For each={MATERIAL_CATEGORIES}>{(c) => <option value={c.id}>{c.label}</option>}</For></select>}</Field>
          <Field label="Unit" hint="For example pieces or boxes.">{(p) => <input {...p} value={f.unit} maxLength={20} onInput={(e) => setF('unit', e.currentTarget.value)} />}</Field>
        </div>
        <Show when={props.item}><Toggle checked={f.active} onChange={(v) => setF('active', v)} label="This item is in use" hint="Switch off for items you no longer send. Old shipments and stock stay on record." /></Show>
        <h3>Usage rules</h3>
        <p class="muted small">K Line uses these to work out how much of this item each shipped case uses.</p>
        <div class="form-grid">
          <Field label="Used per case">{(p) => <input {...p} type="number" min={0} step="any" value={f.perCase} onInput={(e) => setF('perCase', e.currentTarget.value)} />}</Field>
          <Field label="Used per aligner">{(p) => <input {...p} type="number" min={0} step="any" value={f.perAligner} onInput={(e) => setF('perAligner', e.currentTarget.value)} />}</Field>
          <Field label="Minimum stock" hint="You are told when stock at a site drops below this.">{(p) => <input {...p} type="number" min={0} step="any" value={f.minStock} onInput={(e) => setF('minStock', e.currentTarget.value)} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}

interface LineDraft { materialId: string; quantity: string }

function DeclareDialog(props: { open: boolean; materials: Material[]; onClose: () => void; onDone: (text: string) => void }) {
  const org = createQuery(() => ({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), enabled: props.open, retry: false }));
  const sites = () => org.data?.sites ?? [];
  const [siteCode, setSiteCode] = createSignal('');
  const [carrier, setCarrier] = createSignal('');
  const [tracking, setTracking] = createSignal('');
  const [expected, setExpected] = createSignal('');
  const [lines, setLines] = createSignal<LineDraft[]>([{ materialId: '', quantity: '' }]);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<Record<string, FileStatus>>({});
  const [uploading, setUploading] = createSignal(false);
  const docs = usePending({ exts: ['pdf', 'jpg', 'jpeg', 'png'], maxFiles: MAX_SHIPMENT_DOCS, maxBytes: () => MAX_SHIPMENT_DOC_BYTES });

  createEffect(on(() => props.open, (open) => {
    if (!open) return;
    setError(null); setCarrier(''); setTracking(''); setExpected(''); setLines([{ materialId: '', quantity: '' }]); setStatus({}); docs.clear();
  }));
  createEffect(() => { if (props.open && !siteCode() && sites().length) setSiteCode(sites()[0]!.code); });

  const linesOk = () => lines().length > 0 && lines().every((l) => l.materialId && Number.isInteger(Number(l.quantity)) && Number(l.quantity) > 0);
  const dup = () => new Set(lines().map((l) => l.materialId)).size !== lines().length;
  const setLine = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, ...p } : x)));

  const m = createMutation(() => ({
    mutationFn: async () => {
      const res = await api<{ id?: string; shipment?: { id: string } }>('/api/material-shipments', {
        method: 'POST',
        body: {
          siteCode: siteCode(),
          ...(carrier().trim() ? { carrier: carrier().trim() } : {}), ...(tracking().trim() ? { tracking: tracking().trim() } : {}), ...(expected() ? { expectedDate: expected() } : {}),
          lines: lines().map((l) => ({ materialId: l.materialId, quantity: Number(l.quantity) })),
        },
      });
      const id = res?.shipment?.id ?? res?.id;
      let docsFailed = false;
      if (id && docs.pending.length) {
        setUploading(true);
        try { docsFailed = !(await uploadPending({ purpose: 'shipment', shipmentId: id }, docs.pending, (k, s) => setStatus((p) => ({ ...p, [k]: s })))); } catch { docsFailed = true; } finally { setUploading(false); }
      }
      return { docsFailed };
    },
    onSuccess: (r: { docsFailed: boolean }) => props.onDone(r.docsFailed ? 'The shipment was declared, but a document did not upload.' : 'The shipment was declared. K Line will check it when it arrives.'),
    onError: (e: unknown) => setError(e instanceof ApiError && e.code === 'org_not_approved' ? 'Shipments are locked until K Line approves your account.' : errorText(e)),
  }));

  return (
    <Dialog open={props.open} title="Declare a shipment" wide onClose={() => { if (!m.isPending) props.onClose(); }} dismissible={!m.isPending}
      footer={<><Button disabled={m.isPending} onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!siteCode() || !linesOk() || dup()} onClick={() => { setError(null); m.mutate(); }}>Declare the shipment</Button></>}>
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <p class="muted small">Tell K Line what you are sending and where. K Line counts what arrives and tells you if it differs.</p>
        <div class="form-grid">
          <Field label="Send to">
            {(p) => (
              <select {...p} value={siteCode()} onChange={(e) => setSiteCode(e.currentTarget.value)}>
                <option value="">Choose a site</option>
                <For each={sites()}>{(s) => <option value={s.code}>{s.code}, {s.name}</option>}</For>
              </select>
            )}
          </Field>
          <Field label="Carrier (optional)">{(p) => <input {...p} value={carrier()} maxLength={60} onInput={(e) => setCarrier(e.currentTarget.value)} />}</Field>
          <Field label="Tracking number (optional)">{(p) => <input {...p} value={tracking()} maxLength={100} onInput={(e) => setTracking(e.currentTarget.value)} />}</Field>
          <Field label="Expected arrival (optional)">{(p) => <input {...p} type="date" value={expected()} onInput={(e) => setExpected(e.currentTarget.value)} />}</Field>
        </div>
        <Show when={org.isError}><Notice tone="warn">{errorText(org.error)}</Notice></Show>
        <fieldset class="check-group">
          <legend>What is in the shipment</legend>
          <Index each={lines()}>
            {(l, i) => (
              <div class="inline-form">
                <div class="field grow">
                  <label for={`dl-m-${i}`} class="sr-only">Material {i + 1}</label>
                  <select id={`dl-m-${i}`} value={l().materialId} onChange={(e) => setLine(i, { materialId: e.currentTarget.value })}>
                    <option value="">Choose a material</option>
                    <For each={props.materials}>{(mm) => <option value={mm.id}>{mm.name} ({mm.sku})</option>}</For>
                  </select>
                </div>
                <div class="field" style={{ width: '130px' }}>
                  <label for={`dl-q-${i}`} class="sr-only">Quantity {i + 1}</label>
                  <input id={`dl-q-${i}`} type="number" min={1} step={1} placeholder="Quantity" value={l().quantity} onInput={(e) => setLine(i, { quantity: e.currentTarget.value })} />
                </div>
                <Button size="sm" disabled={lines().length === 1} onClick={() => setLines((ls) => ls.filter((_x, n) => n !== i))} aria-label={`Remove line ${i + 1}`}><Trash2 size={14} aria-hidden="true" /></Button>
              </div>
            )}
          </Index>
          <div><Button size="sm" onClick={() => setLines((ls) => [...ls, { materialId: '', quantity: '' }])}><Plus size={14} aria-hidden="true" /> Add another material</Button></div>
          <Show when={dup()}><p class="field-error">Each material can only appear once. Add the quantities together.</p></Show>
        </fieldset>
        <AttachmentPicker
          pending={docs.pending}
          problems={docs.problems}
          status={status()}
          onAdd={docs.add}
          onRemove={docs.remove}
          busy={uploading()}
          accept=".pdf,.jpg,.jpeg,.png"
          label="Attach a delivery note (optional)"
          hint="PDF, JPEG or PNG up to 25 MB each."
        />
      </div>
    </Dialog>
  );
}

export default function Materials() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [item, setItem] = createSignal<Material | null | 'new'>(null);
  const [declare, setDeclare] = createSignal(false);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [status, setStatus] = createSignal('');
  const [page, setPage] = createSignal(1);
  const [cancelId, setCancelId] = createSignal<string | null>(null);

  const mats = createQuery(() => ({ queryKey: ['materials'], queryFn: async () => normalizeMaterials(await api('/api/materials')) }));
  const ships = createQuery(() => ({ queryKey: ['material-shipments', status(), page()], queryFn: async () => normalizeShipmentPage(await api(`/api/material-shipments${qs({ status: status(), page: page(), pageSize: 25 })}`)) }));
  const refresh = () => { for (const k of ['materials', 'material-shipments']) qc.invalidateQueries({ queryKey: [k] }); };

  const cancel = createMutation(() => ({
    mutationFn: (id: string) => api(`/api/material-shipments/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => { setCancelId(null); setNotice({ tone: 'good', text: 'The shipment was cancelled.' }); refresh(); },
    onError: (e: unknown) => { setCancelId(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));

  const materials = () => mats.data ?? [];
  const inUse = createMemo(() => materials().filter((m) => m.active));
  const lowCount = createMemo(() => materials().reduce((n, m) => n + m.stock.filter((s) => isLow(m, s)).length, 0));

  return (
    <div class="page">
      <PageHeader
        title="Materials"
        subtitle="Boxes, bags and other things you send to K Line to pack with your aligners."
        actions={
          <>
            <Show when={can('material.manage')}><Button onClick={() => setItem('new')}><Plus size={16} aria-hidden="true" /> Add an item</Button></Show>
            <Show when={can('material.declare')}><Button variant="primary" disabled={inUse().length === 0} onClick={() => setDeclare(true)} title={inUse().length === 0 ? 'Add an item first' : undefined}><Truck size={16} aria-hidden="true" /> Declare a shipment</Button></Show>
          </>
        }
      />
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <Show when={mats.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => mats.refetch()}>Try again</Button>}>{errorText(mats.error)}</Notice></Show>
      <Show when={lowCount() > 0}><Notice tone="warn" title="Some stock is low">{formatNumber(lowCount())} {lowCount() === 1 ? 'item is' : 'items are'} below the minimum at a site. Declare a shipment to top up.</Notice></Show>
      <Show when={mats.isLoading}><Spinner /></Show>

      <Show when={mats.data}>
        <Card title="Stock at K Line">
          <StockTable materials={inUse()} />
        </Card>

        <Card title="Items and usage rules">
          <Show
            when={materials().length > 0}
            fallback={<Empty title="No items yet" action={can('material.manage') ? <Button variant="primary" onClick={() => setItem('new')}><PackagePlus size={16} aria-hidden="true" /> Add your first item</Button> : undefined}>Add the boxes, bags and inserts you send, and how many each case uses.</Empty>}
          >
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Item</th><th>Category</th><th class="num">Per case</th><th class="num">Per aligner</th><th class="num">Minimum stock</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  <For each={materials()}>
                    {(m) => (
                      <tr>
                        <td><strong>{m.name}</strong> {m.active ? null : <Badge>Not in use</Badge>}<div class="muted small">{m.sku}</div></td>
                        <td>{categoryLabel(m.category)}</td>
                        <td class="num">{formatNumber(m.perCase)}</td>
                        <td class="num">{formatNumber(m.perAligner)}</td>
                        <td class="num">{formatNumber(m.minStock)}</td>
                        <td class="right">{can('material.manage') ? <Button size="sm" onClick={() => setItem(m)} aria-label={`Change ${m.name}`}><Pencil size={14} aria-hidden="true" /> Change</Button> : null}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Card>
      </Show>

      <Card title="Shipments" actions={
        <div class="field" style={{ 'min-width': '180px' }}>
          <label for="ship-status" class="sr-only">Filter shipments</label>
          <select id="ship-status" value={status()} onChange={(e) => { setStatus(e.currentTarget.value); setPage(1); }}>
            <option value="">All shipments</option>
            <option value="in_transit">On their way</option>
            <option value="received">Received</option>
            <option value="discrepancy">Received with differences</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      }>
        <Show when={ships.isLoading}><Spinner /></Show>
        <Show when={ships.isError}><Notice tone="bad">{errorText(ships.error)}</Notice></Show>
        <Show when={ships.data && ships.data.items.length === 0}><Empty title="No shipments">Shipments you declare will show up here.</Empty></Show>
        <div class="stack">
          <For each={ships.data?.items}>
            {(s) => (
              <details class="case-row" open={s.status === 'discrepancy'}>
                <summary>
                  <div class="case-sum">
                    <span class="id">{s.number}</span>
                    <Badge tone={shipmentStatusTone(s.status)}>{shipmentStatusLabel(s.status)}</Badge>
                    <span class="muted small">To {s.siteCode}</span>
                    {s.expectedDate && s.status === 'in_transit' ? <span class="muted small">Expected {formatDate(s.expectedDate)}</span> : null}
                    {s.receivedAt ? <span class="muted small">Received {formatDate(s.receivedAt)}</span> : null}
                  </div>
                </summary>
                <div class="case-body">
                  <dl class="facts">
                    <dt>Carrier</dt><dd>{s.carrier ?? 'Not given'}</dd>
                    <dt>Tracking number</dt><dd>{s.tracking ? <span class="mono">{s.tracking}</span> : 'Not given'}</dd>
                    <dt>Declared</dt><dd>{formatDate(s.createdAt)}</dd>
                    {s.note ? <><dt>Note from K Line</dt><dd style={{ 'white-space': 'pre-wrap' }}>{s.note}</dd></> : null}
                  </dl>
                  {s.status === 'discrepancy' ? <Notice tone="warn" title="What arrived differs from what you declared">The highlighted lines show the difference. Stock was booked with the quantities K Line counted.</Notice> : null}
                  <ShipmentLines s={s} highlight />
                  {s.status === 'in_transit' && can('material.declare') ? <div><Button onClick={() => setCancelId(s.id)}>Cancel this shipment</Button></div> : null}
                </div>
              </details>
            )}
          </For>
        </div>
        <Show when={ships.data}>{(d) => <Pagination page={page()} pageSize={d().pageSize} total={d().total} onPage={setPage} />}</Show>
      </Card>

      <ItemDialog open={item() !== null} item={item() === 'new' ? null : (item() as Material | null)} onClose={() => setItem(null)} onDone={() => { setItem(null); setNotice({ tone: 'good', text: 'The item was saved.' }); refresh(); }} />
      <DeclareDialog open={declare()} materials={inUse()} onClose={() => setDeclare(false)} onDone={(text) => { setDeclare(false); setNotice({ tone: text.includes('did not') ? 'bad' : 'good', text }); refresh(); }} />
      <Dialog open={!!cancelId()} title="Cancel this shipment?" onClose={() => setCancelId(null)} footer={<><Button onClick={() => setCancelId(null)}>Keep it</Button><Button variant="danger" loading={cancel.isPending} onClick={() => { const id = cancelId(); if (id) cancel.mutate(id); }}>Cancel the shipment</Button></>}>
        <p>Only shipments that are still on their way can be cancelled. Tell K Line if the parcel has already left.</p>
      </Dialog>
    </div>
  );
}

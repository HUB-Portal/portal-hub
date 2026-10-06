import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, PackagePlus, Pencil, Plus, Trash2, Truck } from 'lucide-react';
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

export function StockTable({ materials, showOrg }: { materials: Material[]; showOrg?: boolean }) {
  const rows: { m: Material; s: StockRow | null }[] = materials.flatMap((m): { m: Material; s: StockRow | null }[] => (m.stock.length ? m.stock.map((s) => ({ m, s })) : [{ m, s: null }]));
  if (!rows.length) return <Empty title="No materials yet">Materials appear here once they are set up.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{showOrg ? <th>Partner</th> : null}<th>Material</th><th>Site</th><th className="num">On hand</th><th className="num">On the way</th><th className="num">Used in 28 days</th><th>Days of cover</th><th>Minimum</th></tr>
        </thead>
        <tbody>
          {rows.map(({ m, s }, i) => {
            const low = s ? isLow(m, s) : false;
            const short = s && s.daysOfCover !== null && s.daysOfCover < 14;
            return (
              <tr key={`${m.id}|${s?.siteCode ?? 'none'}|${i}`} className={low ? 'row-low' : undefined}>
                {showOrg ? <td>{m.orgName ?? ''}</td> : null}
                <td><strong>{m.name}</strong><div className="muted small">{m.sku}, {categoryLabel(m.category)}</div></td>
                <td>{s ? s.siteCode : <span className="muted">No stock recorded</span>}</td>
                <td className="num">{s ? <>{formatNumber(s.onHand)} <span className="muted small">{m.unit}</span></> : ''}</td>
                <td className="num">{s ? formatNumber(s.inTransit) : ''}</td>
                <td className="num">{s ? formatNumber(s.used28d) : ''}</td>
                <td>{s ? <span className={short ? 'late' : undefined}>{coverText(s.daysOfCover)}</span> : ''}</td>
                <td>{m.minStock ? <>{formatNumber(m.minStock)} {low ? <Badge tone="bad"><AlertTriangle size={12} aria-hidden="true" /> Low stock</Badge> : null}</> : <span className="muted">Not set</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ShipmentLines({ s, highlight }: { s: Shipment; highlight?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Material</th><th className="num">Declared</th><th className="num">Received</th><th className="num">Difference</th></tr></thead>
        <tbody>
          {s.lines.map((l) => {
            const diff = l.receivedQuantity === null ? null : l.receivedQuantity - l.quantity;
            return (
              <tr key={l.id || l.materialId} className={highlight && diff !== null && diff !== 0 ? 'row-low' : undefined}>
                <td>{l.name ?? 'Material'}{l.sku ? <span className="muted small"> {l.sku}</span> : null}</td>
                <td className="num">{formatNumber(l.quantity)}</td>
                <td className="num">{l.receivedQuantity === null ? <span className="muted">Not received</span> : formatNumber(l.receivedQuantity)}</td>
                <td className="num">{diff === null ? '' : diff === 0 ? <Badge tone="good">Matches</Badge> : <Badge tone="warn">{diff > 0 ? '+' : ''}{formatNumber(diff)}</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ItemDialog({ open, item, onClose, onDone }: { open: boolean; item: Material | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ sku: '', name: '', category: 'box', unit: 'pieces', perCase: '0', perAligner: '0', minStock: '0', active: true });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(item ? { sku: item.sku, name: item.name, category: item.category, unit: item.unit, perCase: String(item.perCase), perAligner: String(item.perAligner), minStock: String(item.minStock), active: item.active } : { sku: '', name: '', category: 'box', unit: 'pieces', perCase: '0', perAligner: '0', minStock: '0', active: true });
  }, [open, item]);
  const n = (v: string) => Number(v);
  const bad = !f.sku.trim() || !f.name.trim() || [f.perCase, f.perAligner, f.minStock].some((v) => v === '' || !(n(v) >= 0));
  const m = useMutation({
    mutationFn: () => api(item ? `/api/materials/${item.id}` : '/api/materials', {
      method: item ? 'PATCH' : 'POST',
      body: { sku: f.sku.trim(), name: f.name.trim(), category: f.category, unit: f.unit.trim() || 'pieces', perCase: n(f.perCase), perAligner: n(f.perAligner), minStock: n(f.minStock), ...(item ? { active: f.active } : {}) },
    }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError && e.code === 'sku_exists' ? 'You already have an item with this SKU.' : errorText(e)),
  });
  return (
    <Dialog open={open} title={item ? 'Change this item' : 'Add an item'} wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={bad} onClick={() => { setError(null); m.mutate(); }}>{item ? 'Save' : 'Add item'}</Button></>}>
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="form-grid">
          <Field label="SKU" hint="Your own code for this item. It must be unique.">{(p) => <input {...p} value={f.sku} maxLength={60} onChange={(e) => setF({ ...f, sku: e.target.value })} />}</Field>
          <Field label="Name">{(p) => <input {...p} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Category">{(p) => <select {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{MATERIAL_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>}</Field>
          <Field label="Unit" hint="For example pieces or boxes.">{(p) => <input {...p} value={f.unit} maxLength={20} onChange={(e) => setF({ ...f, unit: e.target.value })} />}</Field>
        </div>
        {item ? <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="This item is in use" hint="Switch off for items you no longer send. Old shipments and stock stay on record." /> : null}
        <h3>Usage rules</h3>
        <p className="muted small">K Line uses these to work out how much of this item each shipped case uses.</p>
        <div className="form-grid">
          <Field label="Used per case">{(p) => <input {...p} type="number" min={0} step="any" value={f.perCase} onChange={(e) => setF({ ...f, perCase: e.target.value })} />}</Field>
          <Field label="Used per aligner">{(p) => <input {...p} type="number" min={0} step="any" value={f.perAligner} onChange={(e) => setF({ ...f, perAligner: e.target.value })} />}</Field>
          <Field label="Minimum stock" hint="You are told when stock at a site drops below this.">{(p) => <input {...p} type="number" min={0} step="any" value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}

interface LineDraft { materialId: string; quantity: string }

function DeclareDialog({ open, materials, onClose, onDone }: { open: boolean; materials: Material[]; onClose: () => void; onDone: (text: string) => void }) {
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), enabled: open, retry: false });
  const sites = org.data?.sites ?? [];
  const [siteCode, setSiteCode] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [expected, setExpected] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ materialId: '', quantity: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [uploading, setUploading] = useState(false);
  const docs = usePending({ exts: ['pdf', 'jpg', 'jpeg', 'png'], maxFiles: MAX_SHIPMENT_DOCS, maxBytes: () => MAX_SHIPMENT_DOC_BYTES });

  useEffect(() => {
    if (!open) return;
    setError(null); setCarrier(''); setTracking(''); setExpected(''); setLines([{ materialId: '', quantity: '' }]); setStatus({}); docs.clear();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && !siteCode && sites.length) setSiteCode(sites[0]!.code); }, [open, siteCode, sites]);

  const linesOk = lines.length > 0 && lines.every((l) => l.materialId && Number.isInteger(Number(l.quantity)) && Number(l.quantity) > 0);
  const dup = new Set(lines.map((l) => l.materialId)).size !== lines.length;

  const m = useMutation({
    mutationFn: async () => {
      const res = await api<{ id?: string; shipment?: { id: string } }>('/api/material-shipments', {
        method: 'POST',
        body: {
          siteCode,
          ...(carrier.trim() ? { carrier: carrier.trim() } : {}), ...(tracking.trim() ? { tracking: tracking.trim() } : {}), ...(expected ? { expectedDate: expected } : {}),
          lines: lines.map((l) => ({ materialId: l.materialId, quantity: Number(l.quantity) })),
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
    onSuccess: (r) => onDone(r.docsFailed ? 'The shipment was declared, but a document did not upload.' : 'The shipment was declared. K Line will check it when it arrives.'),
    onError: (e) => setError(e instanceof ApiError && e.code === 'org_not_approved' ? 'Shipments are locked until K Line approves your account.' : errorText(e)),
  });

  return (
    <Dialog open={open} title="Declare a shipment" wide onClose={() => { if (!m.isPending) onClose(); }} dismissible={!m.isPending}
      footer={<><Button disabled={m.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!siteCode || !linesOk || dup} onClick={() => { setError(null); m.mutate(); }}>Declare the shipment</Button></>}>
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p className="muted small">Tell K Line what you are sending and where. K Line counts what arrives and tells you if it differs.</p>
        <div className="form-grid">
          <Field label="Send to">
            {(p) => (
              <select {...p} value={siteCode} onChange={(e) => setSiteCode(e.target.value)}>
                <option value="">Choose a site</option>
                {sites.map((s) => <option key={s.code} value={s.code}>{s.code}, {s.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Carrier (optional)">{(p) => <input {...p} value={carrier} maxLength={60} onChange={(e) => setCarrier(e.target.value)} />}</Field>
          <Field label="Tracking number (optional)">{(p) => <input {...p} value={tracking} maxLength={100} onChange={(e) => setTracking(e.target.value)} />}</Field>
          <Field label="Expected arrival (optional)">{(p) => <input {...p} type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />}</Field>
        </div>
        {org.isError ? <Notice tone="warn">{errorText(org.error)}</Notice> : null}
        <fieldset className="check-group">
          <legend>What is in the shipment</legend>
          {lines.map((l, i) => (
            <div className="inline-form" key={i}>
              <div className="field grow">
                <label htmlFor={`dl-m-${i}`} className="sr-only">Material {i + 1}</label>
                <select id={`dl-m-${i}`} value={l.materialId} onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, materialId: e.target.value } : x)))}>
                  <option value="">Choose a material</option>
                  {materials.map((mm) => <option key={mm.id} value={mm.id}>{mm.name} ({mm.sku})</option>)}
                </select>
              </div>
              <div className="field" style={{ width: 130 }}>
                <label htmlFor={`dl-q-${i}`} className="sr-only">Quantity {i + 1}</label>
                <input id={`dl-q-${i}`} type="number" min={1} step={1} placeholder="Quantity" value={l.quantity} onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} />
              </div>
              <Button size="sm" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_x, n) => n !== i))} aria-label={`Remove line ${i + 1}`}><Trash2 size={14} aria-hidden="true" /></Button>
            </div>
          ))}
          <div><Button size="sm" onClick={() => setLines([...lines, { materialId: '', quantity: '' }])}><Plus size={14} aria-hidden="true" /> Add another material</Button></div>
          {dup ? <p className="field-error">Each material can only appear once. Add the quantities together.</p> : null}
        </fieldset>
        <AttachmentPicker
          pending={docs.pending}
          problems={docs.problems}
          status={status}
          onAdd={docs.add}
          onRemove={docs.remove}
          busy={uploading}
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
  const [item, setItem] = useState<Material | null | 'new'>(null);
  const [declare, setDeclare] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const mats = useQuery({ queryKey: ['materials'], queryFn: async () => normalizeMaterials(await api('/api/materials')) });
  const ships = useQuery({ queryKey: ['material-shipments', status, page], queryFn: async () => normalizeShipmentPage(await api(`/api/material-shipments${qs({ status, page, pageSize: 25 })}`)) });
  const refresh = () => { for (const k of ['materials', 'material-shipments']) qc.invalidateQueries({ queryKey: [k] }); };

  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/material-shipments/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => { setCancelId(null); setNotice({ tone: 'good', text: 'The shipment was cancelled.' }); refresh(); },
    onError: (e) => { setCancelId(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });

  const materials = mats.data ?? [];
  const inUse = useMemo(() => materials.filter((m) => m.active), [materials]);
  const lowCount = useMemo(() => materials.reduce((n, m) => n + m.stock.filter((s) => isLow(m, s)).length, 0), [materials]);

  return (
    <div className="page">
      <PageHeader
        title="Materials"
        subtitle="Boxes, bags and other things you send to K Line to pack with your aligners."
        actions={
          <>
            {can('material.manage') ? <Button onClick={() => setItem('new')}><Plus size={16} aria-hidden="true" /> Add an item</Button> : null}
            {can('material.declare') ? <Button variant="primary" disabled={inUse.length === 0} onClick={() => setDeclare(true)} title={inUse.length === 0 ? 'Add an item first' : undefined}><Truck size={16} aria-hidden="true" /> Declare a shipment</Button> : null}
          </>
        }
      />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {mats.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => mats.refetch()}>Try again</Button>}>{errorText(mats.error)}</Notice> : null}
      {lowCount > 0 ? <Notice tone="warn" title="Some stock is low">{formatNumber(lowCount)} {lowCount === 1 ? 'item is' : 'items are'} below the minimum at a site. Declare a shipment to top up.</Notice> : null}
      {mats.isLoading ? <Spinner /> : null}

      {mats.data ? (
        <>
          <Card title="Stock at K Line">
            <StockTable materials={inUse} />
          </Card>

          <Card title="Items and usage rules">
            {materials.length === 0 ? (
              <Empty title="No items yet" action={can('material.manage') ? <Button variant="primary" onClick={() => setItem('new')}><PackagePlus size={16} aria-hidden="true" /> Add your first item</Button> : undefined}>Add the boxes, bags and inserts you send, and how many each case uses.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Item</th><th>Category</th><th className="num">Per case</th><th className="num">Per aligner</th><th className="num">Minimum stock</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {materials.map((m) => (
                      <tr key={m.id}>
                        <td><strong>{m.name}</strong> {m.active ? null : <Badge>Not in use</Badge>}<div className="muted small">{m.sku}</div></td>
                        <td>{categoryLabel(m.category)}</td>
                        <td className="num">{formatNumber(m.perCase)}</td>
                        <td className="num">{formatNumber(m.perAligner)}</td>
                        <td className="num">{formatNumber(m.minStock)}</td>
                        <td className="right">{can('material.manage') ? <Button size="sm" onClick={() => setItem(m)} aria-label={`Change ${m.name}`}><Pencil size={14} aria-hidden="true" /> Change</Button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}

      <Card title="Shipments" actions={
        <div className="field" style={{ minWidth: 180 }}>
          <label htmlFor="ship-status" className="sr-only">Filter shipments</label>
          <select id="ship-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All shipments</option>
            <option value="in_transit">On their way</option>
            <option value="received">Received</option>
            <option value="discrepancy">Received with differences</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      }>
        {ships.isLoading ? <Spinner /> : null}
        {ships.isError ? <Notice tone="bad">{errorText(ships.error)}</Notice> : null}
        {ships.data && ships.data.items.length === 0 ? <Empty title="No shipments">Shipments you declare will show up here.</Empty> : null}
        <div className="stack">
          {ships.data?.items.map((s) => (
            <details key={s.id} className="case-row" open={s.status === 'discrepancy'}>
              <summary>
                <div className="case-sum">
                  <span className="id">{s.number}</span>
                  <Badge tone={shipmentStatusTone(s.status)}>{shipmentStatusLabel(s.status)}</Badge>
                  <span className="muted small">To {s.siteCode}</span>
                  {s.expectedDate && s.status === 'in_transit' ? <span className="muted small">Expected {formatDate(s.expectedDate)}</span> : null}
                  {s.receivedAt ? <span className="muted small">Received {formatDate(s.receivedAt)}</span> : null}
                </div>
              </summary>
              <div className="case-body">
                <dl className="facts">
                  <dt>Carrier</dt><dd>{s.carrier ?? 'Not given'}</dd>
                  <dt>Tracking number</dt><dd>{s.tracking ? <span className="mono">{s.tracking}</span> : 'Not given'}</dd>
                  <dt>Declared</dt><dd>{formatDate(s.createdAt)}</dd>
                  {s.note ? <><dt>Note from K Line</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{s.note}</dd></> : null}
                </dl>
                {s.status === 'discrepancy' ? <Notice tone="warn" title="What arrived differs from what you declared">The highlighted lines show the difference. Stock was booked with the quantities K Line counted.</Notice> : null}
                <ShipmentLines s={s} highlight />
                {s.status === 'in_transit' && can('material.declare') ? <div><Button onClick={() => setCancelId(s.id)}>Cancel this shipment</Button></div> : null}
              </div>
            </details>
          ))}
        </div>
        {ships.data ? <Pagination page={page} pageSize={ships.data.pageSize} total={ships.data.total} onPage={setPage} /> : null}
      </Card>

      <ItemDialog open={item !== null} item={item === 'new' ? null : item} onClose={() => setItem(null)} onDone={() => { setItem(null); setNotice({ tone: 'good', text: 'The item was saved.' }); refresh(); }} />
      <DeclareDialog open={declare} materials={inUse} onClose={() => setDeclare(false)} onDone={(text) => { setDeclare(false); setNotice({ tone: text.includes('did not') ? 'bad' : 'good', text }); refresh(); }} />
      <Dialog open={!!cancelId} title="Cancel this shipment?" onClose={() => setCancelId(null)} footer={<><Button onClick={() => setCancelId(null)}>Keep it</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancelId && cancel.mutate(cancelId)}>Cancel the shipment</Button></>}>
        <p>Only shipments that are still on their way can be cancelled. Tell K Line if the parcel has already left.</p>
      </Dialog>
    </div>
  );
}

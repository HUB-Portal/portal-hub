import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, SlidersHorizontal } from 'lucide-react';
import { api, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilterOptions, useSites } from '../../lib/console';
import { formatDate, formatNumber } from '../../lib/format';
import { normalizeMaterials, normalizeShipmentPage, shipmentStatusLabel, shipmentStatusTone, type Material, type Shipment } from '../../lib/quality';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';
import { ShipmentLines, StockTable } from '../partner/Materials';

function ReceiveDialog({ shipment, onClose, onDone }: { shipment: Shipment | null; onClose: () => void; onDone: (text: string) => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!shipment) return;
    setQty(Object.fromEntries(shipment.lines.map((l) => [l.id, String(l.quantity)])));
    setNote('');
    setError(null);
  }, [shipment]);

  const valid = !!shipment && shipment.lines.every((l) => qty[l.id] !== undefined && qty[l.id] !== '' && Number.isInteger(Number(qty[l.id])) && Number(qty[l.id]) >= 0);
  const differs = !!shipment && shipment.lines.some((l) => Number(qty[l.id]) !== l.quantity);
  const m = useMutation({
    mutationFn: () => api<{ status?: string; shipment?: { status?: string } }>(`/api/console/material-shipments/${shipment!.id}/receive`, {
      method: 'POST',
      body: { lines: shipment!.lines.map((l) => ({ lineId: l.id, receivedQuantity: Number(qty[l.id]) })), ...(note.trim() ? { note: note.trim() } : {}) },
    }),
    onSuccess: () => onDone(differs ? `${shipment!.number} was booked in with differences. The partner has been told.` : `${shipment!.number} was booked in.`),
    onError: (e) => setError(errorText(e)),
  });

  return (
    <Dialog
      open={!!shipment}
      title={shipment ? `Receive ${shipment.number}` : 'Receive'}
      wide
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!valid} onClick={() => { setError(null); m.mutate(); }}>{differs ? 'Book in with differences' : 'Book in'}</Button></>}
    >
      {shipment ? (
        <div className="stack">
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <p className="muted small">{shipment.orgName ? `${shipment.orgName}, ` : ''}to {shipment.siteCode}. Count what arrived and enter it. Stock is booked with these numbers.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Material</th><th className="num">Declared</th><th>Received</th><th>Difference</th></tr></thead>
              <tbody>
                {shipment.lines.map((l) => {
                  const diff = Number(qty[l.id] ?? l.quantity) - l.quantity;
                  return (
                    <tr key={l.id} className={diff !== 0 ? 'row-low' : undefined}>
                      <td>{l.name ?? 'Material'}{l.sku ? <span className="muted small"> {l.sku}</span> : null}</td>
                      <td className="num">{formatNumber(l.quantity)}</td>
                      <td style={{ width: 140 }}>
                        <label className="sr-only" htmlFor={`rq-${l.id}`}>Received quantity for {l.name ?? 'material'}</label>
                        <input id={`rq-${l.id}`} type="number" min={0} step={1} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
                      </td>
                      <td>{diff === 0 ? <Badge tone="good">Matches</Badge> : <Badge tone="warn">{diff > 0 ? '+' : ''}{formatNumber(diff)}</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {differs ? <Notice tone="warn" title="The counts differ from what was declared">The shipment is marked as received with differences and the partner is told. Add a note to explain.</Notice> : null}
          <Field label="Note for the partner (optional)" hint="For example: one box arrived damaged.">
            {(p) => <textarea {...p} value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      ) : null}
    </Dialog>
  );
}

function AdjustDialog({ open, orgId, materials, onClose, onDone }: { open: boolean; orgId: string; materials: Material[]; onClose: () => void; onDone: () => void }) {
  const sites = useSites();
  const [materialId, setMaterialId] = useState('');
  const [siteCode, setSiteCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setMaterialId(''); setSiteCode(''); setQuantity(''); setReason(''); setError(null); } }, [open]);

  const material = materials.find((m) => m.id === materialId);
  const siteOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of materials) for (const s of m.stock) set.add(s.siteCode);
    for (const s of sites.data?.sites ?? []) if (s.active) set.add(s.code);
    return [...set].sort();
  }, [materials, sites.data]);
  const current = material?.stock.find((s) => s.siteCode === siteCode);
  const q = Number(quantity);
  const valid = !!materialId && !!siteCode && quantity !== '' && Number.isInteger(q) && q !== 0 && reason.trim().length >= 3;

  const m = useMutation({
    mutationFn: () => api('/api/console/materials/adjust', { method: 'POST', body: { orgId, materialId, siteCode, quantity: q, reason: reason.trim() } }),
    onSuccess: onDone,
    onError: (e) => setError(errorText(e)),
  });

  return (
    <Dialog open={open} title="Correct stock" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!valid} onClick={() => { setError(null); m.mutate(); }}>Book the correction</Button></>}>
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Material">
          {(p) => <select {...p} value={materialId} onChange={(e) => setMaterialId(e.target.value)}><option value="">Choose a material</option>{materials.map((mm) => <option key={mm.id} value={mm.id}>{mm.name} ({mm.sku})</option>)}</select>}
        </Field>
        <Field label="Site">
          {(p) => <select {...p} value={siteCode} onChange={(e) => setSiteCode(e.target.value)}><option value="">Choose a site</option>{siteOptions.map((s) => <option key={s} value={s}>{s}</option>)}</select>}
        </Field>
        {material && siteCode ? <p className="small muted">On hand now: {formatNumber(current?.onHand ?? 0)} {material.unit}.</p> : null}
        <Field label="Change in quantity" hint="Use a plus number to add stock and a minus number to remove it. For example -12 after a count.">
          {(p) => <input {...p} type="number" step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
        </Field>
        {material && current && Number.isInteger(q) && q !== 0 ? <p className="small">New stock will be <strong>{formatNumber(current.onHand + q)}</strong> {material.unit}.</p> : null}
        <Field label="Reason" hint="Recorded in the audit log and shown to the partner.">
          {(p) => <input {...p} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export default function ConsoleMaterials() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stock' ? 'stock' : 'shipments';
  const status = params.get('status') ?? 'in_transit';
  const siteCode = params.get('siteCode') ?? '';
  const orgId = params.get('orgId') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const [receiving, setReceiving] = useState<Shipment | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const opts = useFilterOptions();

  const ships = useQuery({
    queryKey: ['console-material-shipments', { status, siteCode, page }],
    queryFn: async () => normalizeShipmentPage(await api(`/api/console/material-shipments${qs({ status: status === 'all' ? '' : status, siteCode, page, pageSize: 25 })}`)),
  });
  const mats = useQuery({
    queryKey: ['console-materials', orgId],
    enabled: tab === 'stock',
    queryFn: async () => normalizeMaterials(await api(`/api/console/materials${qs({ orgId })}`)),
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }
  const refresh = () => { for (const k of ['console-material-shipments', 'console-materials']) qc.invalidateQueries({ queryKey: [k] }); };

  // Staff who cannot list partners still see the partners that have shipments.
  const partnerOptions = useMemo(() => {
    const map = new Map(opts.partners.map((p) => [p.id, p.name]));
    for (const s of ships.data?.items ?? []) if (s.orgId && !map.has(s.orgId)) map.set(s.orgId, s.orgName ?? 'Partner');
    for (const m of mats.data ?? []) if (m.orgId && !map.has(m.orgId)) map.set(m.orgId, m.orgName ?? 'Partner');
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [opts.partners, ships.data, mats.data]);
  const canReceive = can('material.receive');

  return (
    <div className="page">
      <PageHeader title="Partner materials" subtitle="Receive the boxes, bags and inserts partners send, and keep their stock right." />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <div className="tabs" role="group" aria-label="Section">
        <button type="button" className="tab" aria-pressed={tab === 'shipments'} onClick={() => setParam('tab', '')}>Shipments</button>
        <button type="button" className="tab" aria-pressed={tab === 'stock'} onClick={() => setParam('tab', 'stock')}>Stock</button>
      </div>

      {tab === 'shipments' ? (
        <Card>
          <div className="toolbar">
            <div className="field" style={{ minWidth: 170, flexBasis: 200 }}>
              <label htmlFor="ms-status">Status</label>
              <select id="ms-status" value={status} onChange={(e) => setParam('status', e.target.value || 'all')}>
                <option value="in_transit">On their way</option>
                <option value="discrepancy">Received with differences</option>
                <option value="received">Received</option>
                <option value="cancelled">Cancelled</option>
                <option value="all">Any status</option>
              </select>
            </div>
            <div className="field" style={{ minWidth: 130, flexBasis: 140 }}>
              <label htmlFor="ms-site">Site</label>
              <select id="ms-site" value={siteCode} onChange={(e) => setParam('siteCode', e.target.value)}>
                <option value="">All sites</option>
                {opts.siteCodes.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          {ships.isLoading ? <Spinner /> : null}
          {ships.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => ships.refetch()}>Try again</Button>}>{errorText(ships.error)}</Notice> : null}
          {ships.data && ships.data.items.length === 0 ? <Empty title="No shipments here">{status === 'in_transit' ? 'Nothing is on its way right now.' : 'Try a different filter.'}</Empty> : null}
          <div className="stack">
            {ships.data?.items.map((s) => (
              <details key={s.id} className="case-row" open={s.status === 'in_transit' || s.status === 'discrepancy'}>
                <summary>
                  <div className="case-sum">
                    <span className="id">{s.number}</span>
                    <Badge tone={shipmentStatusTone(s.status)}>{shipmentStatusLabel(s.status)}</Badge>
                    <span>{s.orgName ?? ''}</span>
                    <span className="muted small">To {s.siteCode}</span>
                    {s.expectedDate && s.status === 'in_transit' ? <span className="muted small">Expected {formatDate(s.expectedDate)}</span> : null}
                  </div>
                </summary>
                <div className="case-body">
                  <dl className="facts">
                    <dt>Carrier</dt><dd>{s.carrier ?? 'Not given'}</dd>
                    <dt>Tracking number</dt><dd>{s.tracking ? <span className="mono">{s.tracking}</span> : 'Not given'}</dd>
                    <dt>Declared</dt><dd>{formatDate(s.createdAt)}</dd>
                    {s.receivedAt ? <><dt>Received</dt><dd>{formatDate(s.receivedAt)}</dd></> : null}
                    {s.note ? <><dt>Note</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{s.note}</dd></> : null}
                  </dl>
                  <ShipmentLines s={s} highlight />
                  {s.status === 'in_transit' && canReceive ? <div><Button variant="primary" onClick={() => setReceiving(s)}><ClipboardCheck size={16} aria-hidden="true" /> Receive</Button></div> : null}
                </div>
              </details>
            ))}
          </div>
          {ships.data ? <Pagination page={page} pageSize={ships.data.pageSize} total={ships.data.total} onPage={(p) => setParam('page', String(p))} /> : null}
        </Card>
      ) : (
        <Card
          title="Stock by partner"
          actions={canReceive && mats.data && mats.data.length ? <Button disabled={!orgId} title={orgId ? undefined : 'Choose a partner first'} onClick={() => setAdjust(true)}><SlidersHorizontal size={16} aria-hidden="true" /> Correct stock</Button> : undefined}
        >
          <div className="toolbar">
            <div className="field" style={{ minWidth: 200, flexBasis: 260 }}>
              <label htmlFor="ms-partner">Partner</label>
              <select id="ms-partner" value={orgId} onChange={(e) => setParam('orgId', e.target.value)}>
                <option value="">All partners</option>
                {partnerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          {!orgId && canReceive ? <p className="muted small">Choose one partner to correct their stock.</p> : null}
          {mats.isLoading ? <Spinner /> : null}
          {mats.isError ? <Notice tone="bad">{errorText(mats.error)}</Notice> : null}
          {mats.data ? <StockTable materials={mats.data} showOrg={!orgId} /> : null}
        </Card>
      )}

      <ReceiveDialog shipment={receiving} onClose={() => setReceiving(null)} onDone={(text) => { setReceiving(null); setNotice({ tone: 'good', text }); refresh(); }} />
      <AdjustDialog open={adjust} orgId={orgId} materials={mats.data ?? []} onClose={() => setAdjust(false)} onDone={() => { setAdjust(false); setNotice({ tone: 'good', text: 'The correction was booked.' }); refresh(); }} />
    </div>
  );
}

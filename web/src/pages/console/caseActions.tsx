import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText } from '../../lib/api';
import { STAGES, stageLabel } from '../../lib/stages';
import type { CaseItem, Routing } from '../../lib/types';
import { Button, Dialog, Field, Notice } from '../../ui/Common';

export const HOLD_MIN = 3;
export const HOLD_MAX = 500;

/** Refresh every list and detail query that shows a case. */
export function useInvalidateCases() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['console-cases', 'console-case', 'intake', 'console-overview', 'case', 'cases']) qc.invalidateQueries({ queryKey: [k] });
  };
}

function routeErrorText(e: unknown): { title: string; text: string } {
  if (e instanceof ApiError && e.code === 'transfer_blocked') {
    return {
      title: 'The transfer gate blocked this',
      text: e.message || 'This partner is in the EEA and the site cannot legally receive their cases. Choose a site in the EEA or a country with an adequacy decision, or record Standard Contractual Clauses for the partner first.',
    };
  }
  return { title: 'Could not send the case', text: errorText(e) };
}

/** Sites come with the case: the intake list sends `sites`, the case page sends `routing.sites`. */
export function RouteDialog({ c, routing, open, onClose, onDone }: { c: CaseItem; routing?: Routing | null; open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [site, setSite] = useState('');
  const [error, setError] = useState<{ title: string; text: string } | null>(null);

  const options = c.sites ?? routing?.sites ?? [];
  const defaultSite = c.defaultSiteCode ?? routing?.defaultSiteCode ?? '';
  const changing = c.status === 'ready';

  useEffect(() => { if (open) { setError(null); setSite(''); } }, [open]);
  useEffect(() => {
    if (open && !site && defaultSite && options.some((o) => o.code === defaultSite && o.allowed !== false)) setSite(defaultSite);
  }, [open, site, defaultSite, options]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMutation({
    mutationFn: () => api(`/api/cases/${c.id}/route`, { method: 'POST', body: { siteCode: site } }),
    onSuccess: () => onDone(changing ? `${c.ref} now goes to ${site}.` : `${c.ref} was sent to ${site} and is ready for the factory.`),
    onError: (e) => setError(routeErrorText(e)),
  });

  return (
    <Dialog
      open={open}
      title={changing ? `Change the site of ${c.ref}` : `Send ${c.ref} to a site`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!site} onClick={() => { setError(null); m.mutate(); }}>{changing ? 'Change site' : 'Send to site'}</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad" title={error.title}>{error.text}</Notice> : null}
        <p>{c.orgName ? `${c.orgName}, ` : ''}case {c.caseId ?? c.ref}. {changing ? `It is at ${c.siteCode ?? 'a site'} now. The due date stays the same.` : 'The due date is counted from today in business days.'}</p>
        <Field label="Site" hint="The factory that will make this case. Only active sites the partner may use can be chosen.">
          {(p) => (
            <select {...p} value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">Choose a site</option>
              {options.map((s) => <option key={s.code} value={s.code} disabled={s.allowed === false}>{s.code}, {s.name}{s.allowed === false ? ' (not allowed)' : ''}</option>)}
            </select>
          )}
        </Field>
        {options.length === 0 ? <Notice tone="warn">No site is set up for this partner. Add a site to the partner first.</Notice> : null}
        {options.some((o) => o.allowed === false) ? <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{options.filter((o) => o.allowed === false).map((o) => <li key={o.code}>{o.code}: {o.reason ?? 'not allowed'}</li>)}</ul> : null}
      </div>
    </Dialog>
  );
}

export function HoldDialog({ c, open, onClose, onDone }: { c: CaseItem; open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setError(null); } }, [open]);
  const len = reason.trim().length;
  const m = useMutation({
    mutationFn: () => api(`/api/cases/${c.id}/hold`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => onDone(`${c.ref} is on hold. The partner has been told.`),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog
      open={open}
      title={`Put ${c.ref} on hold`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={len < HOLD_MIN || len > HOLD_MAX} onClick={() => { setError(null); m.mutate(); }}>Put on hold</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p>The partner sees this reason and can fix the files and submit again. Do not write patient names here.</p>
        <Field label="Reason" hint={`${len} of ${HOLD_MAX} characters. At least ${HOLD_MIN}.`}>
          {(p) => <textarea {...p} rows={4} value={reason} maxLength={HOLD_MAX} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function ReleaseDialog({ c, open, onClose, onDone }: { c: CaseItem; open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  const m = useMutation({
    mutationFn: () => api(`/api/cases/${c.id}/release`, { method: 'POST', body: {} }),
    onSuccess: () => onDone(`${c.ref} was released and is waiting for intake again.`),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog
      open={open}
      title={`Release ${c.ref}?`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => { setError(null); m.mutate(); }}>Release</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p>The case goes back to the intake queue as submitted. Use this when you have finished checking it without the partner. Otherwise the partner submits it again after fixing the files.</p>
        {c.holdReason ? <p className="muted small">Hold reason: {c.holdReason}</p> : null}
      </div>
    </Dialog>
  );
}

export function StageDialog({ c, open, onClose, onDone }: { c: CaseItem; open: boolean; onClose: () => void; onDone: (text: string, tone: 'good') => void }) {
  const totalAligners = c.counts.upper + c.counts.lower;
  const [stage, setStage] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [shipped, setShipped] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setStage(''); setCarrier(c.carrier ?? ''); setTracking(c.trackingNumber ?? ''); setShipped(totalAligners ? String(totalAligners) : ''); setNote(''); setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const shipping = stage === 'shipped';
  const shippedNum = Number(shipped);
  const ready = !!stage && (!shipping || (carrier.trim().length > 0 && tracking.trim().length > 0 && Number.isInteger(shippedNum) && shippedNum > 0));
  const m = useMutation({
    mutationFn: () => api(`/api/cases/${c.id}/stage`, {
      method: 'POST',
      body: {
        stage,
        ...(shipping ? { carrier: carrier.trim(), trackingNumber: tracking.trim(), alignersShipped: shippedNum } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    }),
    onSuccess: () => onDone(`${c.ref} is now at ${stageLabel(stage).toLowerCase()}.`, 'good'),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog
      open={open}
      wide
      title={`Update the stage of ${c.ref}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!ready} onClick={() => { setError(null); m.mutate(); }}>Update stage</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p className="muted small">Stages only move forward. The partner is notified. This is recorded as a K Line update.</p>
        <Field label="New stage" hint={c.stageLabel ? `Now: ${c.stageLabel}` : undefined}>
          {(p) => (
            <select {...p} value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Choose a stage</option>
              {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
        </Field>
        {shipping ? (
          <div className="form-grid">
            <Field label="Carrier">{(p) => <input {...p} value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={80} required />}</Field>
            <Field label="Tracking number">{(p) => <input {...p} value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={120} required autoComplete="off" />}</Field>
            <Field label="Aligners shipped">{(p) => <input {...p} type="number" min={1} max={9999} value={shipped} onChange={(e) => setShipped(e.target.value)} required />}</Field>
          </div>
        ) : null}
        <Field label="Note (optional)" hint="Kept in the case history. No patient names.">
          {(p) => <input {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

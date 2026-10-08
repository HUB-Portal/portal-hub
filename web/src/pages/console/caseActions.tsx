import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
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
export function RouteDialog(props: { c: CaseItem; routing?: Routing | null; open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [site, setSite] = createSignal('');
  const [error, setError] = createSignal<{ title: string; text: string } | null>(null);

  const options = () => props.c.sites ?? props.routing?.sites ?? [];
  const defaultSite = () => props.c.defaultSiteCode ?? props.routing?.defaultSiteCode ?? '';
  const changing = () => props.c.status === 'ready';

  createEffect(on(() => props.open, (open) => { if (open) { setError(null); setSite(''); } }));
  createEffect(() => {
    if (props.open && !site() && defaultSite() && options().some((o) => o.code === defaultSite() && o.allowed !== false)) setSite(defaultSite());
  });

  const m = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${props.c.id}/route`, { method: 'POST', body: { siteCode: site() } }),
    onSuccess: () => props.onDone(changing() ? `${props.c.ref} now goes to ${site()}.` : `${props.c.ref} was sent to ${site()} and is ready for the factory.`),
    onError: (e: unknown) => setError(routeErrorText(e)),
  }));

  return (
    <Dialog
      open={props.open}
      title={changing() ? `Change the site of ${props.c.ref}` : `Send ${props.c.ref} to a site`}
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!site()} onClick={() => { setError(null); m.mutate(); }}>{changing() ? 'Change site' : 'Send to site'}</Button></>}
    >
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad" title={e().title}>{e().text}</Notice>}</Show>
        <p>{props.c.orgName ? `${props.c.orgName}, ` : ''}case {props.c.caseId ?? props.c.ref}. {changing() ? `It is at ${props.c.siteCode ?? 'a site'} now. The due date stays the same.` : 'The due date is counted from today in business days.'}</p>
        <Field label="Site" hint="The factory that will make this case. Only active sites the partner may use can be chosen.">
          {(p) => (
            <select {...p} value={site()} onChange={(e) => setSite(e.currentTarget.value)}>
              <option value="" selected={site() === ''}>Choose a site</option>
              <For each={options()}>{(s) => <option value={s.code} disabled={s.allowed === false} selected={s.code === site()}>{s.code}, {s.name}{s.allowed === false ? ' (not allowed)' : ''}</option>}</For>
            </select>
          )}
        </Field>
        <Show when={options().length === 0}><Notice tone="warn">No site is set up for this partner. Add a site to the partner first.</Notice></Show>
        <Show when={options().some((o) => o.allowed === false)}>
          <ul class="small muted" style={{ margin: '0', 'padding-left': '18px' }}><For each={options().filter((o) => o.allowed === false)}>{(o) => <li>{o.code}: {o.reason ?? 'not allowed'}</li>}</For></ul>
        </Show>
      </div>
    </Dialog>
  );
}

export function HoldDialog(props: { c: CaseItem; open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setReason(''); setError(null); } }));
  const len = () => reason().trim().length;
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${props.c.id}/hold`, { method: 'POST', body: { reason: reason().trim() } }),
    onSuccess: () => props.onDone(`${props.c.ref} is on hold. The partner has been told.`),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog
      open={props.open}
      title={`Put ${props.c.ref} on hold`}
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={len() < HOLD_MIN || len() > HOLD_MAX} onClick={() => { setError(null); m.mutate(); }}>Put on hold</Button></>}
    >
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <p>The partner sees this reason and can fix the files and submit again. Do not write patient names here.</p>
        <Field label="Reason" hint={`${len()} of ${HOLD_MAX} characters. At least ${HOLD_MIN}.`}>
          {(p) => <textarea {...p} rows={4} value={reason()} maxLength={HOLD_MAX} onInput={(e) => setReason(e.currentTarget.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function ReleaseDialog(props: { c: CaseItem; open: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) setError(null); }));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${props.c.id}/release`, { method: 'POST', body: {} }),
    onSuccess: () => props.onDone(`${props.c.ref} was released and is waiting for intake again.`),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog
      open={props.open}
      title={`Release ${props.c.ref}?`}
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => { setError(null); m.mutate(); }}>Release</Button></>}
    >
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <p>The case goes back to the intake queue as submitted. Use this when you have finished checking it without the partner. Otherwise the partner submits it again after fixing the files.</p>
        <Show when={props.c.holdReason}><p class="muted small">Hold reason: {props.c.holdReason}</p></Show>
      </div>
    </Dialog>
  );
}

export function StageDialog(props: { c: CaseItem; open: boolean; onClose: () => void; onDone: (text: string, tone: 'good') => void }) {
  const totalAligners = () => props.c.counts.upper + props.c.counts.lower;
  const [stage, setStage] = createSignal('');
  const [carrier, setCarrier] = createSignal('');
  const [tracking, setTracking] = createSignal('');
  const [shipped, setShipped] = createSignal('');
  const [note, setNote] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => {
    if (!open) return;
    setStage(''); setCarrier(props.c.carrier ?? ''); setTracking(props.c.trackingNumber ?? ''); setShipped(totalAligners() ? String(totalAligners()) : ''); setNote(''); setError(null);
  }));
  const shipping = () => stage() === 'shipped';
  const shippedNum = () => Number(shipped());
  const ready = () => !!stage() && (!shipping() || (carrier().trim().length > 0 && tracking().trim().length > 0 && Number.isInteger(shippedNum()) && shippedNum() > 0));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${props.c.id}/stage`, {
      method: 'POST',
      body: {
        stage: stage(),
        ...(shipping() ? { carrier: carrier().trim(), trackingNumber: tracking().trim(), alignersShipped: shippedNum() } : {}),
        ...(note().trim() ? { note: note().trim() } : {}),
      },
    }),
    onSuccess: () => props.onDone(`${props.c.ref} is now at ${stageLabel(stage()).toLowerCase()}.`, 'good'),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog
      open={props.open}
      wide
      title={`Update the stage of ${props.c.ref}`}
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!ready()} onClick={() => { setError(null); m.mutate(); }}>Update stage</Button></>}
    >
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <p class="muted small">Stages only move forward. The partner is notified. This is recorded as a K Line update.</p>
        <Field label="New stage" hint={props.c.stageLabel ? `Now: ${props.c.stageLabel}` : undefined}>
          {(p) => (
            <select {...p} value={stage()} onChange={(e) => setStage(e.currentTarget.value)}>
              <option value="" selected={stage() === ''}>Choose a stage</option>
              <For each={STAGES}>{(s) => <option value={s.id} selected={s.id === stage()}>{s.label}</option>}</For>
            </select>
          )}
        </Field>
        <Show when={shipping()}>
          <div class="form-grid">
            <Field label="Carrier">{(p) => <input {...p} value={carrier()} onInput={(e) => setCarrier(e.currentTarget.value)} maxLength={80} required />}</Field>
            <Field label="Tracking number">{(p) => <input {...p} value={tracking()} onInput={(e) => setTracking(e.currentTarget.value)} maxLength={120} required autocomplete="off" />}</Field>
            <Field label="Aligners shipped">{(p) => <input {...p} type="number" min={1} max={9999} value={shipped()} onInput={(e) => setShipped(e.currentTarget.value)} required />}</Field>
          </div>
        </Show>
        <Field label="Note (optional)" hint="Kept in the case history. No patient names.">
          {(p) => <input {...p} value={note()} maxLength={300} onInput={(e) => setNote(e.currentTarget.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

import { createEffect, createMemo, createSignal, createUniqueId, For, Index, type JSX, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { Plus, Trash2 } from 'lucide-solid';
import { BAG_LIMITS, BAG_TOKENS, DEFAULT_BAG_LAYOUT, layoutProblems, printsPersonalData, renderBags, type BagLayout as Layout } from '@shared/bag';
import { api, ApiError, errorText } from '../../lib/api';
import { Button, Card, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { IfMfa } from '../../ui/IfMfa';

const TOKEN_HELP: Record<string, string> = {
  brand: 'Brand name',
  case_id: 'Your case ID',
  ref: 'K Line reference',
  aligner: 'Aligner code, like U03',
  arch: 'Upper or Lower',
  arch_short: 'U or L',
  step: 'Step number',
  step_padded: 'Step with a leading zero',
  total_steps: 'Steps in this arch',
  wear_days: 'Days to wear',
  patient_initials: 'Patient initials (personal data)',
  patient_name: 'Patient name (personal data)',
};

// Fictional sample data for the preview only.
const SAMPLE = {
  ref: 'ACME-000123',
  caseId: '55813',
  brand: 'Acme Aligners',
  patientName: 'Mara Sample',
  aligners: [
    ...Array.from({ length: 14 }, (_v, i) => ({ arch: 'upper' as const, step: i + 1 })),
    ...Array.from({ length: 12 }, (_v, i) => ({ arch: 'lower' as const, step: i + 1 })),
  ],
};

type Focus = { kind: 'line'; i: number } | { kind: 'barcode' };

/** Pseudo bars from a string. Only shows where the barcode sits and how wide it is, it is not a real Code 128. */
function sampleBars(text: string): number[] {
  const out: number[] = [2, 1, 2];
  let h = 2166136261;
  for (let i = 0; i < Math.max(text.length, 1) * 4; i++) {
    h = Math.imul(h ^ (text.charCodeAt(i % Math.max(text.length, 1)) + i), 16777619) >>> 0;
    out.push(1 + (h % 3));
  }
  return [...out, 2, 1, 2];
}

/** Layout form with a live preview. Used by the bag labels page and inside the production specification editor. */
export function BagEditor(props: { layout: Layout; onChange?: (l: Layout) => void; readOnly?: boolean; footer?: JSX.Element }) {
  const [focus, setFocus] = createSignal<Focus>({ kind: 'line', i: 0 });
  const [pick, setPick] = createSignal('upper|1');
  const idBase = createUniqueId();

  function change(patch: Partial<Layout>) { props.onChange?.({ ...props.layout, ...patch }); }
  function setLine(i: number, v: string) { change({ lines: props.layout.lines.map((l, n) => (n === i ? v : l)) }); }
  function addToken(t: string) {
    const tok = `{${t}}`;
    const f = focus();
    const layout = props.layout;
    if (f.kind === 'barcode') change({ barcode: `${layout.barcode}${layout.barcode && !layout.barcode.endsWith(' ') ? ' ' : ''}${tok}` });
    else if (layout.lines[f.i] !== undefined) setLine(f.i, `${layout.lines[f.i]}${layout.lines[f.i] && !layout.lines[f.i]!.endsWith(' ') ? ' ' : ''}${tok}`);
  }

  const problems = createMemo(() => layoutProblems(props.layout));
  const personal = () => printsPersonalData(props.layout);
  const arch = () => pick().split('|')[0] as 'upper' | 'lower';
  const step = () => pick().split('|')[1] as string;
  const bag = createMemo(() => {
    if (problems().length) return null;
    return renderBags(props.layout, SAMPLE).find((b) => b.arch === arch() && b.step === Number(step())) ?? null;
  });

  const num = (v: string) => (v === '' ? NaN : Number(v));

  return (
    <div class="stack">
      <Show when={personal()}>
        <Notice tone="warn" title="This layout prints patient data on the bag">
          Bags travel with the aligners and can be seen by people outside the clinic. Only keep patient names or initials here if you have a good reason and your patients know.<IfMfa> Saving asks for your authenticator code.</IfMfa>
        </Notice>
      </Show>
      <div class="grid-2">
        <Card title="Layout">
          <fieldset disabled={props.readOnly} class="plain-fieldset stack">
            <div class="form-grid">
              <Field label="Width (mm)">{(p) => <input {...p} type="number" min={BAG_LIMITS.widthMm.min} max={BAG_LIMITS.widthMm.max} value={Number.isNaN(props.layout.widthMm) ? '' : props.layout.widthMm} onInput={(e) => change({ widthMm: num(e.currentTarget.value) })} />}</Field>
              <Field label="Height (mm)">{(p) => <input {...p} type="number" min={BAG_LIMITS.heightMm.min} max={BAG_LIMITS.heightMm.max} value={Number.isNaN(props.layout.heightMm) ? '' : props.layout.heightMm} onInput={(e) => change({ heightMm: num(e.currentTarget.value) })} />}</Field>
              <Field label="Margin (mm)">{(p) => <input {...p} type="number" min={BAG_LIMITS.marginMm.min} max={BAG_LIMITS.marginMm.max} step="0.5" value={Number.isNaN(props.layout.marginMm) ? '' : props.layout.marginMm} onInput={(e) => change({ marginMm: num(e.currentTarget.value) })} />}</Field>
              <Field label="Wear days" hint="Used by the {wear_days} placeholder.">{(p) => <input {...p} type="number" min={BAG_LIMITS.wearDays.min} max={BAG_LIMITS.wearDays.max} value={Number.isNaN(props.layout.wearDays) ? '' : props.layout.wearDays} onInput={(e) => change({ wearDays: num(e.currentTarget.value) })} />}</Field>
            </div>

            <fieldset class="check-group">
              <legend>Text lines (up to {BAG_LIMITS.maxLines})</legend>
              <Index each={props.layout.lines}>
                {(line, i) => (
                  <div class="inline-form">
                    <div class="field grow">
                      <label for={`${idBase}-line-${i}`} class="sr-only">Line {i + 1}</label>
                      <input id={`${idBase}-line-${i}`} value={line()} maxLength={BAG_LIMITS.maxLineLength} onFocus={() => setFocus({ kind: 'line', i })} onInput={(e) => setLine(i, e.currentTarget.value)} placeholder={`Line ${i + 1}`} />
                    </div>
                    <Show when={!props.readOnly}><Button size="sm" onClick={() => { change({ lines: props.layout.lines.filter((_l, n) => n !== i) }); setFocus({ kind: 'line', i: 0 }); }} aria-label={`Remove line ${i + 1}`}><Trash2 size={14} aria-hidden="true" /></Button></Show>
                  </div>
                )}
              </Index>
              <Show when={!props.readOnly}><div><Button size="sm" disabled={props.layout.lines.length >= BAG_LIMITS.maxLines} onClick={() => { change({ lines: [...props.layout.lines, ''] }); setFocus({ kind: 'line', i: props.layout.lines.length }); }}><Plus size={14} aria-hidden="true" /> Add a line</Button></div></Show>
            </fieldset>

            <Field label="Barcode text" hint="Printed as a Code 128 barcode by the printer system.">
              {(p) => <input {...p} value={props.layout.barcode} maxLength={BAG_LIMITS.maxBarcodeLength} onFocus={() => setFocus({ kind: 'barcode' })} onInput={(e) => change({ barcode: e.currentTarget.value })} />}
            </Field>

            <Show when={!props.readOnly}>
              <div class="stack-sm">
                <span class="label" id={`${idBase}-tokens`}>Placeholders</span>
                <p class="hint">Choose a line or the barcode text, then click a placeholder to add it.</p>
                <div class="row" role="group" aria-labelledby={`${idBase}-tokens`} style={{ gap: '6px' }}>
                  <For each={BAG_TOKENS}>{(t) => <Button size="sm" title={TOKEN_HELP[t]} onClick={() => addToken(t)}><span class="mono">{`{${t}}`}</span></Button>}</For>
                </div>
              </div>
            </Show>

            <div class="stack-sm">
              <Toggle checked={props.layout.showPatientName} onChange={(v) => change({ showPatientName: v })} label="Allow the patient name on bags" hint="Off by default. The {patient_name} placeholder stays empty unless this is on." />
              <Toggle checked={props.layout.showPatientInitials} onChange={(v) => change({ showPatientInitials: v })} label="Allow patient initials on bags" hint="Off by default. The {patient_initials} placeholder stays empty unless this is on." />
            </div>
          </fieldset>

          <Show when={problems().length && !props.readOnly}>
            <Notice tone="bad" title="Fix this before saving"><ul style={{ margin: '0', 'padding-left': '18px' }}><For each={problems()}>{(p) => <li>{p}</li>}</For></ul></Notice>
          </Show>
          <Show when={!props.readOnly}>
            <div class="row">
              {props.footer}
              <Button onClick={() => props.onChange?.(DEFAULT_BAG_LAYOUT)}>Use the standard layout</Button>
            </div>
          </Show>
        </Card>

        <Card title="Preview" class="sticky-card">
          <p class="muted small">One bag with made up sample data, drawn to scale. Bags are printed one per aligner.</p>
          <Field label="Sample aligner">
            {(p) => (
              <select {...p} value={pick()} onChange={(e) => setPick(e.currentTarget.value)}>
                <For each={SAMPLE.aligners}>{(a) => <option value={`${a.arch}|${a.step}`} selected={pick() === `${a.arch}|${a.step}`}>{a.arch === 'upper' ? 'Upper' : 'Lower'} step {a.step}</option>}</For>
              </select>
            )}
          </Field>
          <Show when={bag()} fallback={<Notice tone="warn">Fix the problems on the left to see the preview.</Notice>}>
            {(b) => <BagPreview layout={props.layout} lines={b().lines} barcode={b().barcode} />}
          </Show>
        </Card>
      </div>
    </div>
  );
}

export default function BagLayoutPage() {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['bag-layout'], queryFn: () => api<{ layout: Layout }>('/api/org/bag-layout') }));
  const [layout, setLayout] = createSignal<Layout>(DEFAULT_BAG_LAYOUT);
  const [dirty, setDirty] = createSignal(false);
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [inSpec, setInSpec] = createSignal(false);

  createEffect(() => { const d = q.data; if (d) { setLayout(d.layout); setDirty(false); } });

  const save = createMutation(() => ({
    mutationFn: () => api<{ layout: Layout }>('/api/org/bag-layout', { method: 'PUT', body: layout() }),
    onSuccess: (r: { layout: Layout } | undefined) => { setMsg({ tone: 'good', text: 'Bag layout saved. It is used for new bag print files.' }); setInSpec(false); setDirty(false); if (r?.layout) setLayout(r.layout); qc.invalidateQueries({ queryKey: ['bag-layout'] }); },
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.code === 'bag_in_spec') { setInSpec(true); setMsg(null); } else setMsg({ tone: 'bad', text: errorText(e) });
    },
  }));

  const problems = createMemo(() => layoutProblems(layout()));

  return (
    <Show when={!q.isLoading} fallback={<div class="page"><Spinner /></div>}>
      <div class="page">
        <PageHeader title="Bag labels" subtitle="How each aligner bag is printed. K Line prints one bag per aligner." />
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
        <Show when={inSpec()}>
          <Notice tone="warn" title="The bag layout is part of your production specification">
            While a specification is active, its bag layout is the one K Line uses. To change it, draft a new version of the specification. <A href="/portal/spec">Open the production specification</A>.
          </Notice>
        </Show>
        <BagEditor
          layout={layout()}
          onChange={(l) => { setLayout(l); setDirty(true); setMsg(null); }}
          footer={<Button variant="primary" loading={save.isPending} disabled={!dirty() || problems().length > 0} onClick={() => save.mutate()}>Save layout</Button>}
        />
      </div>
    </Show>
  );
}

function BagPreview(props: { layout: Layout; lines: string[]; barcode: string }) {
  const maxPx = 300;
  const scale = () => Math.min(maxPx / props.layout.widthMm, 420 / props.layout.heightMm);
  const w = () => props.layout.widthMm * scale();
  const h = () => props.layout.heightMm * scale();
  const m = () => props.layout.marginMm * scale();
  const font = () => Math.max(9, Math.min(16, 3.6 * scale()));
  const bars = () => sampleBars(props.barcode);
  return (
    <div style={{ display: 'grid', 'justify-items': 'center', gap: '8px' }}>
      <div class="bag-preview" style={{ width: `${w()}px`, height: `${h()}px` }} role="img" aria-label={`Bag preview, ${props.lines.filter(Boolean).join(', ')}`}>
        <div class="bag-margin" style={{ left: `${m()}px`, top: `${m()}px`, right: `${m()}px`, bottom: `${m()}px` }} />
        <div class="bag-lines" style={{ left: `${m() + 4}px`, top: `${m() + 4}px`, right: `${m() + 4}px`, 'font-size': `${font()}px`, 'line-height': 1.25 }}>
          <Index each={props.lines}>
            {(l, i) => <div style={{ 'font-weight': i === 0 ? 700 : 400, 'min-height': `${font() * 1.25}px`, overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{l()}</div>}
          </Index>
        </div>
        <div style={{ position: 'absolute', left: `${m() + 4}px`, right: `${m() + 4}px`, bottom: `${m() + 4}px`, display: 'grid', gap: '2px', 'justify-items': 'center' }}>
          <div class="bag-barcode" aria-hidden="true">
            <Index each={bars()}>{(b, i) => <i style={{ width: `${b()}px`, background: i % 2 === 0 ? '#000' : 'transparent' }} />}</Index>
          </div>
          <span class="mono" style={{ 'font-size': `${Math.max(8, font() - 2)}px` }}>{props.barcode}</span>
        </div>
      </div>
      <p class="small muted">{props.layout.widthMm} by {props.layout.heightMm} mm, margin {props.layout.marginMm} mm. The bars only show the position. The printer system draws the real Code 128.</p>
    </div>
  );
}

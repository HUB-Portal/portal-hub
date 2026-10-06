import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { BAG_LIMITS, BAG_TOKENS, DEFAULT_BAG_LAYOUT, layoutProblems, printsPersonalData, renderBags, type BagLayout as Layout } from '@shared/bag';
import { api, ApiError, errorText } from '../../lib/api';
import { Button, Card, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';

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
export function BagEditor({ layout, onChange, readOnly, footer }: { layout: Layout; onChange?: (l: Layout) => void; readOnly?: boolean; footer?: ReactNode }) {
  const [focus, setFocus] = useState<Focus>({ kind: 'line', i: 0 });
  const [pick, setPick] = useState('upper|1');
  const idBase = useId();

  function change(patch: Partial<Layout>) { onChange?.({ ...layout, ...patch }); }
  function setLine(i: number, v: string) { change({ lines: layout.lines.map((l, n) => (n === i ? v : l)) }); }
  function addToken(t: string) {
    const tok = `{${t}}`;
    if (focus.kind === 'barcode') change({ barcode: `${layout.barcode}${layout.barcode && !layout.barcode.endsWith(' ') ? ' ' : ''}${tok}` });
    else if (layout.lines[focus.i] !== undefined) setLine(focus.i, `${layout.lines[focus.i]}${layout.lines[focus.i] && !layout.lines[focus.i]!.endsWith(' ') ? ' ' : ''}${tok}`);
  }

  const problems = useMemo(() => layoutProblems(layout), [layout]);
  const personal = printsPersonalData(layout);
  const [arch, step] = pick.split('|') as ['upper' | 'lower', string];
  const bag = useMemo(() => {
    if (problems.length) return null;
    return renderBags(layout, SAMPLE).find((b) => b.arch === arch && b.step === Number(step)) ?? null;
  }, [layout, problems, arch, step]);

  const num = (v: string) => (v === '' ? NaN : Number(v));

  return (
    <div className="stack">
      {personal ? (
        <Notice tone="warn" title="This layout prints patient data on the bag">
          Bags travel with the aligners and can be seen by people outside the clinic. Only keep patient names or initials here if you have a good reason and your patients know. Saving asks for your authenticator code.
        </Notice>
      ) : null}
      <div className="grid-2">
        <Card title="Layout">
          <fieldset disabled={readOnly} className="plain-fieldset stack">
            <div className="form-grid">
              <Field label="Width (mm)">{(p) => <input {...p} type="number" min={BAG_LIMITS.widthMm.min} max={BAG_LIMITS.widthMm.max} value={Number.isNaN(layout.widthMm) ? '' : layout.widthMm} onChange={(e) => change({ widthMm: num(e.target.value) })} />}</Field>
              <Field label="Height (mm)">{(p) => <input {...p} type="number" min={BAG_LIMITS.heightMm.min} max={BAG_LIMITS.heightMm.max} value={Number.isNaN(layout.heightMm) ? '' : layout.heightMm} onChange={(e) => change({ heightMm: num(e.target.value) })} />}</Field>
              <Field label="Margin (mm)">{(p) => <input {...p} type="number" min={BAG_LIMITS.marginMm.min} max={BAG_LIMITS.marginMm.max} step="0.5" value={Number.isNaN(layout.marginMm) ? '' : layout.marginMm} onChange={(e) => change({ marginMm: num(e.target.value) })} />}</Field>
              <Field label="Wear days" hint="Used by the {wear_days} placeholder.">{(p) => <input {...p} type="number" min={BAG_LIMITS.wearDays.min} max={BAG_LIMITS.wearDays.max} value={Number.isNaN(layout.wearDays) ? '' : layout.wearDays} onChange={(e) => change({ wearDays: num(e.target.value) })} />}</Field>
            </div>

            <fieldset className="check-group">
              <legend>Text lines (up to {BAG_LIMITS.maxLines})</legend>
              {layout.lines.map((line, i) => (
                <div className="inline-form" key={i}>
                  <div className="field grow">
                    <label htmlFor={`${idBase}-line-${i}`} className="sr-only">Line {i + 1}</label>
                    <input id={`${idBase}-line-${i}`} value={line} maxLength={BAG_LIMITS.maxLineLength} onFocus={() => setFocus({ kind: 'line', i })} onChange={(e) => setLine(i, e.target.value)} placeholder={`Line ${i + 1}`} />
                  </div>
                  {readOnly ? null : <Button size="sm" onClick={() => { change({ lines: layout.lines.filter((_l, n) => n !== i) }); setFocus({ kind: 'line', i: 0 }); }} aria-label={`Remove line ${i + 1}`}><Trash2 size={14} aria-hidden="true" /></Button>}
                </div>
              ))}
              {readOnly ? null : <div><Button size="sm" disabled={layout.lines.length >= BAG_LIMITS.maxLines} onClick={() => { change({ lines: [...layout.lines, ''] }); setFocus({ kind: 'line', i: layout.lines.length }); }}><Plus size={14} aria-hidden="true" /> Add a line</Button></div>}
            </fieldset>

            <Field label="Barcode text" hint="Printed as a Code 128 barcode by the printer system.">
              {(p) => <input {...p} value={layout.barcode} maxLength={BAG_LIMITS.maxBarcodeLength} onFocus={() => setFocus({ kind: 'barcode' })} onChange={(e) => change({ barcode: e.target.value })} />}
            </Field>

            {readOnly ? null : <div className="stack-sm">
              <span className="label" id={`${idBase}-tokens`}>Placeholders</span>
              <p className="hint">Choose a line or the barcode text, then click a placeholder to add it.</p>
              <div className="row" role="group" aria-labelledby={`${idBase}-tokens`} style={{ gap: 6 }}>
                {BAG_TOKENS.map((t) => <Button key={t} size="sm" title={TOKEN_HELP[t]} onClick={() => addToken(t)}><span className="mono">{`{${t}}`}</span></Button>)}
              </div>
            </div>}

            <div className="stack-sm">
              <Toggle checked={layout.showPatientName} onChange={(v) => change({ showPatientName: v })} label="Allow the patient name on bags" hint="Off by default. The {patient_name} placeholder stays empty unless this is on." />
              <Toggle checked={layout.showPatientInitials} onChange={(v) => change({ showPatientInitials: v })} label="Allow patient initials on bags" hint="Off by default. The {patient_initials} placeholder stays empty unless this is on." />
            </div>
          </fieldset>

          {problems.length && !readOnly ? <Notice tone="bad" title="Fix this before saving"><ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></Notice> : null}
          {!readOnly ? (
            <div className="row">
              {footer}
              <Button onClick={() => onChange?.(DEFAULT_BAG_LAYOUT)}>Use the standard layout</Button>
            </div>
          ) : null}
        </Card>

        <Card title="Preview" className="sticky-card">
          <p className="muted small">One bag with made up sample data, drawn to scale. Bags are printed one per aligner.</p>
          <Field label="Sample aligner">
            {(p) => (
              <select {...p} value={pick} onChange={(e) => setPick(e.target.value)}>
                {SAMPLE.aligners.map((a) => <option key={`${a.arch}|${a.step}`} value={`${a.arch}|${a.step}`}>{a.arch === 'upper' ? 'Upper' : 'Lower'} step {a.step}</option>)}
              </select>
            )}
          </Field>
          {bag ? <BagPreview layout={layout} lines={bag.lines} barcode={bag.barcode} /> : <Notice tone="warn">Fix the problems on the left to see the preview.</Notice>}
        </Card>
      </div>
    </div>
  );
}

export default function BagLayoutPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['bag-layout'], queryFn: () => api<{ layout: Layout }>('/api/org/bag-layout') });
  const [layout, setLayout] = useState<Layout>(DEFAULT_BAG_LAYOUT);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [inSpec, setInSpec] = useState(false);

  useEffect(() => { if (q.data) { setLayout(q.data.layout); setDirty(false); } }, [q.data]);

  const save = useMutation({
    mutationFn: () => api<{ layout: Layout }>('/api/org/bag-layout', { method: 'PUT', body: layout }),
    onSuccess: (r) => { setMsg({ tone: 'good', text: 'Bag layout saved. It is used for new bag print files.' }); setInSpec(false); setDirty(false); if (r?.layout) setLayout(r.layout); qc.invalidateQueries({ queryKey: ['bag-layout'] }); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'bag_in_spec') { setInSpec(true); setMsg(null); } else setMsg({ tone: 'bad', text: errorText(e) });
    },
  });

  const problems = useMemo(() => layoutProblems(layout), [layout]);

  if (q.isLoading) return <div className="page"><Spinner /></div>;

  return (
    <div className="page">
      <PageHeader title="Bag labels" subtitle="How each aligner bag is printed. K Line prints one bag per aligner." />
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {inSpec ? (
        <Notice tone="warn" title="The bag layout is part of your production specification">
          While a specification is active, its bag layout is the one K Line uses. To change it, draft a new version of the specification. <Link to="/portal/spec">Open the production specification</Link>.
        </Notice>
      ) : null}
      <BagEditor
        layout={layout}
        onChange={(l) => { setLayout(l); setDirty(true); setMsg(null); }}
        footer={<Button variant="primary" loading={save.isPending} disabled={!dirty || problems.length > 0} onClick={() => save.mutate()}>Save layout</Button>}
      />
    </div>
  );
}

function BagPreview({ layout, lines, barcode }: { layout: Layout; lines: string[]; barcode: string }) {
  const maxPx = 300;
  const scale = Math.min(maxPx / layout.widthMm, 420 / layout.heightMm);
  const w = layout.widthMm * scale;
  const h = layout.heightMm * scale;
  const m = layout.marginMm * scale;
  const font = Math.max(9, Math.min(16, 3.6 * scale));
  const bars = sampleBars(barcode);
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
      <div className="bag-preview" style={{ width: w, height: h }} role="img" aria-label={`Bag preview, ${lines.filter(Boolean).join(', ')}`}>
        <div className="bag-margin" style={{ left: m, top: m, right: m, bottom: m }} />
        <div className="bag-lines" style={{ left: m + 4, top: m + 4, right: m + 4, fontSize: font, lineHeight: 1.25 }}>
          {lines.map((l, i) => <div key={i} style={{ fontWeight: i === 0 ? 700 : 400, minHeight: font * 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</div>)}
        </div>
        <div style={{ position: 'absolute', left: m + 4, right: m + 4, bottom: m + 4, display: 'grid', gap: 2, justifyItems: 'center' }}>
          <div className="bag-barcode" aria-hidden="true">
            {bars.map((b, i) => <i key={i} style={{ width: b, background: i % 2 === 0 ? '#000' : 'transparent' }} />)}
          </div>
          <span className="mono" style={{ fontSize: Math.max(8, font - 2) }}>{barcode}</span>
        </div>
      </div>
      <p className="small muted">{layout.widthMm} by {layout.heightMm} mm, margin {layout.marginMm} mm. The bars only show the position. The printer system draws the real Code 128.</p>
    </div>
  );
}

import { createHash, randomUUID } from 'node:crypto';
import { audit } from '../audit';
import type { PoolClient } from '../db';
import { newFileKey, sealBuffer, chunkCountFor, CHUNK_SIZE } from '../crypto/envelope';
import { blindIndex, encryptField, fieldAad } from '../crypto/keys';
import { STAGE_IDS, stageLabel, statusForStage, type StageId } from '../../../shared/stages';
import { chunkKey, newStoragePrefix, storage } from '../storage';
import { computeChecks, type CheckFile } from '../services/checks';
import { createChildCase } from '../services/childCases';
import { TYPE_BY_EXT } from '../services/files';
import { bufferSource, validateContent } from '../services/validate';
import { archStl, trimLinePts, laserCsv, planPdf } from './assets';

/**
 * The Acme Aligners demo data set: up to 18 cases that cover every status, two claims, a replacement, a factory event log with an
 * unmapped code, and K Line access entries in the audit log. Everything here is synthetic. Shipped and received cases hold small
 * real (encrypted) files so the viewer, downloads and packages work.
 */

const DAY = 86_400_000;

interface SeedCtx {
  acmeId: string;
  klineId: string;
  siteIds: Record<string, string>;
  users: Record<string, { id: string; name: string }>;
}

interface StepSpec {
  upper?: number[];
  lower?: number[];
  /** Trim lines left out, as `upper1`, `lower2`. */
  noPts?: string[];
  /** Trim lines with a gap, as `upper7`. */
  openPts?: string[];
  /** Template models (step 0 style `_T` files) for these keys. */
  templates?: string[];
  /** Also add laser marking CSV files for every aligner. */
  csv?: boolean;
  plan?: boolean;
}

interface CaseDef {
  caseId: string;
  name: string;
  status: 'draft' | 'submitted' | 'on_hold' | 'ready' | 'received' | 'in_production' | 'shipped' | 'delivered' | 'cancelled';
  stage?: StageId;
  site?: 'PT-CHV' | 'EG-CFZ';
  priority?: 'normal' | 'rush';
  /** Days since the case was created. */
  age: number;
  hold?: string;
  notes?: string;
  /** Instructions were changed after the case was submitted (an `instructions_updated` event). */
  notesChanged?: string;
  files?: StepSpec;
  /** When the checks should be evaluated as if trim lines were required (the demo organisation does not require them). */
  requirePtsWarning?: boolean;
  carrier?: string;
  tracking?: string;
}

const PRESCRIPTION = [
  'Prescription for clear aligner treatment. Fictional patient, demo data.',
  '',
  'Treatment: upper and lower arches, 14 steps each, refinement expected.',
  'Diagnosis: Class I malocclusion with mild crowding (upper 2 mm, lower 3 mm) and a 1 mm lower midline shift to the right.',
  'Attachments: rectangular on 13, 23, 33 and 43. Optimised attachments on 14 and 24 from step 3.',
  'Interproximal reduction: 0.2 mm between 33 and 43 at step 4. 0.3 mm between 12 and 13 at step 6.',
  'Elastics: none planned. Buttons on 16 and 46 are not needed.',
  'Trim: straight trim, 0.5 mm above the gum line on the lower incisors. Scalloped trim on the upper arch.',
  'Extraction or no extraction: no extraction.',
  'Special requests: please mark each aligner with the step and the arch. Pack the templates separately.',
  'Shipping: to the practice. Please include the treatment sheet in the box.',
].join('\n');

const CASES: CaseDef[] = [
  { caseId: 'AC-1001', name: 'Marc Alonso', status: 'draft', age: 1, files: { upper: [1, 2], lower: [1, 2], noPts: ['upper2', 'lower2'] }, requirePtsWarning: true, notes: 'Draft. Trim lines for step 2 are still to come.' },
  { caseId: 'AC-1002', name: 'Iris Petrov', status: 'submitted', age: 1, files: { upper: [1, 2, 3], lower: [1, 2, 3], plan: true }, notes: PRESCRIPTION },
  { caseId: 'AC-1003', name: 'Tomas Berg', status: 'on_hold', age: 3, files: { upper: [6, 7], lower: [6], openPts: ['upper7'] }, hold: 'The trim line for U07 looks open. Please check it and send it again.', notes: 'Refinement, steps 6 and 7 only.' },
  { caseId: 'AC-1004', name: 'Lena Fischer', status: 'ready', site: 'PT-CHV', age: 2, notes: 'Please keep the attachments as designed.', notesChanged: 'Please keep the attachments as designed.\n\nUpdated after submission: add a rush marking on the box, the patient travels on 12 October.' },
  { caseId: 'AC-1005', name: 'Noor Haddad', status: 'received', stage: 'received', site: 'PT-CHV', age: 4, files: { upper: [1, 2], lower: [1, 2] } },
  { caseId: 'AC-1006', name: 'Hugo Brandt', status: 'in_production', stage: 'printing', site: 'PT-CHV', age: 5 },
  { caseId: 'AC-1007', name: 'Sana Malik', status: 'in_production', stage: 'thermoforming', site: 'PT-CHV', age: 6 },
  { caseId: 'AC-1008', name: 'Jonas Keller', status: 'in_production', stage: 'trimming', site: 'PT-CHV', priority: 'rush', age: 6, notes: 'Rush: the patient has an appointment next week.' },
  { caseId: 'AC-1009', name: 'Amira Nasser', status: 'in_production', stage: 'finishing', site: 'PT-CHV', age: 7 },
  { caseId: 'AC-1010', name: 'Pedro Silva', status: 'in_production', stage: 'quality_check', site: 'PT-CHV', age: 7 },
  { caseId: 'AC-1011', name: 'Elena Rossi', status: 'in_production', stage: 'packing', site: 'PT-CHV', age: 8 },
  { caseId: 'AC-1012', name: 'Kwame Mensah', status: 'shipped', stage: 'shipped', site: 'EG-CFZ', age: 14, files: { upper: [1, 2], lower: [1, 2], templates: ['upper1', 'lower1'], csv: true }, carrier: 'DHL Express', tracking: 'DEMO0000000012' },
  { caseId: 'AC-1013', name: 'Yuki Tanaka', status: 'shipped', stage: 'shipped', site: 'PT-CHV', age: 15, files: { upper: [1, 2], lower: [1, 2] }, carrier: 'DHL Express', tracking: 'DEMO0000000013' },
  { caseId: 'AC-1014', name: 'Olga Novak', status: 'shipped', stage: 'shipped', site: 'PT-CHV', age: 20, files: { upper: [1, 2], lower: [1, 2] }, carrier: 'UPS', tracking: 'DEMO0000000014' },
  { caseId: 'AC-1015', name: 'Clara Dubois', status: 'delivered', stage: 'delivered', site: 'PT-CHV', age: 30, files: { upper: [1, 2], lower: [1, 2] }, carrier: 'DHL Express', tracking: 'DEMO0000000015' },
  { caseId: 'AC-1016', name: 'Mateo Cruz', status: 'cancelled', age: 9, notes: 'Cancelled by the practice: the patient changed plans.' },
];

const CODE_FOR_STAGE: Record<StageId, string> = {
  received: 'RECEIVED', printing: 'PRINT', thermoforming: 'THERMO', trimming: 'TRIM', finishing: 'POLISH', quality_check: 'QC', packing: 'PACK', shipped: 'SHIP', delivered: 'DELIVERED',
};

// ---------------------------------------------------------------------------
// Real small files
// ---------------------------------------------------------------------------
interface FileSpec {
  name: string;
  data: Buffer;
  kind: 'stl' | 'pts' | 'pdf' | 'csv';
  arch?: 'upper' | 'lower';
  step?: number;
  template?: boolean;
}

function fileSpecsFor(caseId: string, s: StepSpec): FileSpec[] {
  const out: FileSpec[] = [];
  const archs: ['upper' | 'lower', number[] | undefined][] = [['upper', s.upper], ['lower', s.lower]];
  for (const [arch, steps] of archs) {
    const p = arch === 'upper' ? 'U' : 'L';
    for (const step of steps ?? []) {
      const n = `${p}${String(step).padStart(2, '0')}`;
      out.push({ name: `${n}.stl`, data: archStl({ arch, step }), kind: 'stl', arch, step });
      if (!s.noPts?.includes(`${arch}${step}`)) out.push({ name: `${n}.pts`, data: trimLinePts({ arch, step, open: !!s.openPts?.includes(`${arch}${step}`) }), kind: 'pts', arch, step });
      if (s.csv) out.push({ name: `${n}.csv`, data: laserCsv(caseId, arch, step), kind: 'csv', arch, step });
    }
    for (const key of s.templates ?? []) {
      if (!key.startsWith(arch)) continue;
      const step = Number(key.slice(arch.length));
      const n = `${p}${String(step).padStart(2, '0')}_T`;
      out.push({ name: `${n}.stl`, data: archStl({ arch, step, template: true }), kind: 'stl', arch, step, template: true });
    }
  }
  if (s.plan) out.push({ name: `Plan ${caseId}.pdf`, data: planPdf(`Treatment plan ${caseId}`, ['Demo data. Not a real plan.', 'Upper and lower arch, three steps each.']), kind: 'pdf' });
  return out;
}

/** Encrypts, stores and records one file exactly like an upload would, with the real checks run on the content. */
async function insertFile(c: PoolClient, p: { orgId: string; caseId: string; spec: FileSpec; userId: string; at: Date }): Promise<string> {
  const id = randomUUID();
  const key = newFileKey(id);
  const prefix = newStoragePrefix();
  const count = chunkCountFor(p.spec.data.length);
  const sealed = sealBuffer(key.cipher, p.spec.data);
  const st = await storage();
  for (let i = 0; i < sealed.length; i++) await st.put(chunkKey(prefix, i), sealed[i]!);
  const ext = p.spec.name.slice(p.spec.name.lastIndexOf('.') + 1).toLowerCase();
  const result = await validateContent(p.spec.kind, ext, bufferSource(p.spec.data));
  const sha = createHash('sha256').update(p.spec.data).digest('hex');
  await c.query(
    `INSERT INTO files (id, org_id, purpose, case_id, kind, arch, step, is_template, name_enc, ext, content_type, size, chunk_size, chunk_count, wrapped_key, key_id, nonce_prefix,
                        storage_prefix, state, scan_status, validation, meta, uploader_id, created_at, uploaded_at, processed_at)
     VALUES ($1, $2, 'case', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'skipped', $19::jsonb, $20::jsonb, $21, $22, $22, $22)`,
    [
      id, p.orgId, p.caseId, p.spec.kind, p.spec.arch ?? null, p.spec.step ?? null, !!p.spec.template, encryptField(p.spec.name, fieldAad.fileName(id)), ext,
      TYPE_BY_EXT[ext] ?? 'application/octet-stream', p.spec.data.length, CHUNK_SIZE, count, key.wrappedKey, key.keyId, key.noncePrefix, prefix,
      result.errors.length ? 'rejected' : 'ready', JSON.stringify({ errors: result.errors, warnings: result.warnings }), JSON.stringify({ ...result.meta, sha256: sha }), p.userId, p.at,
    ],
  );
  for (let i = 0; i < sealed.length; i++) await c.query(`INSERT INTO file_chunks (file_id, org_id, idx, size) VALUES ($1, $2, $3, $4)`, [id, p.orgId, i, sealed[i]!.length]);
  return id;
}

// ---------------------------------------------------------------------------
export interface SeedCasesResult {
  cases: number;
  claims: number;
  files: number;
}

export async function seedAcmeCases(c: PoolClient, ctx: SeedCtx): Promise<SeedCasesResult> {
  const now = Date.now();
  const u = ctx.users;
  const uploader = u['upload@acme.demo']!;
  const partnerQuality = u['quality@acme.demo']!;
  const klIntake = u['intake@kline.demo']!;
  const klChaves = u['chaves@kline.demo']!;
  const klQuality = u['quality@kline.demo']!;
  const spec = (await c.query(`SELECT id FROM specs WHERE org_id = $1 AND status = 'active'`, [ctx.acmeId])).rows[0]?.id as string | undefined;
  const retention = 24;

  const ids: Record<string, { id: string; ref: string; files: string[] }> = {};
  let fileTotal = 0;

  for (const d of CASES) {
    const id = randomUUID();
    const n = (await c.query('SELECT kph_next_counter($1) AS n', ['case:ACME'])).rows[0].n as number;
    const ref = `ACME-${String(n).padStart(6, '0')}`;
    const span = d.age * DAY;
    const at = (f: number) => new Date(now - span + span * f);
    const past = (s: string) => ['ready', 'received', 'in_production', 'shipped', 'delivered'].includes(s);
    const submitted = d.status !== 'draft';
    const readyAt = past(d.status) ? at(0.12) : null;
    const stageIdx = d.stage ? STAGE_IDS.indexOf(d.stage) : -1;
    const shippedAt = d.status === 'shipped' || d.status === 'delivered' ? at(0.9) : null;
    const hasFiles = !!d.files;
    const counts = hasFiles ? null : { upper: 12, lower: 12 };
    const siteId = d.site ? ctx.siteIds[d.site]! : null;

    await c.query(
      `INSERT INTO cases (id, org_id, ref, partner_case_id, patient_enc, patient_bidx, patient_bidxs, status, stage, hold_reason, site_id, spec_id, notes_enc, priority, due_date,
                          aligners_upper, aligners_lower, aligners_shipped, carrier, tracking, submitted_at, ready_at, received_at, started_at, finished_at, shipped_at, delivered_at,
                          cancelled_at, purge_after, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)`,
      [
        id, ctx.acmeId, ref, d.caseId, encryptField(d.name, fieldAad.casePatient(id)), blindIndex(d.name), [blindIndex(d.name)], d.status, d.status === 'in_production' || d.status === 'received' || d.status === 'shipped' || d.status === 'delivered' ? d.stage ?? null : null,
        d.hold ?? null, siteId, past(d.status) || d.status === 'submitted' || d.status === 'on_hold' ? spec ?? null : null,
        d.notes || d.notesChanged ? encryptField(d.notesChanged ?? d.notes!, fieldAad.caseNotes(id)) : null, d.priority ?? 'normal',
        readyAt ? new Date(readyAt.getTime() + 3 * DAY).toISOString().slice(0, 10) : null,
        counts?.upper ?? 0, counts?.lower ?? 0, shippedAt ? (hasFiles ? 4 : 24) : 0, shippedAt ? d.carrier ?? 'DHL Express' : null, shippedAt ? d.tracking ?? 'DEMO0000000001' : null,
        submitted ? at(0.05) : null, readyAt, stageIdx >= 0 ? at(0.3) : null, stageIdx >= 1 ? at(0.4) : null, shippedAt ? at(0.85) : null, shippedAt, d.status === 'delivered' ? at(0.96) : null,
        d.status === 'cancelled' ? at(0.5) : null, shippedAt ? new Date(shippedAt.getTime() + retention * 30 * DAY) : null, uploader.id, at(0), at(0.95),
      ],
    );

    // timeline
    const ev = async (type: string, f: number, data: Record<string, unknown> = {}, actor: { type: string; id: string | null } = { type: 'system', id: null }) =>
      c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [ctx.acmeId, id, type, actor.type, actor.id, JSON.stringify(data), at(f)]);
    const partner = { type: 'user', id: uploader.id };
    const kline = { type: 'user', id: klIntake.id };
    await ev('created', 0, { mode: 'standard' }, partner);
    if (submitted) await ev('submitted', 0.05, { status: readyAt ? 'ready' : 'submitted', site: readyAt ? d.site ?? null : null }, partner);
    if (d.status === 'ready' || stageIdx >= 0) await ev('routed', 0.12, { site: d.site, source: 'kline', sourceLabel: 'K Line' }, kline);
    if (d.notesChanged) await ev('instructions_updated', 0.3, {}, partner);
    if (d.status === 'on_hold') await ev('on_hold', 0.4, { reason: d.hold, source: 'kline', sourceLabel: 'K Line', from: 'submitted' }, kline);
    if (d.status === 'cancelled') await ev('cancelled', 0.5, { source: 'partner' }, partner);
    let prev = 'ready';
    for (let k = 0; k <= stageIdx; k++) {
      const stage = STAGE_IDS[k]!;
      const status = statusForStage(stage);
      await ev('stage_reported', 0.3 + (0.66 * k) / Math.max(1, STAGE_IDS.length - 1), {
        source: 'mes', from: prev, stage, label: stageLabel(stage), status, sourceLabel: 'Factory system',
        ...(stage === 'shipped' ? { carrier: d.carrier ?? 'DHL Express', trackingNumber: d.tracking, alignersShipped: hasFiles ? 4 : 24 } : {}),
      });
      prev = status;
      await c.query(
        `INSERT INTO mes_events (external_id, case_id, payload, source, outcome, stage_code, occurred_at, received_at, processed_at) VALUES ($1, $2, $3::jsonb, 'mes', 'applied', $4, $5, $5, $5)`,
        [`demo-${ref}-${stage}`, id, JSON.stringify({ event_id: `demo-${ref}-${stage}`, case_ref: ref, stage_code: CODE_FOR_STAGE[stage], lookup: 'ref' }), CODE_FOR_STAGE[stage], at(0.3 + (0.66 * k) / Math.max(1, STAGE_IDS.length - 1))],
      );
    }

    // files
    const fileIds: string[] = [];
    if (d.files) {
      for (const f of fileSpecsFor(d.caseId, d.files)) fileIds.push(await insertFile(c, { orgId: ctx.acmeId, caseId: id, spec: f, userId: uploader.id, at: at(0.02) }));
      fileTotal += fileIds.length;
      const rows = (await c.query(`SELECT id, kind, arch, step, is_template, state, validation, meta FROM files WHERE case_id = $1 AND purpose = 'case'`, [id])).rows as CheckFile[];
      const res = computeChecks(rows, { requirePts: !!d.requirePtsWarning });
      await c.query(`UPDATE cases SET checks = $2::jsonb, aligners_upper = $3, aligners_lower = $4, aligners_templates = $5 WHERE id = $1`, [
        id, JSON.stringify({ errors: res.errors, warnings: res.warnings }), res.counts.upper, res.counts.lower, res.counts.templates,
      ]);
      if (past(d.status) && res.warnings.length) await c.query(`UPDATE cases SET warnings_acknowledged = true, warnings_acknowledged_at = $2, warnings_acknowledged_by = $3 WHERE id = $1`, [id, at(0.05), uploader.id]);
    }
    ids[d.caseId] = { id, ref, files: fileIds };

    // K Line opened files and revealed names of cases it is producing. The partner sees every one of these entries.
    if (stageIdx >= 0 && fileIds.length) {
      const f = (await c.query(`SELECT id, kind, size FROM files WHERE id = $1`, [fileIds[0]])).rows[0];
      await audit(c, { actorType: 'user', actorId: klChaves.id, orgId: ctx.acmeId, action: 'file.download', targetType: 'file', targetId: f.id, ip: '10.20.0.14', details: { caseId: id, kind: f.kind, size: Number(f.size) } });
      await audit(c, { actorType: 'user', actorId: klChaves.id, orgId: ctx.acmeId, action: 'case.name_revealed', targetType: 'case', targetId: id, ip: '10.20.0.14', details: { ref } });
    }
  }

  // ---- Replacement ordered by the partner for Yuki Tanaka (upper step 1), sharing the stored bytes of the original
  const yuki = ids['AC-1013']!;
  const replacement = await createChildCase(c, {
    parentId: yuki.id, kind: 'replacement', items: [{ arch: 'upper', step: 1, template: false }], priority: 'normal', reason: 'One aligner was lost by the patient.',
    actor: { actorType: 'user', actorId: partnerQuality.id }, userId: partnerQuality.id,
  });

  // ---- Claim 1: accepted as a remake, rework case created, claim closed
  const year = new Date().getUTCFullYear();
  const claimNumber = async () => `CLM-${year}-${String((await c.query('SELECT kph_next_counter($1) AS n', [`claim:${year}`])).rows[0].n).padStart(5, '0')}`;
  const olga = ids['AC-1014']!;
  const c1 = await claimNumber();
  const claim1 = (await c.query(
    `INSERT INTO claims (org_id, number, case_id, status, resolution, summary, description, spec_clause_ids, root_cause, corrective_action, decision_note, opened_by, decided_by, decided_at, closed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'closed', 'remake', 'Upper step 2 does not seat on the model', 'The second upper aligner rocks on the canines and does not seat fully. Photos are attached to the practice record.', '{}',
             'The aligner was trimmed before it had cooled fully, which let the edge curl.', 'Cooling time before trimming was extended and is now checked at the quality station.', 'We will remake the aligner. Sorry for the trouble.',
             $4, $5, $6, $7, $8, $7) RETURNING id`,
    [ctx.acmeId, c1, olga.id, partnerQuality.id, klQuality.id, new Date(now - 6 * DAY), new Date(now - 4 * DAY), new Date(now - 8 * DAY)],
  )).rows[0].id as string;
  await c.query(`INSERT INTO claim_items (org_id, claim_id, arch, step, is_template, defect_code, note, pos) VALUES ($1, $2, 'upper', 2, false, 'DEFORMED', 'Rocks on the canines.', 0)`, [ctx.acmeId, claim1]);
  const rework = await createChildCase(c, {
    parentId: olga.id, kind: 'rework', items: [{ arch: 'upper', step: 2, template: false }], priority: 'rush', claim: { id: claim1, number: c1 },
    actor: { actorType: 'user', actorId: klQuality.id }, userId: klQuality.id,
  });
  await c.query(`UPDATE claims SET rework_case_id = $2 WHERE id = $1`, [claim1, rework.id]);
  const msg = (claimId: string, side: 'partner' | 'kline' | 'system', author: string | null, body: string, when: Date) =>
    c.query(`INSERT INTO claim_messages (org_id, claim_id, author_id, side, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [ctx.acmeId, claimId, author, side, body, when]);
  await msg(claim1, 'system', null, 'Claim opened.', new Date(now - 8 * DAY));
  await msg(claim1, 'partner', partnerQuality.id, 'The aligner does not seat. We need a new one before the next check-up.', new Date(now - 7.5 * DAY));
  await msg(claim1, 'system', null, `Claim accepted. Resolution: remake. A rush rework case ${rework.ref} has been created.`, new Date(now - 6 * DAY));
  await msg(claim1, 'kline', klQuality.id, 'We will remake the aligner. Sorry for the trouble.', new Date(now - 6 * DAY + 60_000));
  await msg(claim1, 'system', null, 'Claim closed.', new Date(now - 4 * DAY));
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data, created_at) VALUES ($1, $2, 'claim_opened', 'user', $3, $4::jsonb, $5)`, [ctx.acmeId, olga.id, partnerQuality.id, JSON.stringify({ claimNumber: c1, items: 1 }), new Date(now - 8 * DAY)]);
  await audit(c, { actorType: 'user', actorId: partnerQuality.id, orgId: ctx.acmeId, action: 'claim.opened', targetType: 'claim', targetId: claim1, details: { number: c1, items: 1 } });
  await audit(c, { actorType: 'user', actorId: klQuality.id, orgId: ctx.acmeId, action: 'claim.accepted', targetType: 'claim', targetId: claim1, details: { number: c1, resolution: 'remake', reworkRef: rework.ref } });
  await audit(c, { actorType: 'user', actorId: klQuality.id, orgId: ctx.acmeId, action: 'claim.closed', targetType: 'claim', targetId: claim1, details: { number: c1, outcome: 'accepted' } });

  // ---- Claim 2: still in review, on the delivered case
  const clara = ids['AC-1015']!;
  const c2 = await claimNumber();
  const claim2 = (await c.query(
    `INSERT INTO claims (org_id, number, case_id, status, summary, description, spec_clause_ids, opened_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'in_review', 'Lower step 1 has a sharp edge', 'The distal edge of the lower aligner is sharp and irritates the patient.', '{}', $4, $5, $5) RETURNING id`,
    [ctx.acmeId, c2, clara.id, partnerQuality.id, new Date(now - 2 * DAY)],
  )).rows[0].id as string;
  await c.query(`INSERT INTO claim_items (org_id, claim_id, arch, step, is_template, defect_code, note, pos) VALUES ($1, $2, 'lower', 1, false, 'SHARP_EDGE', 'Distal edge.', 0)`, [ctx.acmeId, claim2]);
  await msg(claim2, 'system', null, 'Claim opened.', new Date(now - 2 * DAY));
  await msg(claim2, 'kline', klQuality.id, 'Thank you. The quality team is looking at the batch records.', new Date(now - 1.5 * DAY));
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data, created_at) VALUES ($1, $2, 'claim_opened', 'user', $3, $4::jsonb, $5)`, [ctx.acmeId, clara.id, partnerQuality.id, JSON.stringify({ claimNumber: c2, items: 1 }), new Date(now - 2 * DAY)]);
  await audit(c, { actorType: 'user', actorId: partnerQuality.id, orgId: ctx.acmeId, action: 'claim.opened', targetType: 'claim', targetId: claim2, details: { number: c2, items: 1 } });

  // ---- Factory event log: a code that is not in the stage map, and an event that arrived twice
  await c.query(
    `INSERT INTO mes_events (external_id, payload, source, outcome, message, stage_code, occurred_at, received_at, processed_at)
     VALUES (NULL, $1::jsonb, 'mes', 'error', 'The stage code XRAY9 is not in the stage map.', 'XRAY9', now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours')`,
    [JSON.stringify({ event_id: 'demo-unmapped-1', case_ref: ids['AC-1007']!.ref, stage_code: 'XRAY9', lookup: 'ref' })],
  );
  await c.query(
    `INSERT INTO mes_events (external_id, payload, source, outcome, message, stage_code, occurred_at, received_at, processed_at)
     VALUES (NULL, $1::jsonb, 'mes', 'duplicate', 'This event was already received.', 'THERMO', now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours')`,
    [JSON.stringify({ event_id: `demo-${ids['AC-1007']!.ref}-thermoforming`, case_ref: ids['AC-1007']!.ref, stage_code: 'THERMO', lookup: 'ref' })],
  );

  // A few K Line staff actions that partners can see in their audit view
  await audit(c, { actorType: 'user', actorId: klIntake.id, orgId: ctx.acmeId, action: 'case.routed', targetType: 'case', targetId: ids['AC-1004']!.id, ip: '10.20.0.11', details: { ref: ids['AC-1004']!.ref, site: 'PT-CHV' } });
  await audit(c, { actorType: 'user', actorId: klIntake.id, orgId: ctx.acmeId, action: 'case.on_hold', targetType: 'case', targetId: ids['AC-1003']!.id, ip: '10.20.0.11', details: { ref: ids['AC-1003']!.ref } });

  void replacement;
  return { cases: CASES.length + 2, claims: 2, files: fileTotal };
}

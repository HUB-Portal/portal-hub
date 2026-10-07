import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { audit } from '../audit';
import { SYSTEM, many, one, tx } from '../db';
import { decryptField, fieldAad } from '../crypto/keys';
import { registerJob, type JobRow } from '../jobs';
import { refreshBatch } from './cases';
import { FILE_COLUMNS, fileContentStream, fileName } from './files';
import { canonicalNames, csvCell, zipStream, type ZipEntry } from './packaging';
import { CASE_ADDRESS_REQUIRED_MESSAGE, isCompleteCaseAddress, type CaseAddress } from '../../../shared/caseAddress';
import { PortalError, getPortalClient, isDemoPortal, portalSettings, type PortalClient } from './portal';

interface PushProgress {
  /** The case address (portal shipping address) was set. The portal refuses it after submit, so it is set once, before the uploads. */
  address?: boolean;
  docs: Record<string, true>;
  bundle: boolean;
  submitted: boolean;
}

const DOC_KINDS = new Set(['pdf', 'image']);

/** Which files the portal takes as they are (PDFs and images) and which go into the single bundle zip. */
export function splitForPortal<T extends { kind: string }>(files: T[]): { docs: T[]; bundle: T[] } {
  return { docs: files.filter((f) => DOC_KINDS.has(f.kind)), bundle: files.filter((f) => !DOC_KINDS.has(f.kind)) };
}

export function bundleEntries(files: any[]): ZipEntry[] {
  const named = files.map((f) => ({ id: f.id, kind: f.kind, arch: f.arch, step: f.step, is_template: f.is_template, ext: f.ext, name: fileName(f) }));
  const names = canonicalNames(named);
  const rows = ['path,kind,arch,step,template,size,sha256'];
  const entries: ZipEntry[] = [];
  for (const f of files) {
    const p = names.get(f.id)!;
    rows.push([p, f.kind, f.arch ?? '', f.step ?? '', f.is_template ? 'yes' : 'no', Number(f.size), f.meta?.sha256 ?? ''].map(csvCell).join(','));
    entries.push({ name: p, stream: () => fileContentStream(f), size: Number(f.size), level: 1 });
  }
  entries.unshift({ name: 'manifest.csv', buffer: Buffer.from(rows.join('\r\n') + '\r\n', 'utf8'), level: 6 });
  return entries;
}

const recordProgress = (caseId: string, extra: Record<string, unknown>) =>
  tx(SYSTEM, (c) => c.query(`UPDATE cases SET portal_push = COALESCE(portal_push, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`, [caseId, JSON.stringify(extra)]));

/** The push cannot go on until the partner fixes something in the Hub. Never retried automatically. */
class PushRefused extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

const SAFE_ERROR = 'The push failed because of an internal problem.';

/**
 * Pushes one direct manufacturing case to the K Line portal. Safe to run again at any point:
 * the portal case uuid is stored straight after it is created and every finished upload is recorded.
 * Nothing in job payloads, logs or error text holds patient data.
 */
export async function bulkPushJob(job: Pick<JobRow, 'payload' | 'attempts' | 'max_attempts'>): Promise<void> {
  const caseId = String(job.payload?.caseId ?? '');
  const loaded = await tx(SYSTEM, async (c) => {
    const row = await one<any>(
      c,
      `SELECT c.*, o.settings AS org_settings
         FROM cases c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1 FOR UPDATE OF c`,
      [caseId],
    );
    // An erased or purged case has no names left to send.
    if (!row || row.purged_at || row.manufacturing_mode !== 'direct' || !['submitted', 'ready'].includes(row.status)) return null;
    const push = row.portal_push ?? {};
    if (push.status === 'pushed') return null;
    await c.query(
      `UPDATE cases SET portal_push = (COALESCE(portal_push, '{}'::jsonb) - 'lastError') || jsonb_build_object('status', 'pushing', 'attempts', $2::int, 'startedAt', now()) WHERE id = $1`,
      [caseId, Number(push.attempts ?? 0) + 1],
    );
    const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.state = 'ready' ORDER BY f.created_at, f.id`, [caseId]);
    return { row, files, push };
  });
  if (!loaded) return;
  const { row, files } = loaded;
  const progress: PushProgress = { docs: {}, bundle: false, submitted: false, ...(loaded.push.uploads ?? {}) };
  let client: (PortalClient & { close?: () => Promise<void> }) | undefined;
  let tmpFile: string | undefined;
  try {
    // The portal keeps a shipping address on every case. Without a complete one nothing is created: the partner adds it and presses Try again.
    // The address is the company case address, kept by the company administrators. It is read now, when the address step runs.
    // A case that already has its address keeps what it was sent with.
    const chosen = isCompleteCaseAddress(row.org_settings?.case_address) ? (row.org_settings.case_address as CaseAddress) : null;
    if (!progress.address && !chosen) throw new PushRefused(CASE_ADDRESS_REQUIRED_MESSAGE, 'case_address_required');
    client = getPortalClient({ id: row.org_id, settings: row.org_settings ?? {} });
    const demo = isDemoPortal(client);
    const ps = portalSettings(row.org_settings);

    let uuid: string | null = row.portal_case_uuid;
    if (!uuid) {
      await recordProgress(caseId, { step: 1 });
      const first = decryptField(row.patient_first_enc, fieldAad.casePatientFirst(caseId));
      const last = decryptField(row.patient_last_enc, fieldAad.casePatientLast(caseId));
      const instructions = row.notes_enc ? decryptField(row.notes_enc, fieldAad.caseNotes(caseId)) : null;
      const created = await client.createCase({
        firstName: first,
        lastName: last,
        gender: Number.isInteger(ps.defaultGender) ? (ps.defaultGender as number) : 2,
        productType: 0,
        doctorInstructions: instructions,
      });
      uuid = created.uuid;
      await tx(SYSTEM, (c) => c.query(`UPDATE cases SET portal_case_uuid = $2, portal_push = portal_push || jsonb_build_object('createdAt', now()) WHERE id = $1`, [caseId, uuid]));
    }

    // Order: create the case, set its shipping address, upload the files, submit. The portal refuses address changes once a direct case is submitted.
    if (!progress.address) {
      await recordProgress(caseId, { step: 2 });
      await client.setShippingAddress(uuid, chosen!);
      progress.address = true;
      await recordProgress(caseId, { uploads: progress });
    }

    const timings: Record<string, number> = {};
    await recordProgress(caseId, { step: 2 });
    const { docs, bundle } = splitForPortal(files);
    for (const f of docs) {
      if (progress.docs[f.id]) continue;
      await client.uploadFile(uuid, 'field_case_other_docs', fileName(f), Readable.from(fileContentStream(f)), Number(f.size));
      progress.docs[f.id] = true;
      await recordProgress(caseId, { uploads: progress });
    }
    if (bundle.length && !progress.bundle) {
      tmpFile = path.join(tmpdir(), `kph-push-${randomBytes(12).toString('hex')}.zip`);
      const zipStart = Date.now();
      await pipeline(zipStream(bundleEntries(bundle)), createWriteStream(tmpFile, { mode: 0o600 }));
      const size = (await stat(tmpFile)).size;
      timings.zipMs = Date.now() - zipStart;
      timings.zipBytes = size;
      const uploadStart = Date.now();
      await client.uploadFile(uuid, 'field_case_other_docs', `${row.ref}-files.zip`, createReadStream(tmpFile), size);
      timings.uploadMs = Date.now() - uploadStart;
      progress.bundle = true;
      await recordProgress(caseId, { uploads: progress });
    }
    if (!progress.submitted) {
      await recordProgress(caseId, { step: 3 });
      await client.submitCase(uuid);
      progress.submitted = true;
      await recordProgress(caseId, { uploads: progress });
    }

    await tx(SYSTEM, async (c) => {
      await c.query(`UPDATE cases SET portal_push = (portal_push - 'lastError') || jsonb_build_object('status', 'pushed', 'pushedAt', now(), 'demo', $2::boolean),
              purge_after = COALESCE(purge_after, now() + make_interval(months => (SELECT retention_months FROM organizations o WHERE o.id = cases.org_id))), updated_at = now() WHERE id = $1`, [caseId, demo]);
      await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) VALUES ($1, $2, 'portal_pushed', 'system', $3::jsonb)`, [
        row.org_id, caseId, JSON.stringify({ documents: docs.length, bundled: bundle.length, ...(demo ? { demo: true } : {}), ...timings }),
      ]);
      await audit(c, { actorType: 'system', orgId: row.org_id, action: 'case.portal_pushed', targetType: 'case', targetId: caseId, details: { ref: row.ref } });
      await refreshBatch(c, row.bulk_batch_id);
    });
    // The portal puts a submitted direct case into production straight away, so read its status now instead of waiting for the 10 minute check.
    if (client && !isDemoPortal(client)) {
      try {
        const { runPortalSync } = await import('./portalSync');
        await runPortalSync({ caseId });
      } catch {
        /* the regular sync will catch up */
      }
    }
  } catch (e) {
    const pe = e instanceof PortalError ? e : null;
    const refused = e instanceof PushRefused ? e : null;
    const lastError = pe ? pe.message : refused ? refused.message : SAFE_ERROR;
    const permanent = refused ? true : pe ? !pe.retryable : false;
    const exhausted = job.attempts >= job.max_attempts;
    if (permanent || exhausted) {
      await tx(SYSTEM, async (c) => {
        await c.query(`UPDATE cases SET portal_push = portal_push || jsonb_build_object('status', 'failed', 'lastError', $2::text, 'failedAt', now()), updated_at = now() WHERE id = $1`, [caseId, lastError]);
        await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) VALUES ($1, $2, 'portal_push_failed', 'system', $3::jsonb)`, [
          row.org_id, caseId, JSON.stringify({ code: pe?.code ?? refused?.code ?? 'internal', status: pe?.status ?? null, attempts: job.attempts }),
        ]);
        await audit(c, { actorType: 'system', orgId: row.org_id, action: 'case.portal_push_failed', targetType: 'case', targetId: caseId, details: { ref: row.ref, code: pe?.code ?? refused?.code ?? 'internal' } });
        await refreshBatch(c, row.bulk_batch_id);
      });
      if (permanent) return; // no point retrying: the partner fixes the cause and retries by hand
      throw new Error(lastError);
    }
    await recordProgress(caseId, { status: 'pending', lastError });
    throw new Error(lastError);
  } finally {
    if (tmpFile) await rm(tmpFile, { force: true }).catch(() => undefined);
    await client?.close?.().catch(() => undefined);
  }
}

registerJob('bulk.push', bulkPushJob);

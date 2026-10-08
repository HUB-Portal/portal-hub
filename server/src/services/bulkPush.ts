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
import { enqueue, registerJob, type JobRow } from '../jobs';
import { notifyKline } from './notify';
import { refreshBatch } from './cases';
import { FILE_COLUMNS, fileContentStream, fileName } from './files';
import { canonicalNames, csvCell, zipStream, type ZipEntry } from './packaging';
import { CASE_ADDRESS_REQUIRED_MESSAGE } from '../../../shared/caseAddress';
import { pickCaseAddress } from './userCaseAddress';
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
 * A push that fails for a reason the partner cannot fix (the portal connection or the portal itself) is K Line's to repair, not the partner's.
 * K Line is alerted once, and the push is tried again by itself every AUTO_RETRY_MINUTES, up to AUTO_RETRY_LIMIT times (about two days).
 * The partner sees "Delayed on our side, no action needed" and never the error text (review of 8 Oct 2026, R3).
 */
const AUTO_RETRY_MINUTES = 30;
const AUTO_RETRY_LIMIT = 96;

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
      `SELECT c.*, o.settings AS org_settings,
              (SELECT u.case_address FROM users u WHERE u.id = c.created_by AND u.org_id = c.org_id) AS sender_address
         FROM cases c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1 FOR UPDATE OF c`,
      [caseId],
    );
    // An erased or purged case has no names left to send.
    if (!row || row.purged_at || row.manufacturing_mode !== 'direct' || !['submitted', 'ready'].includes(row.status)) return null;
    const push = row.portal_push ?? {};
    const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.state = 'ready' ORDER BY f.created_at, f.id`, [caseId]);
    if (push.status === 'pushed') {
      // Already at the portal. Only documents added after that (the paperclip on a sent case) still have to go there.
      const sent = push.uploads?.docs ?? {};
      if (!row.portal_case_uuid || !splitForPortal(files).docs.some((f) => !sent[f.id])) return null;
      return { row, files, push, late: true as const };
    }
    await c.query(
      `UPDATE cases SET portal_push = (COALESCE(portal_push, '{}'::jsonb) - 'lastError') || jsonb_build_object('status', 'pushing', 'attempts', $2::int, 'startedAt', now()) WHERE id = $1`,
      [caseId, Number(push.attempts ?? 0) + 1],
    );
    return { row, files, push, late: false as const };
  });
  if (!loaded) return;
  const { row, files } = loaded;
  if (loaded.late) {
    // A failure here leaves the case as it is (it was sent already). The job is tried again, and K Line sees the failed job.
    const client = getPortalClient({ id: row.org_id, settings: row.org_settings ?? {} });
    try {
      const sent: Record<string, boolean> = { ...(loaded.push.uploads?.docs ?? {}) };
      for (const f of splitForPortal(files).docs) {
        if (sent[f.id]) continue;
        await client.uploadFile(row.portal_case_uuid, 'field_case_other_docs', fileName(f), Readable.from(fileContentStream(f)), Number(f.size));
        sent[f.id] = true;
        await recordProgress(caseId, { uploads: { ...(loaded.push.uploads ?? { bundle: false, submitted: true }), docs: sent } });
      }
    } finally {
      await (client as PortalClient & { close?: () => Promise<void> }).close?.().catch(() => undefined);
    }
    return;
  }
  const progress: PushProgress = { docs: {}, bundle: false, submitted: false, ...(loaded.push.uploads ?? {}) };
  let client: (PortalClient & { close?: () => Promise<void> }) | undefined;
  let tmpFile: string | undefined;
  try {
    // The portal keeps a shipping address on every case. Without a complete one nothing is created: the partner adds it and presses Try again.
    // The address is the sender's own (the user who created the case, never the worker) when it is complete, otherwise the company default.
    // It is resolved now, when the address step runs. A case that already has its address keeps what it was sent with.
    const chosen = pickCaseAddress(row.sender_address, row.org_settings?.case_address);
    if (!progress.address && !chosen) throw new PushRefused(CASE_ADDRESS_REQUIRED_MESSAGE, 'case_address_required');
    client = getPortalClient({ id: row.org_id, settings: row.org_settings ?? {} });
    const demo = isDemoPortal(client);
    const ps = portalSettings(row.org_settings);

    let uuid: string | null = row.portal_case_uuid;
    if (!uuid) {
      await recordProgress(caseId, { step: 1 });
      // The names are optional on our side, the K Line portal needs a last name: a case without one goes under its reference (no patient data).
      let first = decryptField(row.patient_first_enc, fieldAad.casePatientFirst(caseId));
      let last = decryptField(row.patient_last_enc, fieldAad.casePatientLast(caseId));
      if (!first && !last) { first = 'Patient'; last = row.ref; }
      else if (!last) { last = first; first = ''; }
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
      await client.setShippingAddress(uuid, chosen!.address);
      progress.address = true;
      // Only where the address came from is kept ('own' or 'company'), never its values.
      await recordProgress(caseId, { uploads: progress, addressSource: chosen!.source });
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
        if (!refused) {
          const tries = Number(loaded.push.autoRetries ?? 0);
          if (tries === 0) {
            await notifyKline(c, row.org_id, {
              kind: 'portal_push_failed',
              title: 'A direct manufacturing case could not be sent to the K Line portal',
              body: `Case ${row.ref} is waiting. Check the portal connection of the partner. The Hub tries again by itself every ${AUTO_RETRY_MINUTES} minutes.`,
              data: { caseId, ref: row.ref },
            });
          }
          if (tries < AUTO_RETRY_LIMIT) {
            await enqueue(c, 'bulk.push', { caseId }, { orgId: row.org_id, maxAttempts: 5, runAt: new Date(Date.now() + AUTO_RETRY_MINUTES * 60_000) });
            await c.query(`UPDATE cases SET portal_push = portal_push || jsonb_build_object('autoRetries', $2::int) WHERE id = $1`, [caseId, tries + 1]);
          }
        }
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

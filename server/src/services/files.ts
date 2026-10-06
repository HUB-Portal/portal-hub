import { createHash, randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { SYSTEM, many, one, tx, type DbCtx, type PoolClient } from '../db';
import { CHUNK_SIZE, chunkCountFor, fileCipherFromRow, newFileKey, openStream, sealChunk } from '../crypto/envelope';
import { decryptField, encryptField, fieldAad } from '../crypto/keys';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import { assertNoBidi } from '../http/util';
import { enqueue, registerJob, type JobRow } from '../jobs';
import { chunkKey, newStoragePrefix, storage } from '../storage';
import { orgUploadState } from './org';
import { scanner } from './scanner';
import { assertInScope, siteScope } from './scope';
import { recomputeCase } from './checks';
import { EXECUTABLE_EXTENSIONS, detectExecutable, validateContent, type ContentSource, type ValidationResult } from './validate';
import { parseFileName } from '../../../shared/filenames';

export const MAX_CASE_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_FILES_PER_CASE = 600;
export const CASE_FILE_EXTENSIONS = ['stl', 'pts', 'pdf', 'csv', 'svg', 'txt', 'xml', 'json', 'jpg', 'jpeg', 'png'] as const;
export const OPEN_CASE_STATES = ['draft', 'on_hold'];

const KIND_BY_EXT: Record<string, string> = {
  stl: 'stl', pts: 'pts', pdf: 'pdf', csv: 'csv', svg: 'svg', jpg: 'image', jpeg: 'image', png: 'image', txt: 'other', xml: 'other', json: 'other',
  mp4: 'video', mov: 'video', m4v: 'video',
};
export const TYPE_BY_EXT: Record<string, string> = {
  stl: 'model/stl', pts: 'text/plain', pdf: 'application/pdf', csv: 'text/csv', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  txt: 'text/plain', xml: 'application/xml', json: 'application/json', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
};

export type UploadPurpose = 'case' | 'claim' | 'shipment' | 'logo' | 'document';
/** Company profile files: logos (company and brands) and documents. Owned by the organisation itself. */
export const PROFILE_PURPOSES: readonly string[] = ['logo', 'document'];
export const LOGO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg'] as const;
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'] as const;
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const DOCUMENT_KINDS = ['qc_criteria', 'packaging', 'other'] as const;
/** While a partner is not approved it may store only this many profile files (logos and documents together). */
export const MAX_PROFILE_FILES_UNAPPROVED = 10;
export const MAX_LOGO_FILES = 60;
export const MAX_DOCUMENT_FILES = 200;
/** Evidence for a quality claim: photos, videos and PDFs. */
export const CLAIM_FILE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'mp4', 'mov', 'm4v', 'pdf'] as const;
export const MAX_CLAIM_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_CLAIM_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_CLAIM = 40;
/** Documents for a material shipment: delivery notes and photos. */
export const SHIPMENT_FILE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'pdf'] as const;
export const MAX_SHIPMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_SHIPMENT = 20;
/** Claims accept evidence while someone still needs to look at them. */
export const CLAIM_UPLOAD_STATES = ['open', 'in_review', 'awaiting_partner'];

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const FILE_NAME_MAX = 255;

/**
 * Basename only, control characters removed, at most 255 characters. A name that is too long is shortened inside its name part:
 * the extension is always kept, because the extension decides what kind of file it is (cutting it off would look like an unknown file type).
 */
export function cleanFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (base.length <= FILE_NAME_MAX) return base;
  const ext = extensionOf(base);
  if (ext && ext.length <= 16) return base.slice(0, FILE_NAME_MAX - ext.length - 1).trimEnd() + '.' + base.slice(base.length - ext.length);
  return base.slice(0, FILE_NAME_MAX);
}

export interface FileDto {
  id: string;
  caseId: string | null;
  kind: string;
  arch: string | null;
  step: number | null;
  template: boolean;
  claimId: string | null;
  shipmentId: string | null;
  name: string;
  ext: string | null;
  size: number;
  state: string;
  scan: string;
  validation: { errors: unknown[]; warnings: unknown[]; meta: Record<string, unknown> };
  createdAt: string;
}

export function fileName(row: { id: string; name_enc: string | null }): string {
  if (!row.name_enc) return 'file';
  try {
    return decryptField(row.name_enc, fieldAad.fileName(row.id));
  } catch {
    return 'file';
  }
}

export function fileDto(row: any): FileDto {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    arch: row.arch,
    step: row.step,
    template: row.is_template,
    claimId: row.claim_id ?? null,
    shipmentId: row.shipment_id ?? null,
    name: fileName(row),
    ext: row.ext,
    size: row.size,
    state: row.state,
    scan: row.scan_status,
    validation: { errors: row.validation?.errors ?? [], warnings: row.validation?.warnings ?? [], meta: row.meta ?? {} },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Decrypted content of a stored file, verified chunk by chunk. */
export async function* fileContentStream(row: { id: string; cipher_file_id?: string | null; wrapped_key: string; nonce_prefix: string; storage_prefix: string; chunk_count: number }): AsyncGenerator<Buffer> {
  const st = await storage();
  // A child case reuses its parent's stored bytes, which are bound to the parent's file id.
  const cipher = fileCipherFromRow({ id: row.cipher_file_id ?? row.id, wrapped_key: row.wrapped_key, nonce_prefix: row.nonce_prefix });
  async function* sealed(): AsyncGenerator<Buffer> {
    for (let i = 0; i < row.chunk_count; i++) yield await st.getBuffer(chunkKey(row.storage_prefix, i));
  }
  yield* openStream(cipher, sealed(), row.chunk_count);
}

export function fileSourceFromRow(row: any): ContentSource {
  return { size: Number(row.size), stream: () => fileContentStream(row) };
}

export const FILE_COLUMNS = `f.id, f.org_id, f.case_id, f.claim_id, f.shipment_id, f.cipher_file_id, f.uploader_id, f.purpose, f.kind, f.arch, f.step, f.is_template, f.name_enc, f.ext, f.content_type, f.size, f.chunk_size, f.chunk_count,
  f.wrapped_key, f.key_id, f.nonce_prefix, f.storage_prefix, f.state, f.scan_status, f.validation, f.meta, f.created_at`;

// ---------------------------------------------------------------------------
// Upload protocol
// ---------------------------------------------------------------------------
export interface CreateUploadInput {
  purpose?: UploadPurpose;
  /** Purpose `case`. */
  caseId?: string;
  /** Purpose `claim`. */
  claimId?: string;
  /** Purpose `shipment`. */
  shipmentId?: string;
  name: string;
  size: number;
  arch?: 'upper' | 'lower' | null;
  step?: number | null;
  template?: boolean;
  /** Purpose document: what kind of document it is. */
  kind?: (typeof DOCUMENT_KINDS)[number];
}

export interface UploadInfo {
  fileId: string;
  chunkSize: number;
  chunkCount: number;
  received: number[];
  state: string;
}

const PURPOSE_PERMISSION = { case: 'case.write', claim: 'claim.write', shipment: 'material.declare', logo: 'org.logo', document: 'org.edit' } as const;

/**
 * Who may upload for which purpose. Case files: case.write (people and keys). Claim evidence and shipment documents:
 * people of the partner organisation only (a partner key has no scope for them, and K Line staff answer in messages instead).
 * Logos: org.logo (every team role except viewer), so anyone who may change the company logo can upload it. Attaching a logo to a
 * brand still needs org.edit (see the brand logo routes). Documents: org.edit.
 */
export function assertUploadPermission(a: AuthContext, purpose: string): void {
  const p = PURPOSE_PERMISSION[purpose as UploadPurpose];
  if (!p || !a.permissions.has(p)) throw forbidden();
  if (purpose !== 'case' && (a.kind !== 'user' || a.orgKind !== 'partner')) throw forbidden('Only people in the partner organisation can add these files.');
}

async function lockOpenCase(c: PoolClient, caseId: string): Promise<{ id: string; org_id: string; status: string }> {
  const cs = await one<any>(c, 'SELECT id, org_id, status, purged_at FROM cases WHERE id = $1 FOR UPDATE', [caseId]);
  if (!cs) throw notFound('That case could not be found.');
  if (cs.purged_at) throw conflict('The data of this case was removed, so files cannot be added.', 'case_erased');
  if (!OPEN_CASE_STATES.includes(cs.status)) throw conflict('Files can only be added while a case is a draft or on hold.', 'case_not_open');
  return cs;
}

async function lockOpenClaim(c: PoolClient, claimId: string): Promise<{ id: string; org_id: string; status: string }> {
  const cl = await one<any>(c, 'SELECT id, org_id, status FROM claims WHERE id = $1 FOR UPDATE', [claimId]);
  if (!cl) throw notFound('That claim could not be found.');
  if (!CLAIM_UPLOAD_STATES.includes(cl.status)) throw conflict('Files can no longer be added to this claim.', 'claim_not_open');
  return cl;
}

async function lockOpenShipment(c: PoolClient, shipmentId: string): Promise<{ id: string; org_id: string; status: string }> {
  const sh = await one<any>(c, 'SELECT id, org_id, status FROM material_shipments WHERE id = $1 FOR UPDATE', [shipmentId]);
  if (!sh) throw notFound('That shipment could not be found.');
  if (sh.status !== 'in_transit') throw conflict('Documents can only be added while a shipment is on its way.', 'shipment_not_open');
  return sh;
}

/** Profile files (logo, document) belong to the organisation: lock its row, which also serialises the file count. */
async function lockProfileOwner(c: PoolClient, orgId: string): Promise<{ org_id: string; status: string }> {
  const o = await one<any>(c, 'SELECT id, status FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  if (!o) throw notFound('That organisation could not be found.');
  return { org_id: o.id, status: o.status };
}

/** Locks the owner (case, claim or shipment) of a file and checks that it still accepts files. */
async function lockOwnerOpen(c: PoolClient, f: { case_id: string | null; claim_id: string | null; shipment_id: string | null; org_id?: string; purpose?: string }): Promise<{ org_id: string }> {
  if (f.purpose && PROFILE_PURPOSES.includes(f.purpose)) return lockProfileOwner(c, f.org_id!);
  if (f.claim_id) return lockOpenClaim(c, f.claim_id);
  if (f.shipment_id) return lockOpenShipment(c, f.shipment_id);
  return lockOpenCase(c, f.case_id!);
}

async function receivedChunks(c: PoolClient, fileId: string): Promise<number[]> {
  const r = await many<{ idx: number }>(c, 'SELECT idx FROM file_chunks WHERE file_id = $1 ORDER BY idx', [fileId]);
  return r.map((x) => x.idx);
}

export async function createUpload(ctx: DbCtx, a: AuthContext, input: CreateUploadInput): Promise<UploadInfo> {
  const purpose: UploadPurpose = input.purpose ?? 'case';
  assertUploadPermission(a, purpose);
  assertNoBidi(input.name);
  const name = cleanFileName(input.name);
  if (!name) throw badRequest('Give the file a name.', 'invalid_request');
  const ext = extensionOf(name);
  if (EXECUTABLE_EXTENSIONS.has(ext)) throw new AppError(415, 'file_type_not_allowed', 'Programs and scripts cannot be uploaded.');
  const allowed: readonly string[] =
    purpose === 'claim'
      ? CLAIM_FILE_EXTENSIONS
      : purpose === 'shipment'
        ? SHIPMENT_FILE_EXTENSIONS
        : purpose === 'logo'
          ? LOGO_EXTENSIONS
          : purpose === 'document'
            ? DOCUMENT_EXTENSIONS
            : CASE_FILE_EXTENSIONS;
  if (!allowed.includes(ext)) {
    throw new AppError(415, 'file_type_not_allowed', `Files of this type cannot be uploaded. Allowed types: ${allowed.join(', ')}.`);
  }
  if (!Number.isInteger(input.size) || input.size <= 0) throw badRequest('The file is empty.', 'empty_file');
  const kind = KIND_BY_EXT[ext]!;
  if (purpose === 'case' && input.size > MAX_CASE_FILE_BYTES) throw new AppError(413, 'file_too_large', 'That file is larger than 512 MB.');
  if (purpose === 'claim') {
    if (kind === 'video' ? input.size > MAX_CLAIM_VIDEO_BYTES : input.size > MAX_CLAIM_FILE_BYTES) {
      throw new AppError(413, 'file_too_large', kind === 'video' ? 'That video is larger than 512 MB.' : 'That file is larger than 50 MB.');
    }
  }
  if (purpose === 'shipment' && input.size > MAX_SHIPMENT_FILE_BYTES) throw new AppError(413, 'file_too_large', 'That file is larger than 25 MB.');
  if (purpose === 'logo' && input.size > MAX_LOGO_BYTES) throw new AppError(413, 'file_too_large', 'A logo can be at most 5 MB.');
  if (purpose === 'document' && input.size > MAX_DOCUMENT_BYTES) throw new AppError(413, 'file_too_large', 'That file is larger than 50 MB.');
  const profile = PROFILE_PURPOSES.includes(purpose);

  let arch = input.arch;
  let step = input.step;
  let template = input.template;
  if (purpose === 'case' && ['stl', 'pts', 'csv'].includes(kind)) {
    const parsed = parseFileName(name);
    if (arch === undefined) arch = parsed.arch;
    if (step === undefined) step = parsed.step;
    if (template === undefined) template = parsed.template;
  }
  if (purpose !== 'case') {
    arch = null;
    step = null;
    template = false;
  }

  const ownerCol = purpose === 'claim' ? 'claim_id' : purpose === 'shipment' ? 'shipment_id' : profile ? 'org_id' : 'case_id';
  // Profile files belong to the caller's own organisation, never to one named in the request.
  const ownerId = purpose === 'claim' ? input.claimId : purpose === 'shipment' ? input.shipmentId : profile ? a.orgId : input.caseId;
  if (!ownerId) throw badRequest(purpose === 'claim' ? 'Give the claim.' : purpose === 'shipment' ? 'Give the shipment.' : 'Give the case.', 'invalid_request');

  return tx(ctx, async (c) => {
    const owner = profile
      ? await lockProfileOwner(c, ownerId)
      : purpose === 'claim'
        ? await lockOpenClaim(c, ownerId)
        : purpose === 'shipment'
          ? await lockOpenShipment(c, ownerId)
          : await lockOpenCase(c, ownerId);
    // Case files and shipment documents need an approved organisation. Claim evidence is open to any organisation that has a claim.
    // Profile files (logos, documents) are open while onboarding, with a small limit.
    const st = profile ? null : await orgUploadState(c, owner.org_id);
    if (st && !st.unlocked && purpose !== 'claim') throw forbidden('Uploads are locked until your organisation is approved and a data processing agreement is on file.', 'org_not_approved');

    // Resume: same owner, same name and size. Case models and trim lines must also have the same arch, step and template flag:
    // `Upper/Step 01.stl` and `Lower/Step 01.stl` can share a name and a size, and they are two different files.
    const candidates = await many<any>(
      c,
      `SELECT id, name_enc, state, chunk_count, arch, step, is_template FROM files WHERE ${ownerCol} = $1 AND purpose = $3 AND size = $2 AND state IN ('uploading', 'processing', 'ready')`,
      [ownerId, input.size, purpose],
    );
    const sameSlot = (f: any) => purpose !== 'case' || ((f.arch ?? null) === (arch ?? null) && (f.step ?? null) === (step ?? null) && !!f.is_template === !!template);
    for (const f of candidates) {
      if (fileName(f) === name && sameSlot(f)) {
        const received = f.state === 'uploading' ? await receivedChunks(c, f.id) : Array.from({ length: f.chunk_count }, (_, i) => i);
        return { fileId: f.id, chunkSize: CHUNK_SIZE, chunkCount: f.chunk_count, received, state: f.state };
      }
    }

    if (profile) {
      const all = await one<{ n: number; mine: number }>(
        c,
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE purpose = $2)::int AS mine FROM files WHERE org_id = $1 AND purpose IN ('logo', 'document') AND state <> 'purged'`,
        [ownerId, purpose],
      );
      if ((owner as { status: string }).status !== 'active' && (all?.n ?? 0) >= MAX_PROFILE_FILES_UNAPPROVED) {
        throw conflict(
          `Until K Line has approved your company you can store at most ${MAX_PROFILE_FILES_UNAPPROVED} logos and documents. Remove one or wait for approval.`,
          'profile_files_limit',
        );
      }
      if ((all?.mine ?? 0) >= (purpose === 'logo' ? MAX_LOGO_FILES : MAX_DOCUMENT_FILES)) {
        throw conflict('You have reached the limit for stored files of this type. Remove some first.', 'too_many_files');
      }
    } else {
      const n = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM files WHERE ${ownerCol} = $1 AND purpose = $2 AND state <> 'purged'`, [ownerId, purpose]);
      const cap = purpose === 'claim' ? MAX_FILES_PER_CLAIM : purpose === 'shipment' ? MAX_FILES_PER_SHIPMENT : MAX_FILES_PER_CASE;
      if ((n?.n ?? 0) >= cap) throw conflict(`A ${purpose} can hold at most ${cap} files.`, 'too_many_files');
    }

    const id = randomUUID();
    const key = newFileKey(id);
    const count = chunkCountFor(input.size);
    await c.query(
      `INSERT INTO files (id, org_id, purpose, ${profile ? 'doc_kind' : ownerCol}, kind, arch, step, is_template, name_enc, ext, content_type, size, chunk_size, chunk_count,
                          wrapped_key, key_id, nonce_prefix, storage_prefix, state, uploader_id, api_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'uploading', $19, $20)`,
      [
        id, owner.org_id, purpose, profile ? (purpose === 'document' ? (input.kind ?? 'other') : null) : ownerId, kind, arch ?? null, step ?? null, !!template, encryptField(name, fieldAad.fileName(id)), ext, TYPE_BY_EXT[ext] ?? 'application/octet-stream',
        input.size, CHUNK_SIZE, count, key.wrappedKey, key.keyId, key.noncePrefix, newStoragePrefix(), a.userId, a.apiKeyId,
      ],
    );
    return { fileId: id, chunkSize: CHUNK_SIZE, chunkCount: count, received: [], state: 'uploading' };
  });
}

export function expectedChunkSize(size: number, count: number, idx: number): number {
  return idx < count - 1 ? CHUNK_SIZE : size - (count - 1) * CHUNK_SIZE;
}

/** Stores one sealed chunk. Idempotent: sending the same chunk again replaces it. */
export async function putChunk(ctx: DbCtx, fileId: string, idx: number, body: Buffer, claimedSha: string | undefined, caller?: AuthContext): Promise<{ received: number }> {
  const file = await tx(ctx, async (c) =>
    one<any>(
      c,
      `SELECT f.id, f.org_id, f.case_id, f.claim_id, f.shipment_id, f.purpose, f.size, f.chunk_count, f.wrapped_key, f.nonce_prefix, f.storage_prefix, f.state,
              cs.status AS case_status, cl.status AS claim_status, sh.status AS shipment_status
         FROM files f LEFT JOIN cases cs ON cs.id = f.case_id LEFT JOIN claims cl ON cl.id = f.claim_id LEFT JOIN material_shipments sh ON sh.id = f.shipment_id
        WHERE f.id = $1`,
      [fileId],
    ),
  );
  if (!file) throw notFound('That upload could not be found.');
  if (caller) assertUploadPermission(caller, file.purpose);
  if (file.state !== 'uploading') throw conflict('This upload is already complete.', 'upload_closed');
  if (PROFILE_PURPOSES.includes(file.purpose)) {
    /* profile files have no owner state to check */
  } else if (file.claim_id) {
    if (!CLAIM_UPLOAD_STATES.includes(file.claim_status)) throw conflict('Files can no longer be added to this claim.', 'claim_not_open');
  } else if (file.shipment_id) {
    if (file.shipment_status !== 'in_transit') throw conflict('Documents can only be added while a shipment is on its way.', 'shipment_not_open');
  } else if (!OPEN_CASE_STATES.includes(file.case_status)) throw conflict('Files can only be added while a case is a draft or on hold.', 'case_not_open');
  if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunk_count) throw badRequest('That chunk number is not valid for this file.', 'invalid_chunk');
  if (!Buffer.isBuffer(body) || body.length !== expectedChunkSize(Number(file.size), file.chunk_count, idx)) {
    throw new AppError(422, 'invalid_chunk_size', 'That chunk is not the expected size.');
  }
  if (!claimedSha || !/^[0-9a-fA-F]{64}$/.test(claimedSha)) throw badRequest('Send the SHA-256 of the chunk in the x-chunk-sha256 header.', 'checksum_required');
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== claimedSha.toLowerCase()) throw new AppError(422, 'checksum_mismatch', 'The chunk was damaged in transit. Please send it again.');

  if (idx === 0 && detectExecutable(body.subarray(0, 16))) {
    await deleteFileRow(ctx, fileId);
    throw new AppError(415, 'file_type_not_allowed', 'Programs and scripts cannot be uploaded.');
  }

  const cipher = fileCipherFromRow({ id: file.id, wrapped_key: file.wrapped_key, nonce_prefix: file.nonce_prefix });
  const sealed = sealChunk(cipher, idx, file.chunk_count, body);
  const st = await storage();
  await st.put(chunkKey(file.storage_prefix, idx), sealed);
  const received = await tx(ctx, async (c) => {
    const ok = await c.query(`SELECT 1 FROM files WHERE id = $1 AND state = 'uploading' FOR UPDATE`, [fileId]);
    if (!ok.rowCount) throw conflict('This upload is already complete.', 'upload_closed');
    await c.query(
      `INSERT INTO file_chunks (file_id, org_id, idx, size, sha256) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (file_id, idx) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, created_at = now()`,
      [fileId, file.org_id, idx, body.length, actual],
    );
    const n = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM file_chunks WHERE file_id = $1', [fileId]);
    return n?.n ?? 0;
  });
  return { received };
}

export async function completeUpload(ctx: DbCtx, a: AuthContext, fileId: string, req?: { ip?: string; ua?: string | null }): Promise<{ state: string }> {
  return tx(ctx, async (c) => {
    const pre = await one<any>(c, `SELECT id, org_id, case_id, claim_id, shipment_id, purpose, state FROM files WHERE id = $1`, [fileId]);
    if (!pre) throw notFound('That upload could not be found.');
    assertUploadPermission(a, pre.purpose);
    if (pre.state === 'processing' || pre.state === 'ready') return { state: pre.state === 'ready' ? 'ready' : 'processing' };
    if (pre.state !== 'uploading') throw conflict('This upload cannot be completed.', 'upload_closed');
    await lockOwnerOpen(c, pre); // owner (case, claim or shipment) first, then file: the same lock order everywhere
    const f = await one<any>(c, `SELECT id, org_id, case_id, claim_id, shipment_id, kind, size, chunk_count, state FROM files WHERE id = $1 FOR UPDATE`, [fileId]);
    if (!f || f.state !== 'uploading') throw conflict('This upload cannot be completed.', 'upload_closed');
    const rows = await many<{ idx: number; size: number }>(c, 'SELECT idx, size FROM file_chunks WHERE file_id = $1 ORDER BY idx', [fileId]);
    const have = new Set(rows.map((r) => r.idx));
    const missing: number[] = [];
    for (let i = 0; i < f.chunk_count; i++) if (!have.has(i)) missing.push(i);
    const total = rows.reduce((s, r) => s + r.size, 0);
    if (missing.length || total !== Number(f.size)) {
      throw new AppError(409, 'upload_incomplete', 'Some parts of the file have not arrived yet.', { missing: missing.slice(0, 200) });
    }
    await c.query(`UPDATE files SET state = 'processing', uploaded_at = now(), updated_at = now(), uploader_id = COALESCE(uploader_id, $2), api_key_id = COALESCE(api_key_id, $3) WHERE id = $1`, [fileId, a.userId, a.apiKeyId]);
    await enqueue(c, 'file.process', { fileId }, { orgId: f.org_id });
    if (f.case_id) await recomputeCase(c, f.case_id);
    await audit(c, {
      actorType: a.kind === 'user' ? 'user' : 'api_key',
      actorId: a.userId ?? a.apiKeyId,
      orgId: f.org_id,
      action: 'file.uploaded',
      targetType: 'file',
      targetId: fileId,
      ip: req?.ip,
      userAgent: req?.ua,
      details: { caseId: f.case_id, ...(f.claim_id ? { claimId: f.claim_id } : {}), ...(f.shipment_id ? { shipmentId: f.shipment_id } : {}), kind: f.kind, size: Number(f.size) },
    });
    return { state: 'processing' };
  });
}

// ---------------------------------------------------------------------------
// Reading and changing files
// ---------------------------------------------------------------------------
/** Loads one file row. Pass the caller to apply the K Line production site scope (a file outside it reads as not found). */
export async function getFileRow(c: PoolClient, id: string, scope?: AuthContext): Promise<any> {
  const f = await one<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = $1`, [id]);
  if (!f) throw notFound('That file could not be found.');
  if (scope && siteScope(scope)) {
    // Claim evidence follows the site of the claim's case.
    const cs = f.case_id
      ? await one<any>(c, 'SELECT site_id FROM cases WHERE id = $1', [f.case_id])
      : f.claim_id
        ? await one<any>(c, 'SELECT cs.site_id FROM claims cl JOIN cases cs ON cs.id = cl.case_id WHERE cl.id = $1', [f.claim_id])
        : f.shipment_id
          ? await one<any>(c, 'SELECT site_id FROM material_shipments WHERE id = $1', [f.shipment_id])
          : null;
    assertInScope(scope, cs ?? {});
  }
  return f;
}

export async function updateFileMapping(ctx: DbCtx, id: string, m: { arch?: 'upper' | 'lower' | null; step?: number | null; template?: boolean }): Promise<any> {
  return tx(ctx, async (c) => {
    const f = await getFileRow(c, id);
    if (!f.case_id) throw badRequest('This file does not belong to a case.');
    await lockOpenCase(c, f.case_id);
    await c.query(
      `UPDATE files SET arch = $2, step = $3, is_template = $4, updated_at = now() WHERE id = $1`,
      [id, m.arch === undefined ? f.arch : m.arch, m.step === undefined ? f.step : m.step, m.template === undefined ? f.is_template : m.template],
    );
    await recomputeCase(c, f.case_id);
    return getFileRow(c, id);
  });
}

async function deleteFileRow(ctx: DbCtx, id: string): Promise<void> {
  const prefix = await tx(ctx, async (c) => {
    const f = await one<any>(c, 'SELECT id, case_id, storage_prefix FROM files WHERE id = $1', [id]);
    if (!f) return null;
    if (f.case_id) await c.query('SELECT 1 FROM cases WHERE id = $1 FOR UPDATE', [f.case_id]);
    await c.query('DELETE FROM files WHERE id = $1', [id]);
    if (f.case_id) await recomputeCase(c, f.case_id);
    return f.storage_prefix as string | null;
  });
  if (prefix) await removeStored([prefix]);
}

/** Deletes a file (draft or on hold cases, open claims, shipments on their way) and its stored chunks. */
export async function deleteFile(ctx: DbCtx, a: AuthContext, id: string, req?: { ip?: string; ua?: string | null }): Promise<void> {
  const prefix = await tx(ctx, async (c) => {
    const f = await getFileRow(c, id);
    if (!f.case_id && !f.claim_id && !f.shipment_id) throw badRequest('This file does not belong to a case.');
    assertUploadPermission(a, f.purpose);
    await lockOwnerOpen(c, f);
    await c.query('DELETE FROM files WHERE id = $1', [id]);
    if (f.case_id) await recomputeCase(c, f.case_id);
    await audit(c, {
      actorType: a.kind === 'user' ? 'user' : 'api_key', actorId: a.userId ?? a.apiKeyId, orgId: f.org_id, action: 'file.deleted', targetType: 'file', targetId: id,
      ip: req?.ip, userAgent: req?.ua, details: { caseId: f.case_id, ...(f.claim_id ? { claimId: f.claim_id } : {}), ...(f.shipment_id ? { shipmentId: f.shipment_id } : {}), kind: f.kind },
    });
    return f.storage_prefix as string | null;
  });
  if (prefix) await removeStored([prefix]);
}

/** Best effort removal of stored chunks after the database rows are gone. */
export async function removeStored(prefixes: string[]): Promise<void> {
  const st = await storage();
  for (const p of prefixes) {
    try {
      await st.deletePrefix(p + '/');
    } catch {
      /* the encrypted objects are unreachable without the row's key; a sweep can remove leftovers */
    }
  }
}

// ---------------------------------------------------------------------------
// Worker: scan, validate, record
// ---------------------------------------------------------------------------
async function* hashing(src: AsyncIterable<Buffer>, h: ReturnType<typeof createHash>, counter: { n: number }): AsyncGenerator<Buffer> {
  for await (const c of src) {
    h.update(c);
    counter.n += c.length;
    yield c;
  }
}

interface Outcome {
  state: 'ready' | 'rejected';
  scan: 'clean' | 'infected' | 'error' | 'skipped';
  result: ValidationResult;
  sha256?: string;
  signature?: string;
}

const reject = (scan: Outcome['scan'], code: string, message: string): Outcome => ({ state: 'rejected', scan, result: { errors: [{ code, message }], warnings: [], meta: {} } });

export async function processFileJob(job: Pick<JobRow, 'payload' | 'attempts' | 'max_attempts'>): Promise<void> {
  const fileId = String(job.payload?.fileId ?? '');
  const row = await tx(SYSTEM, (c) => one<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = $1`, [fileId]));
  if (!row || row.state !== 'processing') return;

  let outcome: Outcome;
  try {
    const h = createHash('sha256');
    const counter = { n: 0 };
    const scanned = await scanner().scan(hashing(fileContentStream(row), h, counter));
    if (scanned.status === 'error') {
      if (job.attempts < job.max_attempts) throw new Error(`scanner unavailable: ${scanned.reason ?? 'error'}`);
      outcome = reject('error', 'scan_failed', 'The file could not be scanned for malware, so it was not accepted.');
    } else if (scanned.status === 'infected') {
      outcome = { ...reject('infected', 'infected', 'A malware scan found a threat in this file.'), signature: scanned.signature };
    } else {
      let sha: string;
      if (counter.n === Number(row.size)) sha = h.digest('hex');
      else {
        const h2 = createHash('sha256');
        let n = 0;
        for await (const c of fileContentStream(row)) {
          h2.update(c);
          n += c.length;
        }
        counter.n = n;
        sha = h2.digest('hex');
      }
      if (counter.n !== Number(row.size)) {
        outcome = reject(scanned.status, 'size_mismatch', 'The stored file is not the size it should be.');
      } else {
        const result = await validateContent(row.kind, row.ext ?? '', fileSourceFromRow(row));
        outcome = { state: result.errors.length ? 'rejected' : 'ready', scan: scanned.status, result, sha256: sha };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    if (/^scanner unavailable/.test(msg)) throw e;
    // Decryption failures and other integrity problems reject the file and never leak details.
    if (job.attempts < job.max_attempts && /ECONN|ETIMEDOUT|EAI_AGAIN|S3|network/i.test(msg)) throw e;
    outcome = reject('error', 'processing_failed', 'The file could not be processed.');
  }

  await tx(SYSTEM, async (c) => {
    if (row.case_id) await c.query('SELECT 1 FROM cases WHERE id = $1 FOR UPDATE', [row.case_id]);
    const upd = await c.query(
      `UPDATE files SET state = $2, scan_status = $3, validation = $4::jsonb, meta = $5::jsonb, processed_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'processing'`,
      [
        fileId,
        outcome.state,
        outcome.scan,
        JSON.stringify({ errors: outcome.result.errors, warnings: outcome.result.warnings }),
        JSON.stringify({ ...outcome.result.meta, ...(outcome.sha256 ? { sha256: outcome.sha256 } : {}), ...(outcome.signature ? { scanSignature: outcome.signature } : {}) }),
      ],
    );
    if (!upd.rowCount) return;
    if (row.case_id) {
      await recomputeCase(c, row.case_id);
      await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) VALUES ($1, $2, 'files_checked', 'system', $3::jsonb)`, [
        row.org_id,
        row.case_id,
        JSON.stringify({ fileId, state: outcome.state, errors: outcome.result.errors.length, warnings: outcome.result.warnings.length }),
      ]);
    }
    if (outcome.scan === 'infected') {
      await audit(c, { actorType: 'system', orgId: row.org_id, action: 'file.infected', targetType: 'file', targetId: fileId, details: { caseId: row.case_id, ...(row.claim_id ? { claimId: row.claim_id } : {}), ...(row.shipment_id ? { shipmentId: row.shipment_id } : {}) } });
    }
  });
  // Rejected files keep their encrypted chunks so the partner can see why; infected content is removed at once.
  if (outcome.scan === 'infected') await removeStored([row.storage_prefix]);
}

registerJob('file.process', processFileJob);

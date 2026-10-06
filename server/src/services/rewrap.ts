import { audit } from '../audit';
import { config } from '../config';
import { SYSTEM, tx, type PoolClient } from '../db';
import { fileCipherFromRow, openChunk, rewrapDataKey, unwrapDataKey, wrappedKeyId } from '../crypto/envelope';
import { blindIndex, blindIndexes, decryptField, encryptField, fieldAad, fieldKeyId } from '../crypto/keys';
import { chunkKey, storage } from '../storage';

/**
 * Key rotation: moves everything that is sealed with an older master key to the active one (ACTIVE_KEY_ID).
 *
 *  - File data keys (files.wrapped_key, files.key_id). Child rows of rework and replacement cases share the stored bytes of the
 *    parent through cipher_file_id, and the wrapped key is bound to that id, so the cipher file id is the AAD.
 *  - Field tokens (`f1.`): patient names, case instructions, original file names, TOTP secrets, webhook secrets, portal API keys and the secrets of the portal webhook receivers.
 *  - Legacy plaintext case instructions (a value that is not a field token) are encrypted.
 *  - Blind indexes are keyed by BLIND_INDEX_KEY_ID, not by the active key. They are recomputed only when that id was changed
 *    (detected from a sample) or when `blind_index` is asked for explicitly.
 *
 * Every batch is one transaction under the SYSTEM context and selects only rows that still need work, in id order, so a run is
 * idempotent and can be stopped and started again. Nothing here prints or logs a secret or a plaintext value.
 */

export const REWRAP_KINDS = ['files', 'patient_names', 'instructions', 'file_names', 'totp', 'webhooks', 'portal_keys', 'blind_index'] as const;
export type RewrapKind = (typeof REWRAP_KINDS)[number];

export interface KindReport {
  kind: RewrapKind;
  /** Rows that already used the active key when the run started. */
  alreadyCurrent: number;
  /** Rows re-wrapped (or, in a dry run, that would be). */
  rewrapped: number;
  /** Plaintext values that were encrypted. */
  legacyEncrypted: number;
  /** Rows that could not be processed (their id is never printed in bulk; the first few are listed). */
  failed: number;
  failedIds: string[];
  /** Failed rows grouped by the key id they still use. A key id missing from MASTER_KEYS shows up here. */
  failedByKey: Record<string, number>;
}

export interface VerifyReport {
  kind: RewrapKind;
  sampled: number;
  ok: number;
  failed: number;
  /** Files whose first chunk could not be checked because the stored object is not there. */
  skipped: number;
  /** Rows of this kind that still use an older key after the run. */
  stillOld: number;
}

export interface RewrapReport {
  activeKeyId: string;
  dryRun: boolean;
  kinds: KindReport[];
  verify: VerifyReport[];
  blindIndexChanged: boolean;
  ok: boolean;
}

export interface RewrapOptions {
  dryRun?: boolean;
  only?: RewrapKind[];
  batchSize?: number;
  sampleSize?: number;
  log?: (line: string) => void;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

interface FieldSpec {
  kind: RewrapKind;
  table: string;
  column: string;
  aad: (id: string) => string;
  /** Values that are not field tokens are plaintext from before encryption existed. */
  legacyPlaintext?: boolean;
  /** Primary key column the AAD is built from. Default `id`. */
  idCol?: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { kind: 'patient_names', table: 'cases', column: 'patient_enc', aad: fieldAad.casePatient },
  { kind: 'patient_names', table: 'cases', column: 'patient_first_enc', aad: fieldAad.casePatientFirst },
  { kind: 'patient_names', table: 'cases', column: 'patient_last_enc', aad: fieldAad.casePatientLast },
  { kind: 'instructions', table: 'cases', column: 'notes_enc', aad: fieldAad.caseNotes, legacyPlaintext: true },
  { kind: 'file_names', table: 'files', column: 'name_enc', aad: fieldAad.fileName },
  { kind: 'totp', table: 'users', column: 'totp_secret_enc', aad: fieldAad.userTotp },
  { kind: 'webhooks', table: 'webhooks', column: 'secret_enc', aad: fieldAad.webhook },
];

/** Secret tokens of the portal webhook receivers (one per organisation, AAD org|<org id>|portal_hook). Covered by the `portal_keys` kind. */
const PORTAL_HOOK_SPEC: FieldSpec = { kind: 'portal_keys', table: 'portal_hooks', column: 'secret_enc', aad: fieldAad.portalHook, idCol: 'org_id' };

const newReport = (kind: RewrapKind): KindReport => ({ kind, alreadyCurrent: 0, rewrapped: 0, legacyEncrypted: 0, failed: 0, failedIds: [], failedByKey: {} });

function noteFailure(r: KindReport, id: string, keyId: string): void {
  r.failed++;
  if (r.failedIds.length < 10) r.failedIds.push(id);
  r.failedByKey[keyId] = (r.failedByKey[keyId] ?? 0) + 1;
}

const looksLikeToken = (v: string) => v.startsWith('f1.') && v.split('.').length === 5;

/** Key id a stored value currently uses, without decrypting. */
function tokenKeyId(v: string): string {
  try {
    return fieldKeyId(v);
  } catch {
    return 'unreadable';
  }
}

async function countCurrent(c: PoolClient, table: string, where: string, prefix: string): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [prefix]);
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Field tokens
// ---------------------------------------------------------------------------
async function rewrapFieldSpec(spec: FieldSpec, rep: KindReport, o: Required<Pick<RewrapOptions, 'dryRun' | 'batchSize'>> & { log: (l: string) => void }): Promise<void> {
  const prefix = `f1.${config.activeKeyId}.`;
  const label = `${spec.table}.${spec.column}`;
  const idc = spec.idCol ?? 'id';
  rep.alreadyCurrent += await tx(SYSTEM, (c) => countCurrent(c, spec.table, `${spec.column} IS NOT NULL AND starts_with(${spec.column}, $1)`, prefix));
  let last = ZERO_UUID;
  let done = 0;
  for (;;) {
    const n = await tx(SYSTEM, async (c) => {
      const rows = (
        await c.query(
          `SELECT ${idc} AS id, ${spec.column} AS v FROM ${spec.table}
            WHERE ${spec.column} IS NOT NULL AND NOT starts_with(${spec.column}, $1) AND ${idc} > $2
            ORDER BY ${idc} LIMIT $3 FOR UPDATE`,
          [prefix, last, o.batchSize],
        )
      ).rows as { id: string; v: string }[];
      for (const row of rows) {
        last = row.id;
        const aad = spec.aad(row.id);
        let next: string;
        try {
          if (spec.legacyPlaintext && !looksLikeToken(row.v)) {
            next = encryptField(row.v, aad);
            rep.legacyEncrypted++;
          } else {
            next = encryptField(decryptField(row.v, aad), aad);
            rep.rewrapped++;
          }
        } catch {
          noteFailure(rep, row.id, tokenKeyId(row.v));
          continue;
        }
        if (!o.dryRun) await c.query(`UPDATE ${spec.table} SET ${spec.column} = $2 WHERE ${idc} = $1`, [row.id, next]);
      }
      return rows.length;
    });
    if (n === 0) break;
    done += n;
    o.log(`  ${label}: ${done} row(s) looked at`);
    if (n < o.batchSize) break;
  }
}

// ---------------------------------------------------------------------------
// File data keys
// ---------------------------------------------------------------------------
async function rewrapFiles(rep: KindReport, o: { dryRun: boolean; batchSize: number; log: (l: string) => void }): Promise<void> {
  const active = config.activeKeyId;
  const prefix = `w1.${active}.`;
  const stale = `wrapped_key IS NOT NULL AND (NOT starts_with(wrapped_key, $1) OR key_id IS DISTINCT FROM $4)`;
  rep.alreadyCurrent += await tx(SYSTEM, async (c) => (await c.query(`SELECT count(*)::int AS n FROM files WHERE wrapped_key IS NOT NULL AND starts_with(wrapped_key, $1) AND key_id = $2`, [prefix, active])).rows[0].n);
  let last = ZERO_UUID;
  let done = 0;
  for (;;) {
    const n = await tx(SYSTEM, async (c) => {
      const rows = (
        await c.query(
          `SELECT id, cipher_file_id, wrapped_key FROM files WHERE ${stale} AND id > $2 ORDER BY id LIMIT $3 FOR UPDATE`,
          [prefix, last, o.batchSize, active],
        )
      ).rows as { id: string; cipher_file_id: string | null; wrapped_key: string }[];
      for (const row of rows) {
        last = row.id;
        let next: string;
        try {
          // The data key is bound to the file id that owns the stored bytes.
          next = rewrapDataKey(row.wrapped_key, row.cipher_file_id ?? row.id, active);
        } catch {
          let keyId = 'unreadable';
          try {
            keyId = wrappedKeyId(row.wrapped_key);
          } catch {
            /* malformed */
          }
          noteFailure(rep, row.id, keyId);
          continue;
        }
        rep.rewrapped++;
        if (!o.dryRun) await c.query(`UPDATE files SET wrapped_key = $2, key_id = $3 WHERE id = $1`, [row.id, next, active]);
      }
      return rows.length;
    });
    if (n === 0) break;
    done += n;
    o.log(`  files.wrapped_key: ${done} row(s) looked at`);
    if (n < o.batchSize) break;
  }
}

// ---------------------------------------------------------------------------
// Portal API keys in organisation settings
// ---------------------------------------------------------------------------
async function rewrapPortalKeys(rep: KindReport, o: { dryRun: boolean; batchSize: number; log: (l: string) => void }): Promise<void> {
  const prefix = `f1.${config.activeKeyId}.`;
  const col = `settings->'portal_api'->>'apiKeyEnc'`;
  rep.alreadyCurrent += await tx(SYSTEM, (c) => countCurrent(c, 'organizations', `${col} IS NOT NULL AND starts_with(${col}, $1)`, prefix));
  let last = ZERO_UUID;
  for (;;) {
    const n = await tx(SYSTEM, async (c) => {
      const rows = (
        await c.query(`SELECT id, ${col} AS v FROM organizations WHERE ${col} IS NOT NULL AND NOT starts_with(${col}, $1) AND id > $2 ORDER BY id LIMIT $3 FOR UPDATE`, [prefix, last, o.batchSize])
      ).rows as { id: string; v: string }[];
      for (const row of rows) {
        last = row.id;
        const aad = fieldAad.portalKey(row.id);
        let next: string;
        try {
          next = encryptField(decryptField(row.v, aad), aad);
        } catch {
          noteFailure(rep, row.id, tokenKeyId(row.v));
          continue;
        }
        rep.rewrapped++;
        if (!o.dryRun) await c.query(`UPDATE organizations SET settings = jsonb_set(settings, '{portal_api,apiKeyEnc}', to_jsonb($2::text), false) WHERE id = $1`, [row.id, next]);
      }
      return rows.length;
    });
    if (n === 0) break;
    o.log(`  organizations (portal API keys): batch of ${n} looked at`);
    if (n < o.batchSize) break;
  }
}

// ---------------------------------------------------------------------------
// Blind indexes
// ---------------------------------------------------------------------------
interface CaseNameRow {
  id: string;
  parent_id: string | null;
  patient_enc: string | null;
  patient_first_enc: string | null;
  patient_last_enc: string | null;
  patient_bidx: string | null;
  patient_bidxs: string[] | null;
}

/** Blind indexes the case should carry now. Both name orders when the first and last names are known. */
async function wantedIndexes(c: PoolClient, row: CaseNameRow, depth = 0): Promise<{ bidx: string; bidxs: string[] } | null> {
  if (row.patient_first_enc && row.patient_last_enc) {
    const bis = blindIndexes(decryptField(row.patient_first_enc, fieldAad.casePatientFirst(row.id)), decryptField(row.patient_last_enc, fieldAad.casePatientLast(row.id)));
    return { bidx: bis[0]!, bidxs: bis };
  }
  if (!row.patient_enc) return null;
  // A child case (rework or replacement) copies its parent's indexes, which cover both name orders. Follow the parent for the same result.
  if ((row.patient_bidxs?.length ?? 0) > 1 && row.parent_id && depth < 6) {
    const p = (await c.query(`SELECT id, parent_id, patient_enc, patient_first_enc, patient_last_enc, patient_bidx, patient_bidxs FROM cases WHERE id = $1`, [row.parent_id])).rows[0] as CaseNameRow | undefined;
    const fromParent = p ? await wantedIndexes(c, p, depth + 1) : null;
    if (fromParent) return fromParent;
  }
  const bi = blindIndex(decryptField(row.patient_enc, fieldAad.casePatient(row.id)));
  return { bidx: bi, bidxs: [bi] };
}

/** True when the stored blind indexes of a few cases do not match the current BLIND_INDEX_KEY_ID. */
export async function blindIndexKeyChanged(sample = 10): Promise<boolean> {
  return tx(SYSTEM, async (c) => {
    const rows = (
      await c.query(
        `SELECT id, parent_id, patient_enc, patient_first_enc, patient_last_enc, patient_bidx, patient_bidxs FROM cases
          WHERE patient_bidx IS NOT NULL AND (patient_enc IS NOT NULL OR patient_first_enc IS NOT NULL) ORDER BY random() LIMIT $1`,
        [sample],
      )
    ).rows as CaseNameRow[];
    for (const row of rows) {
      try {
        const w = await wantedIndexes(c, row);
        if (w && w.bidx !== row.patient_bidx) return true;
      } catch {
        /* a value that cannot be read is reported by the field pass */
      }
    }
    return false;
  });
}

async function reindexBlind(rep: KindReport, o: { dryRun: boolean; batchSize: number; log: (l: string) => void }): Promise<void> {
  let last = ZERO_UUID;
  let done = 0;
  for (;;) {
    const n = await tx(SYSTEM, async (c) => {
      const rows = (
        await c.query(
          `SELECT id, parent_id, patient_enc, patient_first_enc, patient_last_enc, patient_bidx, patient_bidxs FROM cases
            WHERE (patient_enc IS NOT NULL OR patient_first_enc IS NOT NULL) AND id > $1 ORDER BY id LIMIT $2 FOR UPDATE`,
          [last, o.batchSize],
        )
      ).rows as CaseNameRow[];
      for (const row of rows) {
        last = row.id;
        try {
          const w = await wantedIndexes(c, row);
          if (!w) continue;
          const same = w.bidx === row.patient_bidx && JSON.stringify(w.bidxs) === JSON.stringify(row.patient_bidxs ?? []);
          if (same) {
            rep.alreadyCurrent++;
            continue;
          }
          rep.rewrapped++;
          if (!o.dryRun) await c.query(`UPDATE cases SET patient_bidx = $2, patient_bidxs = $3 WHERE id = $1`, [row.id, w.bidx, w.bidxs]);
        } catch {
          noteFailure(rep, row.id, 'blind_index');
        }
      }
      return rows.length;
    });
    if (n === 0) break;
    done += n;
    o.log(`  cases (blind indexes): ${done} row(s) looked at`);
    if (n < o.batchSize) break;
  }
}

// ---------------------------------------------------------------------------
// Verification: decrypt a sample of each kind using only the active key
// ---------------------------------------------------------------------------
async function verifyKind(kind: RewrapKind, sampleSize: number): Promise<VerifyReport> {
  const v: VerifyReport = { kind, sampled: 0, ok: 0, failed: 0, skipped: 0, stillOld: 0 };
  const active = config.activeKeyId;
  const fieldPrefix = `f1.${active}.`;
  const checkToken = (token: string, aad: string): boolean => {
    try {
      // The value must name the active key, so decrypting it cannot have used any other.
      if (fieldKeyId(token) !== active) return false;
      decryptField(token, aad);
      return true;
    } catch {
      return false;
    }
  };

  if (kind === 'files') {
    const { rows, old } = await tx(SYSTEM, async (c) => ({
      rows: (
        await c.query(
          `SELECT id, cipher_file_id, wrapped_key, nonce_prefix, storage_prefix, chunk_count, state FROM files
            WHERE wrapped_key IS NOT NULL AND starts_with(wrapped_key, $1) AND key_id = $2 ORDER BY random() LIMIT $3`,
          [`w1.${active}.`, active, sampleSize],
        )
      ).rows,
      old: (await c.query(`SELECT count(*)::int AS n FROM files WHERE wrapped_key IS NOT NULL AND (NOT starts_with(wrapped_key, $1) OR key_id IS DISTINCT FROM $2)`, [`w1.${active}.`, active])).rows[0].n as number,
    }));
    v.stillOld = old;
    const st = await storage();
    for (const r of rows) {
      v.sampled++;
      try {
        const cipherId = r.cipher_file_id ?? r.id;
        unwrapDataKey(r.wrapped_key, cipherId);
        if (r.state === 'ready' && r.storage_prefix && r.chunk_count > 0) {
          const key = chunkKey(r.storage_prefix, 0);
          if (await st.exists(key)) {
            openChunk(fileCipherFromRow({ id: cipherId, wrapped_key: r.wrapped_key, nonce_prefix: r.nonce_prefix }), 0, r.chunk_count, await st.getBuffer(key));
          } else {
            v.skipped++;
          }
        }
        v.ok++;
      } catch {
        v.failed++;
      }
    }
    return v;
  }

  if (kind === 'portal_keys') {
    const col = `settings->'portal_api'->>'apiKeyEnc'`;
    const { rows, old } = await tx(SYSTEM, async (c) => ({
      rows: (await c.query(`SELECT id, ${col} AS v FROM organizations WHERE ${col} IS NOT NULL AND starts_with(${col}, $1) ORDER BY random() LIMIT $2`, [fieldPrefix, sampleSize])).rows,
      old: (await c.query(`SELECT count(*)::int AS n FROM organizations WHERE ${col} IS NOT NULL AND NOT starts_with(${col}, $1)`, [fieldPrefix])).rows[0].n as number,
    }));
    v.stillOld = old;
    for (const r of rows) {
      v.sampled++;
      if (checkToken(r.v, fieldAad.portalKey(r.id))) v.ok++;
      else v.failed++;
    }
    const hooks = await tx(SYSTEM, async (c) => ({
      rows: (await c.query(`SELECT org_id AS id, secret_enc AS v FROM portal_hooks WHERE starts_with(secret_enc, $1) ORDER BY random() LIMIT $2`, [fieldPrefix, sampleSize])).rows,
      old: (await c.query(`SELECT count(*)::int AS n FROM portal_hooks WHERE NOT starts_with(secret_enc, $1)`, [fieldPrefix])).rows[0].n as number,
    }));
    v.stillOld += hooks.old;
    for (const r of hooks.rows) {
      v.sampled++;
      if (checkToken(r.v, fieldAad.portalHook(r.id))) v.ok++;
      else v.failed++;
    }
    return v;
  }

  if (kind === 'blind_index') {
    const rows = await tx(SYSTEM, async (c) => {
      const s = (
        await c.query(
          `SELECT id, parent_id, patient_enc, patient_first_enc, patient_last_enc, patient_bidx, patient_bidxs FROM cases
            WHERE patient_bidx IS NOT NULL AND (patient_enc IS NOT NULL OR patient_first_enc IS NOT NULL) ORDER BY random() LIMIT $1`,
          [sampleSize],
        )
      ).rows as CaseNameRow[];
      const out: { ok: boolean }[] = [];
      for (const row of s) {
        try {
          const w = await wantedIndexes(c, row);
          out.push({ ok: !!w && w.bidx === row.patient_bidx });
        } catch {
          out.push({ ok: false });
        }
      }
      return out;
    });
    for (const r of rows) {
      v.sampled++;
      if (r.ok) v.ok++;
      else v.failed++;
    }
    return v;
  }

  for (const spec of FIELD_SPECS.filter((s) => s.kind === kind)) {
    const { rows, old } = await tx(SYSTEM, async (c) => ({
      rows: (await c.query(`SELECT ${spec.idCol ?? 'id'} AS id, ${spec.column} AS v FROM ${spec.table} WHERE ${spec.column} IS NOT NULL AND starts_with(${spec.column}, $1) ORDER BY random() LIMIT $2`, [fieldPrefix, sampleSize])).rows,
      old: (await c.query(`SELECT count(*)::int AS n FROM ${spec.table} WHERE ${spec.column} IS NOT NULL AND NOT starts_with(${spec.column}, $1)`, [fieldPrefix])).rows[0].n as number,
    }));
    v.stillOld += old;
    for (const r of rows) {
      v.sampled++;
      if (checkToken(r.v, spec.aad(r.id))) v.ok++;
      else v.failed++;
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
export async function rewrapAll(opts: RewrapOptions = {}): Promise<RewrapReport> {
  const log = opts.log ?? (() => {});
  const dryRun = !!opts.dryRun;
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 200, 2000));
  const sampleSize = Math.max(1, opts.sampleSize ?? 20);
  const o = { dryRun, batchSize, log };
  const wanted = new Set<RewrapKind>(opts.only?.length ? opts.only : REWRAP_KINDS.filter((k) => k !== 'blind_index'));

  // The blind index pass runs on request, or when the sample shows BLIND_INDEX_KEY_ID was changed.
  let blindChanged = false;
  if (!opts.only?.length || opts.only.includes('blind_index')) {
    blindChanged = opts.only?.includes('blind_index') ? true : await blindIndexKeyChanged();
    if (blindChanged) wanted.add('blind_index');
  }

  log(`${dryRun ? 'Dry run. ' : ''}Active master key: ${config.activeKeyId}. Kinds: ${[...wanted].join(', ')}.`);
  const kinds: KindReport[] = [];
  for (const kind of REWRAP_KINDS) {
    if (!wanted.has(kind)) continue;
    const rep = newReport(kind);
    log(`${kind}`);
    if (kind === 'files') await rewrapFiles(rep, o);
    else if (kind === 'portal_keys') {
      await rewrapPortalKeys(rep, o);
      await rewrapFieldSpec(PORTAL_HOOK_SPEC, rep, o);
    }
    else if (kind === 'blind_index') await reindexBlind(rep, o);
    else for (const spec of FIELD_SPECS.filter((s) => s.kind === kind)) await rewrapFieldSpec(spec, rep, o);
    kinds.push(rep);
    log(`  ${kind}: ${rep.rewrapped} ${dryRun ? 'to re-wrap' : 're-wrapped'}, ${rep.legacyEncrypted} plaintext ${dryRun ? 'to encrypt' : 'encrypted'}, ${rep.alreadyCurrent} already current, ${rep.failed} failed.`);
  }

  const verify: VerifyReport[] = [];
  if (!dryRun) {
    log('Verifying a sample of each kind with the active key only...');
    for (const k of kinds) verify.push(await verifyKind(k.kind, sampleSize));
    await tx(SYSTEM, (c) =>
      audit(c, {
        actorType: 'system',
        action: 'system.keys_rewrapped',
        details: {
          activeKeyId: config.activeKeyId,
          rewrapped: Object.fromEntries(kinds.map((k) => [k.kind, k.rewrapped])),
          legacyEncrypted: kinds.reduce((a, k) => a + k.legacyEncrypted, 0),
          failed: kinds.reduce((a, k) => a + k.failed, 0),
        },
      }),
    );
  }
  const ok = kinds.every((k) => k.failed === 0) && verify.every((v) => v.failed === 0 && v.stillOld === 0);
  return { activeKeyId: config.activeKeyId, dryRun, kinds, verify, blindIndexChanged: blindChanged, ok };
}

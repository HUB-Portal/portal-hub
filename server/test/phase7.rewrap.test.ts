import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { clearDerivedKeys, decryptField, encryptField, fieldAad } from '../src/crypto/keys';
import { REWRAP_KINDS, rewrapAll } from '../src/services/rewrap';
import { Client, cubeStl, orgIdOf, trimLine } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let app: FastifyInstance;
let up: Client;
let klAdmin: Client;
let acmeId: string;
const keyBackup: Record<string, Buffer> = {};

const ids = {
  caseId: '',
  childId: '',
  directId: '',
  legacyId: '',
  webhookId: '',
  fileIds: [] as string[],
};
const data = { u1: cubeStl(50, 'model one'), pts: trimLine(), l1: cubeStl(40, 'model low') };
const NAME = 'Sofia Lindqvist';
const NOTES = 'Keep the attachments on the upper canines.';

/** Every encrypted value in the database, as one comparable string. */
async function snapshot(): Promise<string> {
  const parts = [
    await q(`SELECT id, patient_enc, patient_first_enc, patient_last_enc, notes_enc, patient_bidx FROM cases ORDER BY id`),
    await q(`SELECT id, name_enc, wrapped_key, key_id FROM files ORDER BY id`),
    await q(`SELECT id, totp_secret_enc FROM users ORDER BY id`),
    await q(`SELECT id, secret_enc FROM webhooks ORDER BY id`),
    await q(`SELECT id, settings->'portal_api' AS p FROM organizations ORDER BY id`),
    await q(`SELECT org_id, hook_id, secret_enc FROM portal_hooks ORDER BY org_id`),
  ];
  return JSON.stringify(parts);
}

/** How many stored values still name the given key (files use w1, fields f1). */
async function countUsing(keyId: string): Promise<number> {
  const like = (col: string, pre: string) => `(${col} IS NOT NULL AND starts_with(${col}, '${pre}.${keyId}.'))`;
  const r = await q(
    `SELECT
       (SELECT count(*) FROM files WHERE ${like('wrapped_key', 'w1')} OR key_id = '${keyId}' OR ${like('name_enc', 'f1')})::int AS files,
       (SELECT count(*) FROM cases WHERE ${like('patient_enc', 'f1')} OR ${like('patient_first_enc', 'f1')} OR ${like('patient_last_enc', 'f1')} OR ${like('notes_enc', 'f1')})::int AS cases,
       (SELECT count(*) FROM users WHERE ${like('totp_secret_enc', 'f1')})::int AS users,
       (SELECT count(*) FROM webhooks WHERE ${like('secret_enc', 'f1')})::int AS webhooks,
       (SELECT count(*) FROM organizations WHERE starts_with(COALESCE(settings->'portal_api'->>'apiKeyEnc', ''), 'f1.${keyId}.'))::int AS orgs,
       (SELECT count(*) FROM portal_hooks WHERE ${like('secret_enc', 'f1')})::int AS hooks`,
  );
  const x = r[0];
  return x.files + x.cases + x.users + x.webhooks + x.orgs + x.hooks;
}

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  up = await new Client(app).full('upload@acme.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');

  // A standard case with a name, instructions and three files, shipped, plus a replacement child that shares the stored bytes.
  const c = await up.call('POST', '/api/cases', { caseId: 'ROT-1001', patientName: NAME, instructions: NOTES });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  ids.caseId = c.json.case.id;
  const f1 = await up.uploadFile(ids.caseId, 'U01.stl', data.u1);
  const f2 = await up.uploadFile(ids.caseId, 'U01.pts', data.pts);
  const f3 = await up.uploadFile(ids.caseId, 'L01.stl', data.l1);
  ids.fileIds = [f1.fileId, f2.fileId, f3.fileId];
  const sub = await up.call('POST', `/api/cases/${ids.caseId}/submit`, { acknowledgeWarnings: true });
  expect(sub.status, JSON.stringify(sub.json)).toBe(200);
  const shipped = await klAdmin.call('POST', `/api/cases/${ids.caseId}/stage`, { stage: 'shipped', carrier: 'DHL', trackingNumber: 'TRK-ROT-1', alignersShipped: 2 });
  expect(shipped.status, JSON.stringify(shipped.json)).toBe(200);
  const rep = await up.call('POST', `/api/cases/${ids.caseId}/replacement`, { items: [{ arch: 'upper', step: 1 }] });
  expect(rep.status, JSON.stringify(rep.json)).toBe(201);
  ids.childId = rep.json.case.id;

  // A direct manufacturing case (first and last name fields), a case with legacy plaintext instructions, a webhook and portal credentials.
  ids.directId = randomUUID();
  await q(
    `INSERT INTO cases (id, org_id, ref, partner_case_id, manufacturing_mode, patient_enc, patient_first_enc, patient_last_enc, patient_bidx, patient_bidxs, status)
     VALUES ($1, $2, 'ACME-900001', '77001', 'direct', $3, $4, $5, $6, $7, 'draft')`,
    [
      ids.directId, acmeId,
      encryptField('Noor Haddad', fieldAad.casePatient(ids.directId)), encryptField('Noor', fieldAad.casePatientFirst(ids.directId)), encryptField('Haddad', fieldAad.casePatientLast(ids.directId)),
      (await import('../src/crypto/keys')).blindIndexes('Noor', 'Haddad')[0], (await import('../src/crypto/keys')).blindIndexes('Noor', 'Haddad'),
    ],
  );
  ids.legacyId = randomUUID();
  await q(`INSERT INTO cases (id, org_id, ref, partner_case_id, notes_enc, status) VALUES ($1, $2, 'ACME-900002', 'LEG-1', $3, 'draft')`, [ids.legacyId, acmeId, 'Old plaintext instructions from before encryption']);
  ids.webhookId = randomUUID();
  await q(`INSERT INTO webhooks (id, org_id, url, events, secret_enc) VALUES ($1, $2, 'https://hooks.example.test/x', ARRAY['case.ready'], $3)`, [ids.webhookId, acmeId, encryptField('whsec_test_secret_value', fieldAad.webhook(ids.webhookId))]);
  // The secret of a portal webhook receiver (AAD org|<org id>|portal_hook).
  await q(`INSERT INTO portal_hooks (org_id, hook_id, secret_enc) VALUES ($1, $2, $3)`, [acmeId, 'rotation-test-hook-id-0123456789', encryptField('whsec_hook_secret_value', fieldAad.portalHook(acmeId))]);
  await q(`UPDATE organizations SET settings = jsonb_set(settings, '{portal_api}', $2::jsonb, true) WHERE id = $1`, [
    acmeId, JSON.stringify({ baseUrl: 'https://portal.example.test/api/v2', userUuid: randomUUID(), apiKeyEnc: encryptField('portal-key-value', fieldAad.portalKey(acmeId)) }),
  ]);
});

afterAll(async () => {
  // put the test configuration back for anything that runs after
  for (const [k, v] of Object.entries(keyBackup)) config.masterKeys[k] = v;
  config.activeKeyId = 'k1';
  clearDerivedKeys();
  await app.close();
  await closePools();
});

describe('key rotation', () => {
  it('starts with everything under the old key and the replacement sharing the parent bytes', async () => {
    expect(await countUsing('k1')).toBeGreaterThan(10);
    expect(await countUsing('k2')).toBe(0);
    const child = await q(`SELECT cipher_file_id, wrapped_key, id FROM files WHERE case_id = $1`, [ids.childId]);
    expect(child.length).toBeGreaterThan(0);
    expect(child.every((r) => r.cipher_file_id && r.cipher_file_id !== r.id)).toBe(true);
  });

  it('a dry run reports the work and changes nothing', async () => {
    config.activeKeyId = 'k2';
    const before = await snapshot();
    const lines: string[] = [];
    const r = await rewrapAll({ dryRun: true, log: (l) => lines.push(l) });
    expect(r.dryRun).toBe(true);
    expect(r.verify).toEqual([]);
    const by = Object.fromEntries(r.kinds.map((k) => [k.kind, k]));
    expect(by.files!.rewrapped).toBeGreaterThanOrEqual(6); // three parent files and their shared copies in the replacement
    expect(by.patient_names!.rewrapped).toBeGreaterThanOrEqual(4);
    expect(by.instructions!.legacyEncrypted).toBe(1);
    expect(by.webhooks!.rewrapped).toBe(1);
    expect(by.portal_keys!.rewrapped).toBe(2); // the portal API key and the portal webhook receiver secret
    expect(by.totp!.rewrapped).toBeGreaterThan(5);
    expect(by.file_names!.rewrapped).toBeGreaterThanOrEqual(6);
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify(lines)).not.toContain(NAME);
  });

  it('re-wraps everything in small batches, verifies a sample with the new key only and prints no plaintext', async () => {
    const lines: string[] = [];
    const r = await rewrapAll({ batchSize: 2, log: (l) => lines.push(l) });
    expect(r.ok).toBe(true);
    expect(r.activeKeyId).toBe('k2');
    expect(r.kinds.map((k) => k.kind)).toEqual(REWRAP_KINDS.filter((k) => k !== 'blind_index'));
    expect(r.kinds.every((k) => k.failed === 0)).toBe(true);
    expect(r.verify.every((v) => v.failed === 0 && v.stillOld === 0 && v.sampled > 0)).toBe(true);
    expect(await countUsing('k1')).toBe(0);
    expect(await countUsing('k2')).toBeGreaterThan(10);
    const text = lines.join('\n') + JSON.stringify(r);
    for (const secret of [NAME, NOTES, 'whsec_test_secret_value', 'portal-key-value', 'whsec_hook_secret_value', 'Old plaintext', 'Haddad']) expect(text).not.toContain(secret);
    // the files table keeps the recorded key id in step
    expect((await q(`SELECT DISTINCT key_id FROM files WHERE wrapped_key IS NOT NULL`)).map((x) => x.key_id)).toEqual(['k2']);
    // the audit log records counts only
    const a = await q(`SELECT details FROM audit_log WHERE action = 'system.keys_rewrapped' ORDER BY seq DESC LIMIT 1`);
    expect(a[0].details.activeKeyId).toBe('k2');
    expect(JSON.stringify(a[0].details)).not.toContain(NAME);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await snapshot();
    const r = await rewrapAll({});
    expect(r.ok).toBe(true);
    for (const k of r.kinds) {
      expect(k.rewrapped, k.kind).toBe(0);
      expect(k.legacyEncrypted, k.kind).toBe(0);
      expect(k.alreadyCurrent, k.kind).toBeGreaterThan(0);
    }
    expect(await snapshot()).toBe(before);
  });

  it('can be limited with --only', async () => {
    const r = await rewrapAll({ only: ['files', 'totp'] });
    expect(r.kinds.map((k) => k.kind)).toEqual(['files', 'totp']);
    expect(r.verify.map((v) => v.kind)).toEqual(['files', 'totp']);
  });

  it('keeps working with the old key REMOVED from MASTER_KEYS', async () => {
    keyBackup.k1 = config.masterKeys.k1!;
    delete config.masterKeys.k1;
    clearDerivedKeys();
    expect(Object.keys(config.masterKeys).sort()).toEqual(['b1', 'k2']);

    // files download byte identical, including the replacement that shares the parent's bytes
    for (const [i, f] of ids.fileIds.entries()) {
      const d = await up.call('GET', `/api/files/${f}/download`);
      expect(d.status, `file ${i}`).toBe(200);
      expect(sha(d.res.rawPayload)).toBe(sha([data.u1, data.pts, data.l1][i]!));
    }
    const childFiles = await q(`SELECT id FROM files WHERE case_id = $1 AND kind = 'stl' LIMIT 1`, [ids.childId]);
    const cd = await up.call('GET', `/api/files/${childFiles[0].id}/download`);
    expect(cd.status).toBe(200);
    // the child copies the parent's model rows, so its model is one of the two parent models (the row order is not fixed)
    expect([sha(data.u1), sha(data.l1)]).toContain(sha(cd.res.rawPayload));

    // names, instructions, search
    const reveal = await up.call('POST', `/api/cases/${ids.caseId}/reveal-name`, {});
    expect(reveal.status, JSON.stringify(reveal.json)).toBe(200);
    expect(JSON.stringify(reveal.json)).toContain(NAME);
    const detail = await up.call('GET', `/api/cases/${ids.caseId}`);
    expect(detail.json.case.instructions ?? detail.json.instructions).toBe(NOTES);
    const found = await up.call('GET', `/api/cases?search=${encodeURIComponent(NAME)}`);
    expect(found.json.items.map((x: any) => x.id)).toContain(ids.caseId);

    // a fresh sign in needs the TOTP secret, then secrets in rows open with the new key
    const again = await new Client(app).full('upload@acme.demo');
    expect((await again.call('GET', '/api/auth/me')).json.stage).toBe('full');
    const hook = (await q(`SELECT secret_enc FROM webhooks WHERE id = $1`, [ids.webhookId]))[0];
    expect(decryptField(hook.secret_enc, fieldAad.webhook(ids.webhookId))).toBe('whsec_test_secret_value');
    const org = (await q(`SELECT settings->'portal_api'->>'apiKeyEnc' AS k FROM organizations WHERE id = $1`, [acmeId]))[0];
    expect(decryptField(org.k, fieldAad.portalKey(acmeId))).toBe('portal-key-value');
    const portalHook = (await q(`SELECT secret_enc FROM portal_hooks WHERE org_id = $1`, [acmeId]))[0];
    expect(decryptField(portalHook.secret_enc, fieldAad.portalHook(acmeId))).toBe('whsec_hook_secret_value');
    const legacy = (await q(`SELECT notes_enc FROM cases WHERE id = $1`, [ids.legacyId]))[0];
    expect(decryptField(legacy.notes_enc, fieldAad.caseNotes(ids.legacyId))).toBe('Old plaintext instructions from before encryption');

    // keys and recovery codes were hashed with the stable key, so they survive the rotation
    const k = await (await new Client(app).full('admin@kline.demo')).call('GET', '/api/auth/me');
    expect(k.status).toBe(200);
  });

  it('reports rows that still use a key that is no longer configured, without failing the rest', async () => {
    // a value sealed with a key this server does not have
    const stray = randomUUID();
    await q(`INSERT INTO webhooks (id, org_id, url, events, secret_enc) VALUES ($1, $2, 'https://hooks.example.test/y', ARRAY['case.ready'], $3)`, [stray, acmeId, 'f1.gone.AAAA.AAAA.AAAA']);
    const r = await rewrapAll({ only: ['webhooks'] });
    expect(r.ok).toBe(false);
    expect(r.kinds[0]!.failed).toBe(1);
    expect(r.kinds[0]!.failedByKey).toEqual({ gone: 1 });
    await q(`DELETE FROM webhooks WHERE id = $1`, [stray]);
  });

  it('rebuilds blind indexes when BLIND_INDEX_KEY_ID changes, and search keeps working', async () => {
    const oldBlind = config.blindIndexKeyId;
    config.masterKeys.b2 = Buffer.alloc(32, 9);
    config.blindIndexKeyId = 'b2';
    clearDerivedKeys();
    try {
      // until the indexes are rebuilt the exact name search finds nothing
      expect((await up.call('GET', `/api/cases?search=${encodeURIComponent(NAME)}`)).json.items).toHaveLength(0);
      const r = await rewrapAll({});
      expect(r.blindIndexChanged).toBe(true);
      const blind = r.kinds.find((k) => k.kind === 'blind_index')!;
      expect(blind.failed).toBe(0);
      expect(blind.rewrapped).toBeGreaterThanOrEqual(3);
      const found = await up.call('GET', `/api/cases?search=${encodeURIComponent(NAME)}`);
      expect(found.json.items.map((x: any) => x.id)).toContain(ids.caseId);
      // the replacement case carries the same index as its parent
      expect(found.json.items.map((x: any) => x.id)).toContain(ids.childId);
      // direct case: both name orders are findable
      for (const n of ['Noor Haddad', 'Haddad Noor']) expect((await up.call('GET', `/api/cases?search=${encodeURIComponent(n)}`)).json.items.map((x: any) => x.id)).toContain(ids.directId);
      // nothing more to do the second time
      const again = await rewrapAll({ only: ['blind_index'] });
      expect(again.kinds[0]!.rewrapped).toBe(0);
    } finally {
      config.blindIndexKeyId = oldBlind;
      clearDerivedKeys();
    }
  });
});

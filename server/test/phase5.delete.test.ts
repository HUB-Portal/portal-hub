import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { createApiKey } from '../src/auth/apikeys';
import { enqueue } from '../src/jobs';
import { deleteOrganisation, removeStoredPrefixes } from '../src/services/org';
import { chunkKey, newStoragePrefix, storage } from '../src/storage';
import { orgIdOf } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

let acmeId: string;
let klineId: string;
let contosoId: string;

async function tablesWithOrgId(): Promise<string[]> {
  const rows = await q<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'audit_log' ORDER BY 1`,
  );
  return rows.map((r) => r.table_name);
}
const countsFor = async (orgId: string) => {
  const out: Record<string, number> = {};
  for (const t of await tablesWithOrgId()) out[t] = (await q(`SELECT count(*)::int AS n FROM ${t} WHERE org_id = $1`, [orgId]))[0].n;
  return out;
};

beforeAll(async () => {
  await seedDemo({ force: true, withCases: true, writeKeys: false });
  acmeId = await orgIdOf('ACME');
  klineId = await orgIdOf('KLINE');
  contosoId = await orgIdOf('CONT');
});
afterAll(async () => {
  await closePools();
});

describe('deleteOrganisation', () => {
  it('removes a partner with cases, claims, files, materials, keys, sessions and jobs, in an order that never breaks a foreign key', async () => {
    const st = await storage();
    // Give Acme a bit of everything the phases created.
    const cases = await q<{ id: string; ref: string }>(`SELECT id, ref FROM cases WHERE org_id = $1 ORDER BY ref`, [acmeId]);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    const user = (await q(`SELECT id FROM users WHERE email = 'admin@acme.demo'`))[0].id as string;
    await q(`UPDATE cases SET parent_id = $2 WHERE id = $1`, [cases[1]!.id, cases[0]!.id]); // a child case
    const brand = (await q(`SELECT id FROM brands WHERE org_id = $1`, [acmeId]))[0].id as string;
    await q(`UPDATE cases SET brand_id = $2 WHERE id = $1`, [cases[0]!.id, brand]);
    const claim = (await q(
      `INSERT INTO claims (org_id, number, case_id, summary, rework_case_id, opened_by) VALUES ($1, 'CLM-2026-99999', $2, 'Test claim', $3, $4) RETURNING id`,
      [acmeId, cases[0]!.id, cases[1]!.id, user],
    ))[0].id as string;
    await q(`UPDATE cases SET claim_id = $2 WHERE id = $1`, [cases[1]!.id, claim]);
    await q(`INSERT INTO claim_items (org_id, claim_id, arch, step, defect_code) VALUES ($1, $2, 'upper', 1, 'DEBRIS')`, [acmeId, claim]);
    await q(`INSERT INTO claim_messages (org_id, claim_id, side, body) VALUES ($1, $2, 'system', 'Claim opened.')`, [acmeId, claim]);
    await q(`INSERT INTO bulk_batches (org_id, created_by) VALUES ($1, $2)`, [acmeId, user]);

    // Files: a case file, a claim photo, a logo, a document. Each has a stored object.
    const prefixes: string[] = [];
    const addFile = async (purpose: string, extra: { caseId?: string; claimId?: string }) => {
      const id = randomUUID();
      const prefix = newStoragePrefix();
      await st.put(chunkKey(prefix, 0), Buffer.from('ciphertext'));
      prefixes.push(prefix);
      await q(
        `INSERT INTO files (id, org_id, purpose, case_id, claim_id, kind, state, size, chunk_count, storage_prefix) VALUES ($1, $2, $3, $4, $5, 'other', 'ready', 10, 1, $6)`,
        [id, acmeId, purpose, extra.caseId ?? null, extra.claimId ?? null, prefix],
      );
      await q(`INSERT INTO file_chunks (file_id, org_id, idx, size) VALUES ($1, $2, 0, 10)`, [id, acmeId]);
      return id;
    };
    await addFile('case', { caseId: cases[0]!.id });
    await addFile('claim', { claimId: claim });
    const logo = await addFile('logo', {});
    await addFile('document', {});
    await q(`UPDATE organizations SET logo_file_id = $2 WHERE id = $1`, [acmeId, logo]);
    await q(`UPDATE brands SET logo_file_id = $2 WHERE id = $1`, [brand, await addFile('logo', {})]);
    await q(`UPDATE agreements SET file_id = $2 WHERE org_id = $1`, [acmeId, await addFile('agreement', {})]);

    // Keys, sessions, notifications, jobs
    await tx({ orgId: acmeId, bypass: false }, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'del test', scopes: ['cases:read'], expiresInDays: 30 }));
    await q(`INSERT INTO sessions (org_id, user_id, token_hash, stage, expires_at) VALUES ($1, $2, 'deadbeef-del-test', 'full', now() + interval '1 hour')`, [acmeId, user]);
    await q(`INSERT INTO notifications (org_id, kind, title) VALUES ($1, 'test', 'Test')`, [acmeId]);
    await tx(SYSTEM, (c) => enqueue(c, 'email.send', { to: 'x@y.test' }, { orgId: acmeId }));
    await q(`INSERT INTO mes_events (case_id, payload) VALUES ($1, '{}'::jsonb)`, [cases[0]!.id]);

    const before = await countsFor(acmeId);
    for (const t of ['cases', 'claims', 'claim_items', 'claim_messages', 'files', 'file_chunks', 'brands', 'specs', 'agreements', 'users', 'api_keys', 'sessions', 'notifications', 'jobs', 'materials', 'material_shipments', 'material_shipment_lines', 'material_movements', 'org_sites', 'bulk_batches', 'case_events']) {
      expect(before[t], `${t} exists before`).toBeGreaterThan(0);
    }
    const kBefore = await countsFor(klineId);
    const cBefore = await countsFor(contosoId);
    const auditBefore = (await q(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1`, [acmeId]))[0].n;
    const otherCases = (await q(`SELECT count(*)::int AS n FROM cases WHERE org_id <> $1`, [acmeId]))[0].n;

    // The demo seed gives Acme real encrypted files too (some shared with replacement and rework cases), so every stored object of the organisation is expected.
    const allPrefixes = (await q(`SELECT DISTINCT storage_prefix FROM files WHERE org_id = $1 AND storage_prefix IS NOT NULL`, [acmeId])).map((r) => r.storage_prefix as string);
    expect(allPrefixes.length).toBeGreaterThan(prefixes.length);
    for (const p of prefixes) expect(allPrefixes).toContain(p);
    const del = await tx(SYSTEM, (c) => deleteOrganisation(c, acmeId));
    expect(del.code).toBe('ACME');
    expect(del.prefixes.sort()).toEqual([...allPrefixes].sort());
    await removeStoredPrefixes(del.prefixes);

    // Nothing of Acme is left anywhere, the others are untouched, the audit log is not touched
    const after = await countsFor(acmeId);
    expect(Object.values(after).every((n) => n === 0), JSON.stringify(after)).toBe(true);
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [acmeId])).toHaveLength(0);
    expect(await countsFor(klineId)).toEqual(kBefore);
    expect(await countsFor(contosoId)).toEqual(cBefore);
    expect((await q(`SELECT count(*)::int AS n FROM cases WHERE org_id <> $1`, [acmeId]))[0].n).toBe(otherCases);
    expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1`, [acmeId]))[0].n).toBe(auditBefore);
    expect((await q(`SELECT ok FROM kph_audit_verify_chain()`))[0].ok).toBe(true);
    // the stored objects are gone
    for (const p of allPrefixes) expect(await st.exists(chunkKey(p, 0)), p).toBe(false);
    // the MES event log keeps its row but no longer points at a case
    expect((await q(`SELECT count(*)::int AS n FROM mes_events WHERE case_id IS NOT NULL AND case_id NOT IN (SELECT id FROM cases)`))[0].n).toBe(0);
  });

  it('is harmless for an unknown organisation and refuses K Line', async () => {
    const none = await tx(SYSTEM, (c) => deleteOrganisation(c, randomUUID()));
    expect(none).toEqual({ code: null, prefixes: [] });
    await expect(tx(SYSTEM, (c) => deleteOrganisation(c, klineId))).rejects.toThrow(/partner/);
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [klineId])).toHaveLength(1);
  });

  it('removes a registration that has only the basics', async () => {
    const del = await tx(SYSTEM, (c) => deleteOrganisation(c, contosoId));
    // the seeded company logo is its only stored file
    expect(del.code).toBe('CONT');
    expect(del.prefixes).toHaveLength(1);
    expect(Object.values(await countsFor(contosoId)).every((n) => n === 0)).toBe(true);
  });
});

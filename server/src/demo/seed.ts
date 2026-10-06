import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT, config } from '../config';
import { createApiKey } from '../auth/apikeys';
import { KLINE_API_SCOPES } from '../../../shared/roles';
import { seedAcmeCases } from './seedCases';
import { sampleLogoSvg } from './assets';
import { DEFAULT_STAGE_MAP, stageLabel, isStageId } from '../../../shared/stages';
import { audit } from '../audit';
import { SYSTEM, ownerPool, tx, type PoolClient } from '../db';
import { createHash } from 'node:crypto';
import { CHUNK_SIZE, chunkCountFor, newFileKey, sealBuffer } from '../crypto/envelope';
import { encryptField, fieldAad } from '../crypto/keys';
import { chunkKey, newStoragePrefix, storage } from '../storage';
import { validateContent, bufferSource } from '../services/validate';
import type { CaseAddress } from '../../../shared/caseAddress';
import { hashPassword } from '../crypto/password';
import { generateRecoveryCodes } from '../crypto/totp';
import { DEMO_PASSWORD, demoTotpSecret } from '../services/demo';
import { defaultSpecContent, hashSpec } from '../../../shared/spec';
import { PRIVACY_VERSION } from '../../../shared/signup';
import { renderEmail, SIGNUP_CONFIRM_SUBJECT } from '../services/mail';
import { createUserToken } from '../services/userTokens';
import { VERIFY_TTL_MINUTES } from '../services/signup';

const SITES = [
  { code: 'PT-CHV', name: 'Chaves', city: 'Chaves', country: 'PT', eea: true },
  { code: 'EG-CFZ', name: 'Cairo', city: 'Cairo', country: 'EG', eea: false },
  { code: 'MX-TIJ', name: 'Tijuana', city: 'Tijuana', country: 'MX', eea: false },
  { code: 'US-WPB', name: 'West Palm Beach', city: 'West Palm Beach', country: 'US', eea: false },
  { code: 'US-MEM', name: 'Memphis', city: 'Memphis', country: 'US', eea: false },
];

const KLINE_USERS = [
  { email: 'admin@kline.demo', name: 'Katrin Admin', roles: ['kl_admin'], site: null },
  { email: 'intake@kline.demo', name: 'Ingo Intake', roles: ['kl_intake'], site: null },
  { email: 'chaves@kline.demo', name: 'Carla Chaves', roles: ['kl_production'], site: 'PT-CHV' },
  { email: 'quality@kline.demo', name: 'Quentin Quality', roles: ['kl_quality'], site: null },
  { email: 'finance@kline.demo', name: 'Fiona Finance', roles: ['kl_finance'], site: null },
];

const ACME_USERS = [
  { email: 'admin@acme.demo', name: 'Alex Acme', roles: ['admin'] },
  { email: 'upload@acme.demo', name: 'Uma Upload', roles: ['uploader'] },
  { email: 'quality@acme.demo', name: 'Quinn Quality', roles: ['quality'] },
  { email: 'finance@acme.demo', name: 'Finn Finance', roles: ['finance'] },
];

/** Removes every row except the audit log (trimmed through its proper function) and migration bookkeeping. */
async function wipe(): Promise<void> {
  const owner = ownerPool();
  const t = await owner.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'audit_log', 'audit_anchor')`,
  );
  const list = t.rows.map((r) => `"${r.tablename}"`).join(', ');
  await owner.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await owner.query(`SELECT kph_audit_trim('infinity'::timestamptz)`);
  // The encrypted objects of the wiped files are unreachable now; remove them from the local disk store too.
  if (config.storageDriver === 'fs') rmSync(path.join(config.storageDir, 'f'), { recursive: true, force: true });
}

/** Inserts the default stage map (also part of migration 003; the seed wipes every table first). */
async function seedStageMap(c: PoolClient): Promise<void> {
  for (const e of DEFAULT_STAGE_MAP) {
    await c.query(
      `INSERT INTO mes_stage_map (mes_code, stage, target, note, label) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (mes_code) DO NOTHING`,
      [e.code, isStageId(e.target) ? e.target : null, e.target, e.note, isStageId(e.target) ? stageLabel(e.target) : null],
    );
  }
}

/** Fictional complete case addresses (shipping addresses the K Line portal keeps on each case). */
const CASE_ADDRESSES: Record<'ACME' | 'CONT' | 'FDL', CaseAddress> = {
  ACME: { company: 'Acme Aligners Ltd', fullName: 'Alex Acme', street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', stateProvince: 'Vila Real', country: 'PT', phone: '+351276000000', email: 'goods@acme.demo' },
  CONT: { company: 'Contoso Smile', fullName: 'Olga Owner', street: '12 Calle del Sol', city: 'Madrid', postalCode: '28001', stateProvince: 'Madrid', country: 'ES', phone: '+34910000000', email: 'owner@contoso.demo' },
  FDL: { company: 'Fabrikam Dental Lab', fullName: 'Felix Fabrikam', street: '5 Musterstrasse', city: 'Hamburg', postalCode: '20095', stateProvince: 'Hamburg', country: 'DE', phone: '+4940000000', email: 'owner@fabrikam.demo' },
};

/** Stores a generated fictional logo (SVG) exactly like an upload would: encrypted, checked, and set as the company logo. */
async function seedLogo(c: PoolClient, orgId: string, label: string, colour: string, uploaderId: string | null): Promise<void> {
  const data = Buffer.from(sampleLogoSvg(label, colour), 'utf8');
  const id = randomUUID();
  const key = newFileKey(id);
  const prefix = newStoragePrefix();
  const count = chunkCountFor(data.length);
  const sealed = sealBuffer(key.cipher, data);
  const st = await storage();
  for (let i = 0; i < sealed.length; i++) await st.put(chunkKey(prefix, i), sealed[i]!);
  const result = await validateContent('svg', 'svg', bufferSource(data));
  if (result.errors.length) throw new Error('The demo logo is not a valid SVG');
  await c.query(
    `INSERT INTO files (id, org_id, purpose, kind, name_enc, ext, content_type, size, chunk_size, chunk_count, wrapped_key, key_id, nonce_prefix, storage_prefix, state, scan_status, validation, meta, uploader_id, uploaded_at, processed_at)
     VALUES ($1, $2, 'logo', 'svg', $3, 'svg', 'image/svg+xml', $4, $5, $6, $7, $8, $9, $10, 'ready', 'skipped', $11::jsonb, $12::jsonb, $13, now(), now())`,
    [
      id, orgId, encryptField('logo.svg', fieldAad.fileName(id)), data.length, CHUNK_SIZE, count, key.wrappedKey, key.keyId, key.noncePrefix, prefix,
      JSON.stringify({ errors: [], warnings: [] }), JSON.stringify({ ...result.meta, sha256: createHash('sha256').update(data).digest('hex') }), uploaderId,
    ],
  );
  for (let i = 0; i < sealed.length; i++) await c.query('INSERT INTO file_chunks (file_id, org_id, idx, size) VALUES ($1, $2, $3, $4)', [id, orgId, i, sealed[i]!.length]);
  await c.query('UPDATE organizations SET logo_file_id = $2 WHERE id = $1', [orgId, id]);
}

/** Phase 4 sample data: Acme's production spec (version 1 active, version 2 proposed by K Line), two materials and two shipments. */
async function seedPhase4(c: PoolClient, acmeId: string, klineId: string, siteIds: Record<string, string>): Promise<void> {
  const user = async (email: string) => (await c.query('SELECT id, name FROM users WHERE email = $1', [email])).rows[0] as { id: string; name: string };
  const acmeQuality = await user('quality@acme.demo');
  const klQuality = await user('quality@kline.demo');

  const v1 = defaultSpecContent();
  const h1 = await hashSpec(v1);
  await c.query(
    `INSERT INTO specs (org_id, version, title, content, content_hash, change_note, created_side, status, created_by, proposed_by, proposed_at,
                        partner_signed_by, partner_signed_name, partner_signed_at, kline_signed_by, kline_signed_name, kline_signed_at, activated_at)
     VALUES ($1, 1, 'Production specification', $2::jsonb, $3, 'First version', 'kline', 'active', $4, $4, now() - interval '30 days',
             $5, $6, now() - interval '29 days', $4, $7, now() - interval '29 days', now() - interval '29 days')`,
    [acmeId, JSON.stringify(v1), h1, klQuality.id, acmeQuality.id, acmeQuality.name, klQuality.name],
  );
  await c.query(`UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{bag}', $2::jsonb, true) WHERE id = $1`, [acmeId, JSON.stringify(v1.bag)]);

  const v2 = defaultSpecContent();
  v2.finish.clauses.push({ id: 'FN-4', title: 'Final inspection', text: 'Every aligner is inspected under bright light before it is packed.' });
  v2.trim.clauses[2] = { ...v2.trim.clauses[2]!, text: 'The trim ends at the distal edge of the last tooth unless the case says otherwise. Extensions are marked on the model.' };
  await c.query(
    `INSERT INTO specs (org_id, version, title, content, content_hash, change_note, created_side, status, created_by, proposed_by, proposed_at)
     VALUES ($1, 2, 'Production specification', $2::jsonb, $3, 'Adds a final inspection step and clarifies distal trim', 'kline', 'proposed', $4, $4, now() - interval '1 day')`,
    [acmeId, JSON.stringify(v2), await hashSpec(v2), klQuality.id],
  );

  const mat = async (sku: string, name: string, category: string, perCase: number, perAligner: number, minStock: number) =>
    (await c.query(
      `INSERT INTO materials (org_id, sku, name, category, unit, per_case, per_aligner, min_stock) VALUES ($1, $2, $3, $4, 'pieces', $5, $6, $7) RETURNING id`,
      [acmeId, sku, name, category, perCase, perAligner, minStock],
    )).rows[0].id as string;
  const box = await mat('ACME-BOX', 'Acme case box', 'box', 1, 0, 50);
  const bag = await mat('ACME-BAG', 'Acme aligner bag', 'bag', 0, 1, 200);

  const shipment = async (status: 'received' | 'in_transit', lines: [string, number][]) => {
    const n = (await c.query('SELECT kph_next_counter($1) AS n', [`shipment:${new Date().getUTCFullYear()}`])).rows[0].n as number;
    const number = `SHP-${new Date().getUTCFullYear()}-${String(n).padStart(5, '0')}`;
    const sh = (await c.query(
      `INSERT INTO material_shipments (org_id, number, site_id, carrier, tracking, expected_date, status, declared_by, received_at, created_at)
       VALUES ($1, $2, $3, 'DHL Express', 'DEMO-MAT-0001', current_date + 2, $4, $5, $6, now() - interval '10 days') RETURNING id`,
      [acmeId, number, siteIds['PT-CHV'], status, acmeQuality.id, status === 'received' ? new Date(Date.now() - 8 * 86_400_000) : null],
    )).rows[0].id as string;
    for (const [m, q] of lines) {
      await c.query(`INSERT INTO material_shipment_lines (org_id, shipment_id, material_id, quantity, received_quantity) VALUES ($1, $2, $3, $4, $5)`, [acmeId, sh, m, q, status === 'received' ? q : null]);
      if (status === 'received') {
        await c.query(`INSERT INTO material_movements (org_id, material_id, site_id, kind, quantity, shipment_id, actor_id, created_at) VALUES ($1, $2, $3, 'receipt', $4, $5, $6, now() - interval '8 days')`, [acmeId, m, siteIds['PT-CHV'], q, sh, klQuality.id]);
      }
    }
  };
  await shipment('received', [[box, 120], [bag, 600]]);
  await shipment('in_transit', [[box, 200]]);
  void klineId;
}

/**
 * Phase 5 sample registrations. Contoso Smile registered itself, confirmed its email address and waits for K Line to review it.
 * Fabrikam Dental Lab registered but has not confirmed: its confirmation link is listed by GET /api/demo/registrations.
 * Both are fictional. The organisation codes differ from the ones the tests insert themselves (CONTOSO, FABRIK).
 */
async function seedRegistrations(c: PoolClient, passwordHash: string): Promise<number> {
  const day = 86_400_000;
  const insertOrg = async (name: string, code: string, country: string, signup: Record<string, unknown>) =>
    (await c.query(
      `INSERT INTO organizations (kind, name, code, country, status, settings, signup)
       VALUES ('partner', $1, $2, $3, 'onboarding', $4::jsonb, $5::jsonb) RETURNING id`,
      [name, code, country, JSON.stringify({ manual_review: true, require_pts: false, sla_days: 3, case_address: CASE_ADDRESSES[code as 'CONT' | 'FDL'] }), JSON.stringify(signup)],
    )).rows[0].id as string;
  const draftSpec = async (orgId: string, userId: string) => {
    const content = defaultSpecContent();
    await c.query(
      `INSERT INTO specs (org_id, version, title, content, content_hash, created_side, status, created_by) VALUES ($1, 1, 'Production specification', $2::jsonb, $3, 'partner', 'draft', $4)`,
      [orgId, JSON.stringify(content), await hashSpec(content), userId],
    );
  };

  // Contoso Smile: confirmed, waiting for review. The owner has a password and an authenticator, so the demo can sign in and see the locked features.
  const at1 = new Date(Date.now() - 2 * day);
  const contoso = await insertOrg('Contoso Smile', 'CONT', 'ES', {
    at: at1.toISOString(), email: 'owner@contoso.demo', name: 'Olga Owner', website: 'https://www.contoso-smile.example', volume: '1000_5000', free_email: false,
    privacy_version: PRIVACY_VERSION, authority_accepted_at: at1.toISOString(), verified_at: new Date(at1.getTime() + 3_600_000).toISOString(),
  });
  const ownerId = randomUUID();
  const rc = generateRecoveryCodes(10);
  await c.query(
    `INSERT INTO users (id, org_id, email, name, roles, status, password_hash, password_changed_at, totp_secret_enc, mfa_enabled, mfa_enrolled_at, recovery_hashes)
     VALUES ($1, $2, 'owner@contoso.demo', 'Olga Owner', ARRAY['admin'], 'active', $3, now(), $4, true, now(), $5)`,
    [ownerId, contoso, passwordHash, encryptField(demoTotpSecret('owner@contoso.demo'), fieldAad.userTotp(ownerId)), rc.hashes],
  );
  await draftSpec(contoso, ownerId);
  await seedLogo(c, contoso, 'Contoso Smile', '#0f766e', ownerId);

  // Fabrikam Dental Lab: registered yesterday, email not confirmed, one live confirmation link.
  const at2 = new Date(Date.now() - day);
  const fabrikam = await insertOrg('Fabrikam Dental Lab', 'FDL', 'DE', {
    at: at2.toISOString(), email: 'owner@fabrikam.demo', name: 'Felix Fabrikam', website: null, volume: 'under_1000', free_email: false,
    privacy_version: PRIVACY_VERSION, authority_accepted_at: at2.toISOString(), verified_at: null,
  });
  const fabId = (await c.query(`INSERT INTO users (org_id, email, name, roles, status) VALUES ($1, 'owner@fabrikam.demo', 'Felix Fabrikam', ARRAY['admin'], 'invited') RETURNING id`, [fabrikam])).rows[0].id as string;
  await draftSpec(fabrikam, fabId);
  await seedLogo(c, fabrikam, 'Fabrikam Dental', '#9333ea', null);
  const token = await createUserToken(c, { orgId: fabrikam, userId: fabId, kind: 'verify', ttlMinutes: VERIFY_TTL_MINUTES });
  const mail = renderEmail('signup_confirm', { link: `${config.publicUrl}/verify?token=${token}` });
  await c.query('INSERT INTO dev_mailbox (to_addr, subject, body) VALUES ($1, $2, $3)', ['owner@fabrikam.demo', SIGNUP_CONFIRM_SUBJECT, mail.text]);
  return 2;
}

export async function seedDemo(opts: { force?: boolean; withCases?: boolean; writeKeys?: boolean } = {}): Promise<{ users: number }> {
  if (config.isProd) throw new Error('Demo seeding is refused in production.');
  const existing = await tx(SYSTEM, (c) => c.query('SELECT count(*)::int AS n FROM organizations'));
  if (existing.rows[0].n > 0 && !opts.force) throw new Error('The database already has data. Use --force to wipe and recreate the demo data.');
  if (opts.force) await wipe();

  const hash = await hashPassword(DEMO_PASSWORD);
  let totalUsers = KLINE_USERS.length + ACME_USERS.length;

  await tx(SYSTEM, async (c) => {
    const siteIds: Record<string, string> = {};
    for (const s of SITES) {
      const r = await c.query(
        'INSERT INTO sites (code, name, city, country, eea, adequacy) VALUES ($1, $2, $3, $4, $5, false) RETURNING id',
        [s.code, s.name, s.city, s.country, s.eea],
      );
      siteIds[s.code] = r.rows[0].id;
    }

    const kl = await c.query(
      `INSERT INTO organizations (kind, name, code, legal_name, country, status, default_site_id, settings)
       VALUES ('kline', 'K Line Europe GmbH', 'KLINE', 'K Line Europe GmbH', 'DE', 'active', $1, '{}'::jsonb) RETURNING id`,
      [siteIds['PT-CHV']],
    );
    const klineId = kl.rows[0].id as string;
    for (const id of Object.values(siteIds)) await c.query('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2)', [klineId, id]);

    const acme = await c.query(
      `INSERT INTO organizations (kind, name, code, legal_name, country, status, default_site_id, settings, contacts)
       VALUES ('partner', 'Acme Aligners', 'ACME', 'Acme Aligners Ltd', 'PT', 'active', $1, $2::jsonb, $3::jsonb) RETURNING id`,
      [
        siteIds['PT-CHV'],
        JSON.stringify({ manual_review: false, require_pts: false, sla_days: 3, case_address: CASE_ADDRESSES.ACME }),
        JSON.stringify({ operations: 'operations@acme.demo' }),
      ],
    );
    const acmeId = acme.rows[0].id as string;
    for (const code of ['PT-CHV', 'EG-CFZ']) await c.query('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2)', [acmeId, siteIds[code]]);
    await c.query(`INSERT INTO agreements (org_id, type, version, signed_at, signed_by, notes) VALUES ($1, 'dpa', '1.0', current_date, 'Alex Acme', 'Demo data processing agreement')`, [acmeId]);
    await c.query(`INSERT INTO brands (org_id, name) VALUES ($1, 'Acme Clear')`, [acmeId]);

    const insertUser = async (orgId: string, u: { email: string; name: string; roles: string[]; site?: string | null }) => {
      const id = randomUUID();
      const rc = generateRecoveryCodes(10);
      await c.query(
        `INSERT INTO users (id, org_id, email, name, roles, site_ids, status, password_hash, password_changed_at, totp_secret_enc, mfa_enabled, mfa_enrolled_at, recovery_hashes)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, now(), $8, true, now(), $9)`,
        [id, orgId, u.email, u.name, u.roles, u.site ? [siteIds[u.site]] : [], hash, encryptField(demoTotpSecret(u.email), fieldAad.userTotp(id)), rc.hashes],
      );
    };
    for (const u of KLINE_USERS) await insertUser(klineId, u);
    for (const u of ACME_USERS) await insertUser(acmeId, u);
    await seedLogo(c, acmeId, 'Acme Aligners', '#1d4f91', (await c.query(`SELECT id FROM users WHERE email = 'admin@acme.demo'`)).rows[0].id as string);

    totalUsers += await seedRegistrations(c, hash);
    await seedStageMap(c);
    let partnerKey: string | null = null;
    if (opts.withCases) {
      await seedPhase4(c, acmeId, klineId, siteIds);
      const rows = (await c.query(`SELECT id, email, name FROM users WHERE email LIKE '%@acme.demo' OR email LIKE '%@kline.demo'`)).rows as { id: string; email: string; name: string }[];
      await seedAcmeCases(c, { acmeId, klineId, siteIds, users: Object.fromEntries(rows.map((r) => [r.email, { id: r.id, name: r.name }])) });
      const pk = await createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'Demo partner system', scopes: ['cases:read', 'cases:write', 'patients:read', 'claims:read', 'materials:read'], expiresInDays: 365 });
      partnerKey = pk.key;
    }

    // A service key for trying the factory system API. Written to a file next to the data, never printed to logs.
    const key = await createApiKey(c, { orgId: klineId, orgKind: 'kline', name: 'Demo factory system', scopes: [...KLINE_API_SCOPES], expiresInDays: 365 });
    if (opts.writeKeys ?? config.env !== 'test') {
      const dir = path.join(SERVER_ROOT, 'data');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'demo-keys.txt'),
        `Demo service key for /api/mes/v1 (scopes mes:intake mes:files mes:events). Development only.
${key.key}
${partnerKey ? `
Demo partner key for Acme Aligners, for /api/v1 (scopes cases:read cases:write patients:read claims:read materials:read). Development only.
${partnerKey}
` : ''}`,
        { mode: 0o600 },
      );
    }

    await audit(c, { actorType: 'system', action: 'system.demo_seeded', details: { users: totalUsers } });
  });
  return { users: totalUsers };
}

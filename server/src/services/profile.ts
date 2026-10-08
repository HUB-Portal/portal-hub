import type { FastifyRequest } from 'fastify';
import vm from 'node:vm';
import { z } from 'zod';
import { audit } from '../audit';
import { config } from '../config';
import { dbCtx, type AuthContext } from '../auth/context';
import { many, one, tx, type PoolClient } from '../db';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { clientIp, userAgent } from '../http/util';
import { caseAddressView, isCompleteCaseAddress, validateCaseAddressPatch } from '../../../shared/caseAddress';
import { checkLogoBytes, checkLogoFile, type LogoFormat } from '../../../shared/logo';
import { countryName, isCountryCode, isEuCountry, validateCompanyName } from '../../../shared/signup';
import { MAX_PROFILE_FILES_UNAPPROVED, FILE_COLUMNS, fileContentStream, fileName, removeStored } from './files';
import { DPA_SQL } from './console';
import { notifyOrg } from './notify';

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const meta = (req: FastifyRequest) => ({ ip: clientIp(req), userAgent: userAgent(req) });

// ---------------------------------------------------------------------------
// Case ID pattern safety
// ---------------------------------------------------------------------------
const REGEX_SAMPLES = [
  'A'.repeat(200),
  '1'.repeat(200),
  'a1'.repeat(100),
  `${'A'.repeat(199)}!`,
  `${'a'.repeat(60)}-${'9'.repeat(60)}!`,
  'AC-1001',
  ' '.repeat(200),
  `${'9'.repeat(199)}x`,
  '/'.repeat(100) + '#'.repeat(100),
];

/**
 * Checks a partner supplied case ID pattern: it must compile, be at most 200 characters and finish quickly on hostile samples.
 * The test runs in a separate V8 context with a time limit, so a catastrophic pattern cannot hang the server.
 * Returns a message when the pattern is refused, else null.
 */
export function checkCaseIdRegex(src: string): string | null {
  if (src.length > 200) return 'The pattern can have at most 200 characters.';
  try {
    new RegExp(src);
  } catch {
    return 'This is not a valid pattern. Check the brackets and special characters.';
  }
  try {
    vm.runInNewContext('const re = new RegExp(src); for (const s of samples) re.test(s);', { src, samples: REGEX_SAMPLES }, { timeout: 100 });
  } catch {
    return 'This pattern is too slow or too complex to be safe. Please make it simpler.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export const CONTACT_KEYS = ['operations', 'quality', 'finance', 'it'] as const;
type Contact = { name: string; email: string; phone: string };

function contactOf(v: unknown): Contact {
  // Older data may hold just an email address.
  if (typeof v === 'string') return { name: '', email: v, phone: '' };
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return { name: s(o.name), email: s(o.email), phone: s(o.phone) };
}
function contactsView(raw: unknown): Record<(typeof CONTACT_KEYS)[number], Contact> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { operations: contactOf(o.operations), quality: contactOf(o.quality), finance: contactOf(o.finance), it: contactOf(o.it) };
}
function addressView(raw: unknown) {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return { street: s(o.street), city: s(o.city), postalCode: s(o.postalCode), country: s(o.country) };
}
function addressLine(a: ReturnType<typeof addressView>): string {
  return [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), countryName(a.country)].filter(Boolean).join(', ');
}

/** Facts the profile checklist needs. */
export function profileComplete(o: { legal_name: string | null; vat_id: string | null; country: string | null; address_details: unknown; contacts: unknown }): boolean {
  const a = addressView(o.address_details);
  const hasContact = CONTACT_KEYS.some((k) => contactsView(o.contacts)[k].email.trim() !== '');
  return (
    !!o.legal_name?.trim() &&
    (!isEuCountry(o.country) || !!o.vat_id?.trim()) &&
    !!(a.street.trim() && a.city.trim() && a.postalCode.trim() && a.country.trim()) &&
    hasContact
  );
}

async function profileFileCount(c: PoolClient, orgId: string): Promise<number> {
  return (await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM files WHERE org_id = $1 AND purpose IN ('logo', 'document') AND state <> 'purged'`, [orgId]))?.n ?? 0;
}

/** `version` is the id of the stored logo file: a new upload is always a new file, so it changes whenever the logo changes. */
export const logoView = (o: { logo_file_id?: string | null }): { hasLogo: boolean; version: string | null } => ({ hasLogo: !!o.logo_file_id, version: o.logo_file_id ?? null });

export async function getProfile(a: AuthContext) {
  return tx(dbCtx(a), async (c) => {
    const o = await one<any>(c, 'SELECT * FROM organizations WHERE id = $1', [a.orgId]);
    if (!o) throw notFound();
    const s = o.settings ?? {};
    const approved = o.status === 'active';
    return {
      id: o.id,
      name: o.name,
      code: o.code,
      status: o.status,
      approved,
      legalName: o.legal_name ?? '',
      country: o.country ?? '',
      countryLocked: approved,
      vatId: o.vat_id ?? '',
      vatRequired: isEuCountry(o.country),
      address: addressView(o.address_details),
      contacts: contactsView(o.contacts),
      settings: { caseIdRegex: typeof s.case_id_regex === 'string' ? s.case_id_regex : null, requirePts: !!s.require_pts },
      caseAddress: caseAddressView(s.case_address),
      caseAddressComplete: isCompleteCaseAddress(s.case_address),
      // The company logo is mandatory. `version` changes whenever the logo changes, so the browser can cache bust the image URL.
      logoRequired: true,
      hasLogo: !!o.logo_file_id,
      logo: logoView(o),
      profileFiles: { count: await profileFileCount(c, a.orgId), max: approved ? null : MAX_PROFILE_FILES_UNAPPROVED },
      updatedAt: iso(o.updated_at),
    };
  });
}

const plain = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[<>\u0000-\u001f\u007f]/.test(v), 'Remove the characters < and > and any control characters.');
const countryField = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => isCountryCode(v), 'Choose a country from the list.');
const contactSchema = z.object({
  name: plain(120).optional(),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email address.').max(254)]).optional(),
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[0-9+()\-. /]*$/, 'Use digits, spaces and + ( ) - only.')
    .optional(),
});

export const profileSchema = z.object({
  name: z.string().optional(),
  legalName: plain(160).optional(),
  country: countryField.optional(),
  vatId: z
    .string()
    .trim()
    .max(24)
    .regex(/^[A-Za-z0-9 .\-]*$/, 'Use letters, digits, spaces, dots and dashes only.')
    .nullable()
    .optional(),
  address: z
    .object({ street: plain(200).optional(), city: plain(100).optional(), postalCode: plain(20).optional(), country: z.union([z.literal(''), countryField]).optional() })
    .optional(),
  contacts: z.object({ operations: contactSchema.optional(), quality: contactSchema.optional(), finance: contactSchema.optional(), it: contactSchema.optional() }).optional(),
  settings: z.object({ caseIdRegex: z.string().max(200).nullable().optional(), requirePts: z.boolean().optional() }).optional(),
  // Partial update allowed. Each field given is checked with the shared validator (shared/caseAddress.ts).
  caseAddress: z
    .object({
      company: z.string().max(1000).optional(),
      fullName: z.string().max(1000).optional(),
      street: z.string().max(1000).optional(),
      city: z.string().max(1000).optional(),
      postalCode: z.string().max(1000).optional(),
      stateProvince: z.string().max(1000).optional(),
      country: z.string().max(1000).optional(),
      phone: z.string().max(1000).optional(),
      email: z.string().max(1000).optional(),
    })
    .optional(),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export async function updateProfile(a: AuthContext, req: FastifyRequest, input: ProfileInput) {
  const changed: string[] = [];
  let newName: string | undefined;
  if (input.name !== undefined) {
    const v = validateCompanyName(input.name);
    if (!v.ok) throw badRequest(v.message, 'invalid_request', { fields: [{ path: 'name', message: v.message }] });
    newName = v.value;
  }
  let regex: string | null | undefined;
  if (input.settings?.caseIdRegex !== undefined) {
    regex = input.settings.caseIdRegex === null || input.settings.caseIdRegex.trim() === '' ? null : input.settings.caseIdRegex;
    if (regex !== null) {
      const problem = checkCaseIdRegex(regex);
      if (problem) throw badRequest(problem, 'invalid_request', { fields: [{ path: 'settings.caseIdRegex', message: problem }] });
    }
  }
  let addressPatch: ReturnType<typeof validateCaseAddressPatch> | undefined;
  if (input.caseAddress) {
    addressPatch = validateCaseAddressPatch(input.caseAddress);
    if (!addressPatch.ok) {
      throw badRequest('Some details are missing or not valid.', 'invalid_request', { fields: addressPatch.problems.map((p) => ({ path: `caseAddress.${p.path}`, message: p.message })) });
    }
  }
  await tx(dbCtx(a), async (c) => {
    const o = await one<any>(c, 'SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
    if (!o) throw notFound();
    // The country decides where cases may be produced (transfer gate). After approval only K Line changes it.
    if (input.country !== undefined && input.country !== (o.country ?? '') && o.status === 'active') {
      throw conflict('Your country cannot be changed here after approval. Please ask K Line.', 'country_locked');
    }
    const sets: string[] = [];
    const params: unknown[] = [a.orgId];
    const set = (col: string, val: unknown, key: string) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
      changed.push(key);
    };
    if (newName !== undefined && newName !== o.name) set('name', newName, 'name');
    if (input.legalName !== undefined && input.legalName !== (o.legal_name ?? '')) set('legal_name', input.legalName || null, 'legalName');
    if (input.country !== undefined && input.country !== (o.country ?? '')) set('country', input.country, 'country');
    if (input.vatId !== undefined) {
      const vat = (input.vatId ?? '').replace(/\s+/g, '').toUpperCase();
      if (vat !== (o.vat_id ?? '')) set('vat_id', vat || null, 'vatId');
    }
    if (input.address) {
      const next = { ...addressView(o.address_details), ...Object.fromEntries(Object.entries(input.address).filter(([, v]) => v !== undefined)) };
      set('address_details', JSON.stringify(next), 'address');
      set('address', addressLine(next) || null, 'address');
    }
    if (input.contacts) {
      const cur = contactsView(o.contacts);
      const next: Record<string, Contact> = { ...cur };
      for (const k of CONTACT_KEYS) {
        const patch = input.contacts[k];
        if (patch) next[k] = { ...cur[k], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Contact;
      }
      set('contacts', JSON.stringify(next), 'contacts');
    }
    if (input.settings || (addressPatch?.ok && Object.keys(addressPatch.value).length)) {
      const next: Record<string, unknown> = { ...(o.settings ?? {}) };
      if (addressPatch?.ok && Object.keys(addressPatch.value).length) {
        const cur = next.case_address && typeof next.case_address === 'object' ? (next.case_address as Record<string, unknown>) : {};
        next.case_address = { ...cur, ...addressPatch.value };
        changed.push('caseAddress');
      }
      if (input.settings && regex !== undefined) {
        if (regex === null) delete next.case_id_regex;
        else next.case_id_regex = regex;
        changed.push('settings.caseIdRegex');
      }
      if (input.settings?.requirePts !== undefined) {
        next.require_pts = input.settings.requirePts;
        changed.push('settings.requirePts');
      }
      params.push(JSON.stringify(next));
      sets.push(`settings = $${params.length}`);
    }
    if (!sets.length) return;
    await c.query(`UPDATE organizations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    // Only the names of the changed fields go into the audit log, never the values (contacts are personal data).
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.profile_updated', targetType: 'organization', targetId: a.orgId, ...meta(req), details: { changed: [...new Set(changed)] } });
  });
  return getProfile(a);
}

// ---------------------------------------------------------------------------
// Brands and logos
// ---------------------------------------------------------------------------
export const MAX_BRANDS = 50;

const brandDto = (b: any) => ({ id: b.id, name: b.name, hasLogo: !!b.logo_file_id, createdAt: iso(b.created_at) });

export const brandNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a brand name.')
  .max(80, 'A brand name can have at most 80 characters.')
  .refine((v) => !/[<>\u0000-\u001f\u007f]/.test(v), 'Remove the characters < and > and any control characters.');

export async function listBrands(a: AuthContext) {
  const rows = await tx(dbCtx(a), (c) => many<any>(c, 'SELECT id, name, logo_file_id, created_at FROM brands WHERE org_id = $1 ORDER BY lower(name)', [a.orgId]));
  return { items: rows.map(brandDto) };
}

export async function createBrand(a: AuthContext, req: FastifyRequest, name: string) {
  return tx(dbCtx(a), async (c) => {
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
    const n = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM brands WHERE org_id = $1', [a.orgId]);
    if ((n?.n ?? 0) >= MAX_BRANDS) throw conflict(`You can have at most ${MAX_BRANDS} brands.`, 'too_many_brands');
    try {
      const b = await one<any>(c, 'INSERT INTO brands (org_id, name) VALUES ($1, $2) RETURNING id, name, logo_file_id, created_at', [a.orgId, name]);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.brand_created', targetType: 'brand', targetId: b.id, ...meta(req) });
      return { brand: brandDto(b) };
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('You already have a brand with that name.', 'brand_exists');
      throw err;
    }
  });
}

export async function renameBrand(a: AuthContext, req: FastifyRequest, id: string, name: string) {
  return tx(dbCtx(a), async (c) => {
    try {
      const b = await one<any>(c, 'UPDATE brands SET name = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id, name, logo_file_id, created_at', [id, a.orgId, name]);
      if (!b) throw notFound('That brand could not be found.');
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.brand_updated', targetType: 'brand', targetId: id, ...meta(req) });
      return { brand: brandDto(b) };
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('You already have a brand with that name.', 'brand_exists');
      throw err;
    }
  });
}

export async function deleteBrand(a: AuthContext, req: FastifyRequest, id: string): Promise<void> {
  const prefix = await tx(dbCtx(a), async (c) => {
    const b = await one<any>(c, 'SELECT id, logo_file_id FROM brands WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.orgId]);
    if (!b) throw notFound('That brand could not be found.');
    const used = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM cases WHERE brand_id = $1', [id]);
    if ((used?.n ?? 0) > 0) throw conflict('Cases use this brand, so it cannot be deleted.', 'brand_in_use');
    await c.query('DELETE FROM brands WHERE id = $1', [id]);
    const prefix = b.logo_file_id ? await dropFile(c, a.orgId, b.logo_file_id) : null;
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.brand_deleted', targetType: 'brand', targetId: id, ...meta(req) });
    return prefix;
  });
  if (prefix) await removeStored([prefix]);
}

/** Deletes a file row of this organisation and returns its storage prefix (to remove after commit). */
async function dropFile(c: PoolClient, orgId: string, fileId: string): Promise<string | null> {
  const f = await one<{ storage_prefix: string | null }>(c, 'DELETE FROM files WHERE id = $1 AND org_id = $2 RETURNING storage_prefix', [fileId, orgId]);
  return f?.storage_prefix ?? null;
}

export type LogoTarget = { kind: 'org' } | { kind: 'brand'; id: string };

async function currentLogoId(c: PoolClient, orgId: string, t: LogoTarget): Promise<string | null> {
  if (t.kind === 'org') return (await one<{ logo_file_id: string | null }>(c, 'SELECT logo_file_id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]))?.logo_file_id ?? null;
  const b = await one<{ logo_file_id: string | null }>(c, 'SELECT logo_file_id FROM brands WHERE id = $1 AND org_id = $2 FOR UPDATE', [t.id, orgId]);
  if (!b) throw notFound('That brand could not be found.');
  return b.logo_file_id;
}

async function writeLogoId(c: PoolClient, orgId: string, t: LogoTarget, fileId: string | null): Promise<void> {
  if (t.kind === 'org') await c.query('UPDATE organizations SET logo_file_id = $2, updated_at = now() WHERE id = $1', [orgId, fileId]);
  else await c.query('UPDATE brands SET logo_file_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2', [t.id, orgId, fileId]);
}

/** Reads a whole logo file into memory (at most 2 MB when called after the size check). */
async function readLogoBytes(row: any): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of fileContentStream(row)) parts.push(chunk);
  return Buffer.concat(parts);
}

/**
 * The company logo is checked when it is attached: file size, then pixel size (PNG, JPEG) or viewBox ratio (SVG), read from the decrypted
 * content. A refused file is deleted again, so it does not use up one of the few profile files an unapproved company may store.
 * Brand logos are not checked here. Answers 422 with logo_too_small, logo_too_large, logo_bad_ratio or logo_type.
 */
async function assertCompanyLogoAcceptable(a: AuthContext, fileId: string): Promise<void> {
  const row = await tx(dbCtx(a), (c) => one<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = $1 AND f.org_id = $2 AND f.purpose = 'logo' AND f.state = 'ready'`, [fileId, a.orgId]));
  // Not found or not ready: setLogo answers 404 or 409 as it always did.
  if (!row) return;
  let problem = checkLogoBytes(Number(row.size));
  if (!problem) {
    const ext = String(row.ext ?? '').toLowerCase();
    const format: LogoFormat | null = ext === 'png' ? 'png' : ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'svg' ? 'svg' : null;
    if (!format) problem = { code: 'logo_type', message: 'This file type cannot be used as a logo. Use a PNG (best), an SVG or a JPG.' };
    else problem = checkLogoFile(format, await readLogoBytes(row));
  }
  if (!problem) return;
  const prefix = await tx(dbCtx(a), async (c) => {
    const inUse = await one(c, `SELECT 1 AS x FROM organizations WHERE logo_file_id = $1 UNION ALL SELECT 1 FROM brands WHERE logo_file_id = $1`, [fileId]);
    return inUse ? null : await dropFile(c, a.orgId, fileId);
  });
  if (prefix) await removeStored([prefix]);
  throw new AppError(422, problem.code, problem.message);
}

/** The file kind recorded in the access log for a logo change: png, jpeg or svg. Never a file name. */
const logoKind = (ext: unknown): string => {
  const e = String(ext ?? '').toLowerCase();
  return e === 'jpg' ? 'jpeg' : ['png', 'jpeg', 'svg'].includes(e) ? e : 'other';
};

/**
 * Tells the company administrators that someone changed or removed the company logo: an in app notification only, no email
 * (the kind is not in NOTICES). The person who did it is not told about their own change. No file names, nothing the user typed.
 */
async function notifyLogoChange(c: PoolClient, a: AuthContext, removed: boolean): Promise<void> {
  const who = (await one<{ name: string }>(c, 'SELECT name FROM users WHERE id = $1 AND org_id = $2', [a.userId, a.orgId]))?.name?.trim() || 'A colleague';
  const admins = await many<{ id: string }>(c, `SELECT id FROM users WHERE org_id = $1 AND status = 'active' AND 'admin' = ANY(roles) AND id <> $2 ORDER BY id`, [a.orgId, a.userId]);
  for (const u of admins) {
    await notifyOrg(c, { orgId: a.orgId, userId: u.id, kind: removed ? 'org_logo_removed' : 'org_logo_changed', title: `${who} ${removed ? 'removed' : 'changed'} the company logo` });
  }
}

/** True while an organisation or a brand still points at this file (a file is never deleted while it does). */
async function logoStillUsed(c: PoolClient, fileId: string): Promise<boolean> {
  return !!(await one(c, `SELECT 1 AS x FROM organizations WHERE logo_file_id = $1 UNION ALL SELECT 1 FROM brands WHERE logo_file_id = $1`, [fileId]));
}

/**
 * Uses an uploaded (checked) logo file for the company or one brand. The previous logo file is deleted (row and stored bytes),
 * unless something else still points at it, so shared bytes can never be removed. The company logo is audited with the acting user
 * and the file kind, and the company administrators get a notification.
 */
export async function setLogo(a: AuthContext, req: FastifyRequest, t: LogoTarget, fileId: string): Promise<{ hasLogo: true; version: string }> {
  if (t.kind === 'org') await assertCompanyLogoAcceptable(a, fileId);
  const prefix = await tx(dbCtx(a), async (c) => {
    const previous = await currentLogoId(c, a.orgId, t);
    // Scoped by organisation and purpose: another organisation's file, or a document, can never become a logo.
    const f = await one<any>(c, `SELECT id, state, ext FROM files WHERE id = $1 AND org_id = $2 AND purpose = 'logo' FOR UPDATE`, [fileId, a.orgId]);
    if (!f) throw notFound('That logo file could not be found.');
    if (f.state !== 'ready') throw conflict('The logo is still being checked or was not accepted. Upload it again.', 'file_not_ready');
    const inUse = await logoStillUsed(c, fileId);
    if (inUse && previous !== fileId) throw conflict('That logo file is already used somewhere else. Upload it again.', 'file_in_use');
    await writeLogoId(c, a.orgId, t, fileId);
    const drop = previous && previous !== fileId && !(await logoStillUsed(c, previous)) ? await dropFile(c, a.orgId, previous) : null;
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId,
      action: t.kind === 'org' ? 'org.logo_changed' : 'org.brand_logo_updated',
      targetType: t.kind === 'org' ? 'organization' : 'brand', targetId: t.kind === 'org' ? a.orgId : t.id,
      ...meta(req),
      ...(t.kind === 'org' ? { details: { kind: logoKind(f.ext) } } : {}),
    });
    if (t.kind === 'org') await notifyLogoChange(c, a, false);
    return drop;
  });
  if (prefix) await removeStored([prefix]);
  return { hasLogo: true, version: fileId };
}

export async function clearLogo(a: AuthContext, req: FastifyRequest, t: LogoTarget): Promise<void> {
  const prefix = await tx(dbCtx(a), async (c) => {
    const previous = await currentLogoId(c, a.orgId, t);
    if (!previous) return null;
    const kind = logoKind((await one<{ ext: string }>(c, 'SELECT ext FROM files WHERE id = $1 AND org_id = $2', [previous, a.orgId]))?.ext);
    await writeLogoId(c, a.orgId, t, null);
    const drop = (await logoStillUsed(c, previous)) ? null : await dropFile(c, a.orgId, previous);
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId,
      action: t.kind === 'org' ? 'org.logo_removed' : 'org.brand_logo_removed',
      targetType: t.kind === 'org' ? 'organization' : 'brand', targetId: t.kind === 'org' ? a.orgId : t.id,
      ...meta(req),
      ...(t.kind === 'org' ? { details: { kind } } : {}),
    });
    if (t.kind === 'org') await notifyLogoChange(c, a, true);
    return drop;
  });
  if (prefix) await removeStored([prefix]);
}

/** The stored logo row (ready files only) for an organisation or one of its brands, or null. Scoped by the given organisation id. */
export async function logoRow(c: PoolClient, orgId: string, t: LogoTarget): Promise<any | null> {
  const sql =
    t.kind === 'org'
      ? `SELECT ${FILE_COLUMNS} FROM files f JOIN organizations o ON o.logo_file_id = f.id WHERE o.id = $1 AND f.org_id = $1 AND f.state = 'ready'`
      : `SELECT ${FILE_COLUMNS} FROM files f JOIN brands b ON b.logo_file_id = f.id WHERE b.org_id = $1 AND b.id = $2 AND f.org_id = $1 AND f.state = 'ready'`;
  return (await one<any>(c, sql, t.kind === 'org' ? [orgId] : [orgId, t.id])) ?? null;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export async function listDocuments(a: AuthContext) {
  const rows = await tx(dbCtx(a), (c) =>
    many<any>(
      c,
      `SELECT f.id, f.doc_kind, f.name_enc, f.ext, f.size, f.state, f.validation, f.created_at, u.name AS uploader_name
         FROM files f LEFT JOIN users u ON u.id = f.uploader_id
        WHERE f.org_id = $1 AND f.purpose = 'document' AND f.state IN ('processing', 'ready', 'rejected')
        ORDER BY f.created_at DESC`,
      [a.orgId],
    ),
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: fileName(r),
      kind: r.doc_kind ?? 'other',
      ext: r.ext,
      size: r.size,
      state: r.state,
      problem: r.state === 'rejected' ? (r.validation?.errors?.[0]?.message ?? 'The file was not accepted.') : null,
      uploadedBy: r.uploader_name ?? null,
      createdAt: iso(r.created_at),
    })),
  };
}

export async function deleteDocument(a: AuthContext, req: FastifyRequest, id: string): Promise<void> {
  const prefix = await tx(dbCtx(a), async (c) => {
    const f = await one<any>(c, `SELECT id, doc_kind FROM files WHERE id = $1 AND org_id = $2 AND purpose = 'document' FOR UPDATE`, [id, a.orgId]);
    if (!f) throw notFound('That document could not be found.');
    const p = await dropFile(c, a.orgId, id);
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'file.deleted', targetType: 'file', targetId: id, ...meta(req), details: { purpose: 'document', kind: f.doc_kind ?? 'other' } });
    return p;
  });
  if (prefix) await removeStored([prefix]);
}

// ---------------------------------------------------------------------------
// Agreements, sites, checklist
// ---------------------------------------------------------------------------
export async function listAgreements(a: AuthContext) {
  const rows = await tx(dbCtx(a), (c) =>
    many<any>(
      c,
      `SELECT id, type, signed_at, valid_until, reference FROM agreements
        WHERE org_id = $1 AND revoked_at IS NULL AND signed_at IS NOT NULL ORDER BY signed_at DESC, created_at DESC`,
      [a.orgId],
    ),
  );
  // No notes and no signer names: those are for K Line.
  return { items: rows.map((r) => ({ id: r.id, kind: r.type, signedAt: r.signed_at, expiresAt: r.valid_until, reference: r.reference ?? null })) };
}

export async function listOrgSites(a: AuthContext) {
  return tx(dbCtx(a), async (c) => {
    const rows = await many<any>(
      c,
      `SELECT s.code, s.name, s.city, s.country, s.active, (o.default_site_id = s.id) AS is_default
         FROM org_sites os JOIN sites s ON s.id = os.site_id JOIN organizations o ON o.id = os.org_id
        WHERE os.org_id = $1 ORDER BY s.code`,
      [a.orgId],
    );
    return { items: rows.map((r) => ({ code: r.code, name: r.name, city: r.city ?? null, country: r.country, active: r.active, isDefault: !!r.is_default })) };
  });
}

export async function onboardingChecklist(a: AuthContext) {
  return tx(dbCtx(a), async (c) => {
    const o = await one<any>(c, `SELECT o.*, ${DPA_SQL} AS dpa FROM organizations o WHERE o.id = $1`, [a.orgId]);
    if (!o) throw notFound();
    const secured = !config.mfaRequired || !!(await one(c, `SELECT 1 AS x FROM users WHERE org_id = $1 AND 'admin' = ANY(roles) AND status = 'active' AND mfa_enabled`, [a.orgId]));
    const spec = !!(await one(c, `SELECT 1 AS x FROM specs WHERE org_id = $1 AND status IN ('active', 'proposed')`, [a.orgId]));
    const approved = o.status === 'active';
    return {
      items: [
        ...(config.mfaRequired ? [{ id: 'account_secured', label: 'Secure your account with an authenticator app', done: secured }] : []),
        { id: 'profile', label: 'Complete your company profile', done: profileComplete(o) },
        { id: 'logo', label: 'Add your company logo', done: !!o.logo_file_id },
        { id: 'case_address', label: 'Add your case address', done: isCompleteCaseAddress(o.settings?.case_address) },
        { id: 'spec', label: 'Agree your production specification with K Line', done: spec },
        { id: 'dpa', label: 'Data processing agreement recorded by K Line', done: !!o.dpa },
        { id: 'approval', label: 'Approval by K Line', done: approved },
      ],
      approved,
    };
  });
}

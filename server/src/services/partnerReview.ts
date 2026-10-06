import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { audit } from '../audit';
import { dbCtx, type AuthContext } from '../auth/context';
import { revokeUserSessions } from '../auth/sessions';
import { many, one, tx, type PoolClient } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import { clientIp, userAgent } from '../http/util';
import { caseAddressView, isCompleteCaseAddress } from '../../../shared/caseAddress';
import { canReceive, isEea } from '../../../shared/geo';
import { COMPANY_CODE_RE, RESERVED_CODES, countryName, isCountryCode, validateCompanyName, volumeLabel } from '../../../shared/signup';
import { DPA_SQL, SCC_SQL } from './console';
import { siteOptions } from './intake';
import { queueEmail, notifyOrg } from './notify';
import { deleteOrganisation, removeStoredPrefixes } from './org';
import { CONTACT_KEYS } from './profile';

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const meta = (req: FastifyRequest) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const AGREEMENT_SQL = (kind: string) =>
  `EXISTS (SELECT 1 FROM agreements a WHERE a.org_id = o.id AND a.type = '${kind}' AND a.revoked_at IS NULL AND a.signed_at IS NOT NULL AND (a.valid_until IS NULL OR a.valid_until >= current_date))`;

export const DECLINED_RETENTION_DAYS = 30;

/** Sign up facts for the console, from organizations.signup. */
export function signupFlags(signup: any) {
  const s = signup && typeof signup === 'object' ? signup : {};
  const selfRegistered = typeof s.at === 'string';
  return {
    selfRegistered,
    emailConfirmed: selfRegistered ? !!s.verified_at : true,
    declined: !!s.declined_at,
  };
}

export type PartnerTab = 'all' | 'review' | 'declined';

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function listPartners(a: AuthContext, tab: PartnerTab, search: string | undefined) {
  return tx(dbCtx(a), async (c) => {
    const where = [`o.kind = 'partner'`];
    const params: unknown[] = [];
    if (tab === 'all') where.push(`NOT (o.signup ? 'declined_at')`);
    else if (tab === 'review') where.push(`o.signup ? 'at'`, `o.status = 'onboarding'`, `NOT (o.signup ? 'declined_at')`);
    else where.push(`o.signup ? 'declined_at'`);
    const q = (search ?? '').trim().slice(0, 100);
    if (q) {
      params.push(`%${likeEscape(q)}%`);
      where.push(`(o.name ILIKE $1 OR o.code ILIKE $1 OR (o.signup->>'email') ILIKE $1)`);
    }
    // Waiting for review: confirmed companies first, then unconfirmed ones, oldest first. Declined: most recent first.
    const order =
      tab === 'review'
        ? `((o.signup->>'verified_at') IS NULL), (o.signup->>'at'), o.id`
        : tab === 'declined'
          ? `(o.signup->>'declined_at') DESC, o.id`
          : `lower(o.name), o.id`;
    const rows = await many<any>(
      c,
      `SELECT o.id, o.name, o.code, o.status, o.country, o.retention_months, o.created_at, o.signup, ${DPA_SQL} AS dpa, ${SCC_SQL} AS scc,
              (SELECT count(*)::int FROM users u WHERE u.org_id = o.id) AS users_count,
              (SELECT count(*)::int FROM cases cs WHERE cs.org_id = o.id AND cs.status IN ('submitted', 'on_hold', 'ready', 'received', 'in_production')) AS open_cases,
              COALESCE((SELECT array_agg(s.code ORDER BY s.code) FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = o.id), '{}') AS site_codes,
              (SELECT s.code FROM sites s WHERE s.id = o.default_site_id) AS default_site
         FROM organizations o WHERE ${where.join(' AND ')} ORDER BY ${order}`,
      params,
    );
    const counts = await one<any>(
      c,
      `SELECT count(*) FILTER (WHERE NOT (signup ? 'declined_at'))::int AS "all",
              count(*) FILTER (WHERE signup ? 'at' AND status = 'onboarding' AND NOT (signup ? 'declined_at'))::int AS review,
              count(*) FILTER (WHERE signup ? 'declined_at')::int AS declined
         FROM organizations WHERE kind = 'partner'`,
    );
    return {
      tab,
      counts: { all: counts?.all ?? 0, review: counts?.review ?? 0, declined: counts?.declined ?? 0 },
      items: rows.map((o) => {
        const f = signupFlags(o.signup);
        const s = o.signup ?? {};
        return {
          id: o.id, name: o.name, code: o.code, status: o.status, country: o.country, retentionMonths: o.retention_months,
          dpaOnFile: o.dpa, sccOnFile: o.scc, usersCount: o.users_count, openCases: o.open_cases, siteCodes: o.site_codes, defaultSiteCode: o.default_site, createdAt: o.created_at,
          newSignup: f.selfRegistered && o.status === 'onboarding' && !f.declined,
          emailNotConfirmed: f.selfRegistered && !f.emailConfirmed,
          declined: f.declined,
          signupAt: f.selfRegistered ? s.at : null,
          freeEmail: f.selfRegistered ? !!s.free_email : false,
          volume: f.selfRegistered ? (s.volume ?? null) : null,
          declinedAt: f.declined ? s.declined_at : null,
          deletesAt: f.declined ? new Date(new Date(s.declined_at).getTime() + DECLINED_RETENTION_DAYS * 86_400_000).toISOString() : null,
        };
      }),
    };
  });
}

/** The registration card of the partner page. Staff only: it holds the registrant's name and email address. */
export function signupDetails(signup: any) {
  const s = signup && typeof signup === 'object' ? signup : {};
  if (typeof s.at !== 'string') return null;
  return {
    registrantName: s.name ?? null,
    email: s.email ?? null,
    website: s.website ?? null,
    volume: s.volume ?? null,
    volumeLabel: volumeLabel(s.volume) || null,
    freeEmail: !!s.free_email,
    privacyVersion: s.privacy_version ?? null,
    registeredAt: s.at,
    confirmedAt: s.verified_at ?? null,
    approvedAt: s.approved_at ?? null,
    declinedAt: s.declined_at ?? null,
    declineReason: s.decline_reason ?? null,
    deletesAt: s.declined_at ? new Date(new Date(s.declined_at).getTime() + DECLINED_RETENTION_DAYS * 86_400_000).toISOString() : null,
  };
}

/** Compliance gates for activation, with a plain reason for everything that blocks it. */
export async function partnerGates(c: PoolClient, o: any) {
  const so = await siteOptions(c, o.id);
  const sites = await many<any>(c, `SELECT s.country, s.eea, s.adequacy, s.active FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = $1`, [o.id]);
  const flags = signupFlags(o.signup);
  const qaa = !!(await one(c, `SELECT 1 AS x FROM organizations o WHERE o.id = $1 AND ${AGREEMENT_SQL('qaa')}`, [o.id]));
  const msa = !!(await one(c, `SELECT 1 AS x FROM organizations o WHERE o.id = $1 AND ${AGREEMENT_SQL('msa')}`, [o.id]));
  const hasSite = sites.some((s) => s.active);
  // Standard Contractual Clauses are needed when an EEA partner may use a site outside the EEA without an adequacy decision.
  const sccRequired = isEea(o.country) && sites.some((s) => !canReceive(o.country, s, false));
  const blockers: { code: string; message: string }[] = [];
  if (flags.declined) blockers.push({ code: 'partner_declined', message: 'This registration was declined.' });
  if (!flags.emailConfirmed) blockers.push({ code: 'email_not_confirmed', message: 'The registrant has not confirmed the email address yet.' });
  if (!o.dpa) blockers.push({ code: 'dpa_required', message: 'A data processing agreement must be on file first.' });
  if (!hasSite) blockers.push({ code: 'site_required', message: 'Add at least one active production site first.' });
  if (!o.logo_file_id) blockers.push({ code: 'logo_required', message: 'Company logo is required.' });
  return {
    dpaOnFile: !!o.dpa,
    sccOnFile: !!o.scc,
    qaaOnFile: qaa,
    msaOnFile: msa,
    hasSite,
    hasLogo: !!o.logo_file_id,
    emailConfirmed: flags.emailConfirmed,
    declined: flags.declined,
    sccRequired,
    sccMissing: sccRequired && !o.scc,
    canActivate: blockers.length === 0,
    blockers,
    sites: so.sites,
  };
}

export function profileForStaff(o: any) {
  const a = o.address_details && typeof o.address_details === 'object' ? o.address_details : {};
  const c = o.contacts && typeof o.contacts === 'object' ? o.contacts : {};
  const contacts: Record<string, { name: string; email: string; phone: string }> = {};
  for (const k of CONTACT_KEYS) {
    const v = (c as any)[k];
    contacts[k] = typeof v === 'string' ? { name: '', email: v, phone: '' } : { name: v?.name ?? '', email: v?.email ?? '', phone: v?.phone ?? '' };
  }
  return {
    addressDetails: { street: a.street ?? '', city: a.city ?? '', postalCode: a.postalCode ?? '', country: a.country ?? '' },
    contacts,
    countryName: countryName(o.country),
    hasLogo: !!o.logo_file_id,
    caseAddress: caseAddressView(o.settings?.case_address),
    caseAddressComplete: isCompleteCaseAddress(o.settings?.case_address),
    caseIdRegex: typeof o.settings?.case_id_regex === 'string' ? o.settings.case_id_regex : null,
  };
}

// ---------------------------------------------------------------------------
// Add a partner directly
// ---------------------------------------------------------------------------
export interface NewPartner {
  name: string;
  code: string;
  country: string;
  legalName?: string | null;
  retentionMonths?: number;
  siteCodes: string[];
  defaultSiteCode?: string | null;
}

export async function createPartner(a: AuthContext, req: FastifyRequest, b: NewPartner) {
  const name = validateCompanyName(b.name);
  if (!name.ok) throw badRequest(name.message, 'invalid_request', { fields: [{ path: 'name', message: name.message }] });
  const code = b.code.trim().toUpperCase();
  if (!COMPANY_CODE_RE.test(code)) throw badRequest('The code must be 2 to 8 letters or digits.', 'invalid_code');
  if (RESERVED_CODES.includes(code)) throw badRequest('That code is reserved for K Line.', 'code_reserved');
  const country = b.country.trim().toUpperCase();
  if (!isCountryCode(country)) throw badRequest('Choose a country from the list.', 'invalid_request', { fields: [{ path: 'country', message: 'Choose a country from the list.' }] });
  const codes = [...new Set(b.siteCodes)];
  if (b.defaultSiteCode && !codes.includes(b.defaultSiteCode)) throw badRequest('The default site must be one of the selected sites.', 'invalid_site');
  return tx(dbCtx(a), async (c) => {
    const sites = codes.length ? await many<{ id: string; code: string }>(c, 'SELECT id, code FROM sites WHERE code = ANY($1::text[])', [codes]) : [];
    if (sites.length !== codes.length) throw badRequest('One of the sites does not exist.', 'invalid_site');
    let orgId: string;
    try {
      const r = await one<{ id: string }>(
        c,
        `INSERT INTO organizations (kind, name, code, legal_name, country, status, retention_months, default_site_id, settings)
         VALUES ('partner', $1, $2, $3, $4, 'onboarding', $5, $6, $7::jsonb) RETURNING id`,
        [
          name.value, code, b.legalName?.trim() || null, country, b.retentionMonths ?? 24,
          b.defaultSiteCode ? sites.find((s) => s.code === b.defaultSiteCode)!.id : null,
          JSON.stringify({ manual_review: true, require_pts: false, sla_days: 3 }),
        ],
      );
      orgId = r!.id;
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('That code is already used by another company.', 'code_taken');
      throw err;
    }
    for (const s of sites) await c.query('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2)', [orgId, s.id]);
    await audit(c, { actorType: 'user', actorId: a.userId, orgId, action: 'partner.created', targetType: 'organization', targetId: orgId, ...meta(req), details: { code, country, sites: codes } });
    return { id: orgId, code, status: 'onboarding' as const };
  });
}

// ---------------------------------------------------------------------------
// Change the code
// ---------------------------------------------------------------------------
export async function changePartnerCode(a: AuthContext, req: FastifyRequest, id: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  if (!COMPANY_CODE_RE.test(code)) throw badRequest('The code must be 2 to 8 letters or digits.', 'invalid_code');
  if (RESERVED_CODES.includes(code)) throw badRequest('That code is reserved for K Line.', 'code_reserved');
  return tx(dbCtx(a), async (c) => {
    const o = await one<any>(c, `SELECT id, code FROM organizations WHERE id = $1 AND kind = 'partner' FOR UPDATE`, [id]);
    if (!o) throw notFound('That partner could not be found.');
    // Case references are built from the code, so it is fixed once the partner has any case (drafts included).
    const cases = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM cases WHERE org_id = $1', [id]);
    if ((cases?.n ?? 0) > 0) throw conflict('This partner already has cases, so the code can no longer be changed.', 'has_cases');
    if (o.code === code) return { code };
    try {
      await c.query('UPDATE organizations SET code = $2, updated_at = now() WHERE id = $1', [id, code]);
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('That code is already used by another company.', 'code_taken');
      throw err;
    }
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.code_changed', targetType: 'organization', targetId: id, ...meta(req), details: { from: o.code, to: code } });
    return { code };
  });
}

// ---------------------------------------------------------------------------
// Activate (approve)
// ---------------------------------------------------------------------------
export async function activatePartner(a: AuthContext, req: FastifyRequest, id: string, load: (c: PoolClient, id: string) => Promise<any>) {
  return tx(dbCtx(a), async (c) => {
    const o = await load(c, id);
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [id]);
    const flags = signupFlags(o.signup);
    if (flags.declined) throw conflict('This registration was declined and can no longer be approved.', 'partner_declined');
    if (!flags.emailConfirmed) throw conflict('The registrant has not confirmed the email address yet.', 'email_not_confirmed');
    if (!o.dpa) throw conflict('A data processing agreement must be on file first.', 'dpa_required');
    const sites = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = $1 AND s.active', [id]);
    if (!sites?.n) throw conflict('Add at least one active production site first.', 'site_required');
    if (!o.logo_file_id) throw conflict('The company needs a logo before it can be approved. Ask the company to add it in its profile.', 'logo_required');
    const first = o.status === 'onboarding';
    await c.query(`UPDATE organizations SET status = 'active', updated_at = now() WHERE id = $1`, [id]);
    if (flags.selfRegistered && first) {
      await c.query(
        `UPDATE organizations SET signup = signup || jsonb_build_object('approved_at', $2::text, 'approved_by', $3::text) WHERE id = $1`,
        [id, new Date().toISOString(), a.userId],
      );
    }
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.activated', targetType: 'organization', targetId: id, ...meta(req), details: { from: o.status, selfRegistered: flags.selfRegistered } });
    if (first) {
      // Fixed text, no names: the company admins hear that they are approved.
      await notifyOrg(c, { orgId: id, kind: 'org_approved', title: 'Your company is approved', body: 'K Line has approved your company. All features are now available.' });
      const admins = await many<{ email: string }>(c, `SELECT email FROM users WHERE org_id = $1 AND 'admin' = ANY(roles) AND status <> 'disabled' AND notify_email ORDER BY email`, [id]);
      for (const u of admins) await queueEmail(c, { to: u.email, template: 'signup_approved', orgId: id, data: { link: `${config.publicUrl}/login` } });
    }
    return { status: 'active' as const };
  });
}

// ---------------------------------------------------------------------------
// Decline
// ---------------------------------------------------------------------------
export async function declinePartner(a: AuthContext, req: FastifyRequest, id: string, reason: string | null) {
  let prefixes: string[] = [];
  const out = await tx(dbCtx(a), async (c) => {
    const o = await one<any>(c, `SELECT id, name, code, status, signup FROM organizations WHERE id = $1 AND kind = 'partner' FOR UPDATE`, [id]);
    if (!o) throw notFound('That partner could not be found.');
    const f = signupFlags(o.signup);
    if (!f.selfRegistered) throw conflict('Only a self registered company that is not approved yet can be declined.', 'not_a_registration');
    if (f.declined) throw conflict('This registration was declined already.', 'already_declined');
    if (o.status !== 'onboarding') throw conflict('This company is already approved. Suspend it instead.', 'not_declinable');

    if (!f.emailConfirmed) {
      // Never confirmed: nobody has agreed to anything and the address may not even belong to the registrant. Delete at once, tell nobody.
      const del = await deleteOrganisation(c, id);
      prefixes = del.prefixes;
      // The entry keeps only the organisation id and code.
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.registration_declined', targetType: 'organization', targetId: id, ...meta(req), details: { code: del.code, confirmed: false, deleted: true } });
      return { status: 'declined' as const, deleted: true, deletesAt: null as string | null };
    }

    const now = new Date();
    await c.query(
      `UPDATE organizations SET signup = signup || jsonb_build_object('declined_at', $2::text, 'declined_by', $3::text, 'decline_reason', $4::text), updated_at = now() WHERE id = $1`,
      [id, now.toISOString(), a.userId, reason],
    );
    const registrant = (o.signup?.email as string | undefined) ?? null;
    await c.query(`UPDATE users SET status = 'disabled', updated_at = now() WHERE org_id = $1`, [id]);
    const users = await many<{ id: string }>(c, 'SELECT id FROM users WHERE org_id = $1', [id]);
    for (const u of users) await revokeUserSessions(c, u.id, 'registration_declined');
    await c.query(`UPDATE user_tokens SET used_at = COALESCE(used_at, now()) WHERE org_id = $1`, [id]);
    if (registrant) await queueEmail(c, { to: registrant, template: 'signup_declined', orgId: id, data: {} });
    const deletesAt = new Date(now.getTime() + DECLINED_RETENTION_DAYS * 86_400_000).toISOString();
    // The reason is internal and stays out of the audit entry as well as out of the email.
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.registration_declined', targetType: 'organization', targetId: id, ...meta(req), details: { code: o.code, confirmed: true, deleted: false, hasReason: !!reason, deletesAt } });
    return { status: 'declined' as const, deleted: false, deletesAt };
  });
  await removeStoredPrefixes(prefixes);
  return out;
}

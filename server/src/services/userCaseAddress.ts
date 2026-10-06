import type { FastifyRequest } from 'fastify';
import { audit } from '../audit';
import { dbCtx, type AuthContext } from '../auth/context';
import { one, tx, type PoolClient } from '../db';
import { badRequest, forbidden, notFound } from '../http/errors';
import { clientIp, userAgent } from '../http/util';
import { CASE_ADDRESS_KEYS, caseAddressView, isCompleteCaseAddress, validateCaseAddress, type CaseAddress } from '../../../shared/caseAddress';

export type CaseAddressSource = 'own' | 'company';

/**
 * The address a direct manufacturing case is sent with: the sender's own address when it is complete, otherwise the company default.
 * `userId` is the person who sent the case (null for partner API keys, which have no person: they always use the company address).
 * Returns null when neither is complete. The user must belong to the organisation, so an id from another company never matches.
 */
export async function resolveCaseAddress(c: PoolClient, orgId: string, userId: string | null): Promise<{ address: CaseAddress; source: CaseAddressSource } | null> {
  const r = await one<{ own: unknown; company: unknown }>(
    c,
    `SELECT u.case_address AS own, o.settings -> 'case_address' AS company
       FROM organizations o LEFT JOIN users u ON u.id = $2 AND u.org_id = o.id
      WHERE o.id = $1`,
    [orgId, userId],
  );
  if (!r) return null;
  return pickCaseAddress(r.own, r.company);
}

/** Pure part of the rule, also used by the push (which already holds both values). */
export function pickCaseAddress(own: unknown, company: unknown): { address: CaseAddress; source: CaseAddressSource } | null {
  if (isCompleteCaseAddress(own)) return { address: own, source: 'own' };
  if (isCompleteCaseAddress(company)) return { address: company, source: 'company' };
  return null;
}

function partnerUser(a: AuthContext): AuthContext {
  if (a.orgKind !== 'partner' || a.kind !== 'user' || !a.userId) throw forbidden('A case address is kept by partner users only.');
  return a;
}

async function loadBoth(c: PoolClient, a: AuthContext) {
  const r = await one<{ own: unknown; company: unknown }>(
    c,
    `SELECT u.case_address AS own, o.settings -> 'case_address' AS company FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1 AND u.org_id = $2`,
    [a.userId, a.orgId],
  );
  if (!r) throw notFound();
  return r;
}

function view(r: { own: unknown; company: unknown }) {
  const ownComplete = isCompleteCaseAddress(r.own);
  const companyComplete = isCompleteCaseAddress(r.company);
  return {
    own: caseAddressView(r.own),
    ownComplete,
    company: caseAddressView(r.company),
    companyComplete,
    effective: (ownComplete ? 'own' : companyComplete ? 'company' : 'none') as 'own' | 'company' | 'none',
  };
}

/** The caller's own address, the company default and which of them a case sent by the caller would use. Never another user's address. */
export async function getUserCaseAddress(a: AuthContext) {
  partnerUser(a);
  return tx(dbCtx(a), async (c) => view(await loadBoth(c, a)));
}

/** Replaces the caller's own address (all nine fields). Audited with the field names only. */
export async function setUserCaseAddress(a: AuthContext, req: FastifyRequest, raw: unknown) {
  partnerUser(a);
  const checked = validateCaseAddress(raw);
  if (!checked.ok) throw badRequest('Some details are missing or not valid.', 'invalid_request', { fields: checked.problems.map((p) => ({ path: p.path, message: p.message })) });
  return tx(dbCtx(a), async (c) => {
    const cur = await loadBoth(c, a);
    const prev = caseAddressView(cur.own);
    const changed = CASE_ADDRESS_KEYS.filter((k) => (prev?.[k] ?? '') !== checked.value[k]);
    await c.query('UPDATE users SET case_address = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2', [a.userId, a.orgId, JSON.stringify(checked.value)]);
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId, ip: clientIp(req), userAgent: userAgent(req), action: 'account.case_address_changed',
      targetType: 'user', targetId: a.userId, details: { changed, removed: false },
    });
    return view({ own: checked.value, company: cur.company });
  });
}

/** Removes the caller's own address, so the company address is used again. Audited. */
export async function clearUserCaseAddress(a: AuthContext, req: FastifyRequest) {
  partnerUser(a);
  return tx(dbCtx(a), async (c) => {
    const cur = await loadBoth(c, a);
    await c.query('UPDATE users SET case_address = NULL, updated_at = now() WHERE id = $1 AND org_id = $2', [a.userId, a.orgId]);
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId, ip: clientIp(req), userAgent: userAgent(req), action: 'account.case_address_changed',
      targetType: 'user', targetId: a.userId, details: { changed: [], removed: true },
    });
    return view({ own: null, company: cur.company });
  });
}

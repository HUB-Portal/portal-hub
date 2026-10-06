import { one, type PoolClient } from '../db';
import { canReceive } from '../../../shared/geo';

// Leaf module of the transfer gate (database and country rules only, no other services), so that every place that needs the gate can import it.
// Enforcement (holding cases) is in transferGate.ts. The rules are explained there.

/** Fixed text shown to the partner when the gate puts a case on hold. It names no site and no person. */
export const TRANSFER_HOLD_REASON = 'Transfer to this site is no longer covered. K Line will contact you.';

/**
 * A Standard Contractual Clauses agreement counts as recorded when it is not withdrawn, has a signature date and has not expired.
 * `valid_until` is the last day it is valid (an empty value means no expiry): an agreement that expired yesterday is treated as not recorded.
 */
export const SCC_VALID_SQL = `type = 'scc' AND revoked_at IS NULL AND signed_at IS NOT NULL AND (valid_until IS NULL OR valid_until >= current_date)`;

export async function sccOnFile(c: PoolClient, orgId: string): Promise<boolean> {
  return !!(await one(c, `SELECT 1 FROM agreements WHERE org_id = $1 AND ${SCC_VALID_SQL} LIMIT 1`, [orgId]));
}

export interface GateSite {
  country: string;
  eea: boolean;
  adequacy: boolean;
}

/**
 * True when the partner's cases may be produced at the site today. The per site flags (`sites.eea`, `sites.adequacy`, editable in the console) are
 * read from the database and combined with the static country lists in shared/geo.ts by canReceive.
 */
export async function siteIsLegal(c: PoolClient, orgId: string, site: GateSite): Promise<boolean> {
  const org = await one<{ country: string | null }>(c, 'SELECT country FROM organizations WHERE id = $1', [orgId]);
  return canReceive(org?.country, site, await sccOnFile(c, orgId));
}

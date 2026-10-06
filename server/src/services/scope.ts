import type { AuthContext } from '../auth/context';
import { notFound } from '../http/errors';

/**
 * Site scope for K Line production staff. A signed in K Line user whose only broad role is `kl_production`
 * and who has site_ids only sees and acts on cases routed to those sites. Returns null when unrestricted.
 * Enforced in the service layer (case list, detail, files, downloads, package, manual stage), not just in the web app.
 */
export function siteScope(a: AuthContext): string[] | null {
  if (a.kind !== 'user' || a.orgKind !== 'kline') return null;
  if (!a.roles.includes('kl_production')) return null;
  if (a.roles.includes('kl_admin') || a.roles.includes('kl_intake')) return null;
  return a.siteIds.length ? a.siteIds : null;
}

/** SQL condition on `c.site_id` for scoped users, or null. `add` pushes a parameter and returns its placeholder. */
export function scopeCondition(a: AuthContext, add: (v: unknown) => string, alias = 'c'): string | null {
  const s = siteScope(a);
  return s ? `${alias}.site_id = ANY(${add(s)}::uuid[])` : null;
}

/** Hides a case that is outside the caller's site scope by answering "not found". */
export function assertInScope(a: AuthContext, row: { site_id?: string | null }): void {
  const s = siteScope(a);
  if (s && (!row.site_id || !s.includes(row.site_id))) throw notFound('That case could not be found.');
}

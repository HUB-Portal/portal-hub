import type { FastifyRequest } from 'fastify';
import { audit } from '../audit';
import { dbCtx, type AuthContext } from '../auth/context';
import { many, one, tx, type PoolClient } from '../db';
import { AppError, forbidden, notFound } from '../http/errors';
import { clientIp, userAgent } from '../http/util';
import { z } from 'zod';
import { MENU_KEYS, MENU_VALUES, type MenuSetting, type MenuValue, type MenuVisible } from '../../../shared/menu';
import { CASE_ADDRESS_REQUIRED_MESSAGE } from '../../../shared/caseAddress';
import { resolveCaseAddress } from './userCaseAddress';
import { storage } from '../storage';


export interface OrgUploadState {
  active: boolean;
  dpaOnFile: boolean;
  /** Uploads stay locked until the partner is active and a Data Processing Agreement is recorded. */
  unlocked: boolean;
}

export async function orgUploadState(c: PoolClient, orgId: string): Promise<OrgUploadState> {
  const r = await c.query(
    `SELECT o.status, o.kind,
            EXISTS (SELECT 1 FROM agreements a WHERE a.org_id = o.id AND a.type = 'dpa' AND a.revoked_at IS NULL
                      AND a.signed_at IS NOT NULL AND (a.valid_until IS NULL OR a.valid_until >= current_date)) AS dpa
       FROM organizations o WHERE o.id = $1`,
    [orgId],
  );
  const row = r.rows[0];
  if (!row) return { active: false, dpaOnFile: false, unlocked: false };
  const active = row.status === 'active';
  return { active, dpaOnFile: row.dpa, unlocked: active && (row.kind === 'kline' || row.dpa) };
}

// ---------------------------------------------------------------------------
// Menu visibility. VISIBILITY ONLY: nothing here changes a role, a permission or a route guard.
// ---------------------------------------------------------------------------
/** The raw setting from `organizations.settings.menu`. A missing or unknown value means `admins`. */
export function menuSettingOf(settings: Record<string, any> | null | undefined): MenuSetting {
  const m = settings?.menu && typeof settings.menu === 'object' ? settings.menu : {};
  const out = {} as MenuSetting;
  for (const k of MENU_KEYS) out[k] = m[k] === 'everyone' ? 'everyone' : 'admins';
  return out;
}

/** What the caller sees in the menu: K Line staff and company administrators see everything, others follow the setting. */
export function menuVisibleFor(a: Pick<AuthContext, 'orgKind' | 'permissions'>, settings: Record<string, any> | null | undefined): MenuVisible {
  const all = a.orgKind === 'kline' || a.permissions.has('org.edit');
  const s = menuSettingOf(settings);
  const out = {} as MenuVisible;
  for (const k of MENU_KEYS) out[k] = all || s[k] === 'everyone';
  return out;
}

export const menuPatchSchema = z
  .object({ claims: z.enum(MENU_VALUES), spec: z.enum(MENU_VALUES), materials: z.enum(MENU_VALUES) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Say which menu item to change.' });
export type MenuPatch = z.infer<typeof menuPatchSchema>;

export async function getMenuSetting(a: AuthContext): Promise<MenuSetting> {
  return tx(dbCtx(a), async (c) => {
    const o = await one<{ settings: Record<string, any> | null }>(c, 'SELECT settings FROM organizations WHERE id = $1', [a.orgId]);
    if (!o) throw notFound();
    return menuSettingOf(o.settings);
  });
}

/** Saves a partial change. Only partner users with `org.edit` (the company administrators) reach this. Audited with the changed keys and values only. */
export async function updateMenuSetting(a: AuthContext, req: FastifyRequest, patch: MenuPatch): Promise<MenuSetting> {
  return tx(dbCtx(a), async (c) => {
    const o = await one<{ settings: Record<string, any> | null }>(c, 'SELECT settings FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
    if (!o) throw notFound();
    const next = { ...menuSettingOf(o.settings), ...patch } as MenuSetting;
    const changed: Record<string, MenuValue> = {};
    for (const k of MENU_KEYS) if (patch[k] !== undefined) changed[k] = patch[k]!;
    await c.query(`UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{menu}', $2::jsonb, true), updated_at = now() WHERE id = $1`, [a.orgId, JSON.stringify(next)]);
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.menu_changed', targetType: 'organization', targetId: a.orgId,
      ip: clientIp(req), userAgent: userAgent(req), details: { changed },
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Approval gate (phase 5)
// ---------------------------------------------------------------------------
export const NOT_APPROVED_MESSAGE = 'This feature unlocks when K Line has approved your company. See the getting started list on your overview.';

/** Partner organisations that K Line has not approved yet cannot use team invites, integrations and similar features. K Line staff are never blocked. */
export function assertApproved(a: Pick<AuthContext, 'orgKind' | 'orgStatus'>): void {
  if (a.orgKind === 'partner' && a.orgStatus !== 'active') throw forbidden(NOT_APPROVED_MESSAGE, 'org_not_approved');
}

/** Integrations (API keys, webhooks) belong to partner companies and are managed by people, never by keys. K Line staff may hold the permission name but have no endpoints. */
export function partnerOnly(a: AuthContext): AuthContext {
  if (a.orgKind !== 'partner' || a.kind !== 'user') throw forbidden('This is managed by partner companies.');
  return a;
}

/** Changes and test calls also need an approved company (`403 org_not_approved` otherwise). Reading stays open. */
export function partnerApproved(a: AuthContext): AuthContext {
  partnerOnly(a);
  assertApproved(a);
  return a;
}

// ---------------------------------------------------------------------------
// Case address gate (phase 8)
// ---------------------------------------------------------------------------
/**
 * Direct manufacturing cases are pushed with the sender's case address (their own when complete, otherwise the company's), so batches and submits
 * learn early (before any upload) that neither exists: 409 case_address_required. `userId` is the person who sends the case; null (partner API key) means the company address.
 */
export async function assertCaseAddress(c: PoolClient, orgId: string, userId: string | null = null): Promise<void> {
  if (!(await resolveCaseAddress(c, orgId, userId))) throw new AppError(409, 'case_address_required', CASE_ADDRESS_REQUIRED_MESSAGE);
}

/** Id of the K Line organisation. */
export async function klineOrgId(c: PoolClient): Promise<string | null> {
  return (await one<{ id: string }>(c, `SELECT id FROM organizations WHERE kind = 'kline' LIMIT 1`))?.id ?? null;
}

/** Active K Line administrators who want email notices. */
export async function klineAdminEmails(c: PoolClient): Promise<string[]> {
  const rows = await many<{ email: string }>(
    c,
    `SELECT u.email FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE o.kind = 'kline' AND u.status = 'active' AND 'kl_admin' = ANY(u.roles) AND u.notify_email ORDER BY u.email`,
  );
  return rows.map((r) => r.email);
}

// ---------------------------------------------------------------------------
// Deleting an organisation
// ---------------------------------------------------------------------------
export interface DeletedOrganisation {
  code: string | null;
  /** Storage prefixes of the organisation's files. Delete them with removeStoredPrefixes once the transaction has committed. */
  prefixes: string[];
}

/**
 * Removes a partner organisation with everything that belongs to it, dependents first so no foreign key is ever violated.
 * Used when K Line declines a registration and by the retention job. It never touches the audit log (entries keep only the
 * organisation id and code). Must run inside a system transaction; the caller writes the audit entry and, after commit,
 * removes the stored objects with removeStoredPrefixes.
 */
export async function deleteOrganisation(c: PoolClient, orgId: string): Promise<DeletedOrganisation> {
  const org = await one<{ id: string; kind: string; code: string | null }>(c, 'SELECT id, kind, code FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  if (!org) return { code: null, prefixes: [] };
  if (org.kind !== 'partner') throw new Error('Only partner organisations can be deleted');
  const files = await many<{ storage_prefix: string | null }>(c, 'SELECT DISTINCT storage_prefix FROM files WHERE org_id = $1 AND storage_prefix IS NOT NULL', [orgId]);
  const del = async (sql: string) => {
    await c.query(sql, [orgId]);
  };
  // Leaves first.
  await del('DELETE FROM email_notice_log WHERE org_id = $1');
  await del('DELETE FROM notifications WHERE org_id = $1');
  await del('DELETE FROM jobs WHERE org_id = $1');
  await del('DELETE FROM sessions WHERE org_id = $1');
  await del('DELETE FROM user_tokens WHERE org_id = $1');
  await c.query('UPDATE organizations SET logo_file_id = NULL WHERE id = $1', [orgId]);
  await del('UPDATE brands SET logo_file_id = NULL WHERE org_id = $1');
  await del('UPDATE agreements SET file_id = NULL WHERE org_id = $1');
  await del('DELETE FROM file_chunks WHERE org_id = $1');
  await del('DELETE FROM files WHERE org_id = $1');
  await del('DELETE FROM material_alerts WHERE org_id = $1');
  await del('DELETE FROM material_movements WHERE org_id = $1');
  await del('DELETE FROM material_shipment_lines WHERE org_id = $1');
  await del('DELETE FROM material_shipments WHERE org_id = $1');
  await del('DELETE FROM materials WHERE org_id = $1');
  await del('UPDATE cases SET parent_id = NULL, claim_id = NULL WHERE org_id = $1');
  await del('UPDATE claims SET rework_case_id = NULL WHERE org_id = $1');
  await del('DELETE FROM claim_messages WHERE org_id = $1');
  await del('DELETE FROM claim_items WHERE org_id = $1');
  await del('DELETE FROM claims WHERE org_id = $1');
  await del('DELETE FROM case_events WHERE org_id = $1');
  await del('DELETE FROM cases WHERE org_id = $1');
  await del('DELETE FROM bulk_batches WHERE org_id = $1');
  await del('DELETE FROM brands WHERE org_id = $1');
  await del('DELETE FROM specs WHERE org_id = $1');
  await del('DELETE FROM agreements WHERE org_id = $1');
  await del('DELETE FROM webhook_deliveries WHERE org_id = $1');
  await del('DELETE FROM webhooks WHERE org_id = $1');
  await del('DELETE FROM api_keys WHERE org_id = $1');
  await del('DELETE FROM org_sites WHERE org_id = $1');
  await del('DELETE FROM users WHERE org_id = $1');
  await del('DELETE FROM organizations WHERE id = $1');
  return { code: org.code, prefixes: files.map((f) => f.storage_prefix!).filter(Boolean) };
}

/** Removes stored objects after the database work has committed. Best effort: the objects cannot be decrypted without the deleted rows. */
export async function removeStoredPrefixes(prefixes: string[]): Promise<void> {
  if (!prefixes.length) return;
  const st = await storage();
  for (const p of prefixes) {
    try {
      await st.deletePrefix(p + '/');
    } catch {
      /* unreachable without the wrapped keys, which are gone with the rows */
    }
  }
}

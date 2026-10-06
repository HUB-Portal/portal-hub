import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { audit } from '../audit';
import { SYSTEM, many, one, tx, type PoolClient } from '../db';
import { sha256Hex } from '../crypto/tokens';
import { codeCandidates, type RegistrationInput } from '../../../shared/signup';
import { defaultSpecContent, hashSpec } from '../../../shared/spec';
import { klineAdminEmails, klineOrgId } from './org';
import { notifyOrg, queueEmail } from './notify';
import { createUserToken } from './userTokens';

/** The answer to every registration request that passed validation, whatever happened behind it. */
export const SIGNUP_ANSWER = {
  ok: true,
  message: 'Thank you. If this email address can be used to register, we have sent it a message with the next steps. Please check your inbox, and your spam folder too.',
} as const;

export const VERIFY_TTL_MINUTES = 48 * 60;
export const MAX_LINKS_PER_HOUR = 3;
export const MAX_LINKS_TOTAL = 5;
export const ATTEMPT_WINDOW_HOURS = 24;

/** Waits until at least `ms` have passed on a monotonic clock, so every outcome takes the same minimum time. */
export async function floorTime(startedNs: bigint, ms: number): Promise<void> {
  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  const left = ms - elapsedMs;
  if (left > 0) await new Promise<void>((r) => setTimeout(r, Math.ceil(left)));
}

const emailKey = (email: string) => sha256Hex(`signup-mail|${email.toLowerCase()}`);

/** Allows one notice of this kind per address and hour. Returns true when the caller may send it. */
async function mayNotify(c: PoolClient, email: string, kind: string): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO signup_mail_log (email_hash, kind, sent_at) VALUES ($1, $2, now())
     ON CONFLICT (email_hash, kind) DO UPDATE SET sent_at = now() WHERE signup_mail_log.sent_at < now() - interval '1 hour'
     RETURNING 1`,
    [emailKey(email), kind],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Claims a once per period slot (job_runs row). True for exactly one caller per period. */
async function claimSlot(c: PoolClient, name: string, period: string): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO job_runs (name, last_run_at, last_status) VALUES ($1, now(), 'ok')
     ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_status = 'ok' WHERE job_runs.last_run_at < now() - $2::interval
     RETURNING name`,
    [name, period],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Notifies every K Line administrator in the app and by email. Fixed text only. */
export async function alertKlineAdmins(c: PoolClient, p: { kind: string; title: string; body: string; template: 'admin_new_signup' | 'admin_signup_ceiling'; data?: Record<string, unknown> }): Promise<void> {
  const kl = await klineOrgId(c);
  if (!kl) return;
  await notifyOrg(c, { orgId: kl, kind: p.kind, title: p.title, body: p.body, data: p.data });
  const link = `${config.publicUrl}/console/partners?tab=review`;
  for (const to of await klineAdminEmails(c)) await queueEmail(c, { to, template: p.template, orgId: kl, data: { link } });
}

/** Records the attempt and says whether the daily ceiling is exceeded. Runs before any look up of the address. */
async function overCeiling(): Promise<boolean> {
  return tx(SYSTEM, async (c) => {
    await c.query('INSERT INTO signup_attempts DEFAULT VALUES');
    const n = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM signup_attempts WHERE at > now() - make_interval(hours => $1)`, [ATTEMPT_WINDOW_HOURS]);
    const over = (n?.n ?? 0) > config.signupDailyLimit;
    if (over && (await claimSlot(c, 'signup_ceiling_alert', '24 hours'))) {
      await alertKlineAdmins(c, {
        kind: 'signup_ceiling',
        title: 'The daily registration limit has been reached',
        body: 'New registrations are not being processed until the count drops again.',
        template: 'admin_signup_ceiling',
      });
      await audit(c, { actorType: 'system', action: 'signup.ceiling_reached', details: { limit: config.signupDailyLimit } });
    }
    return over;
  });
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(6);
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
}

async function freeCode(c: PoolClient, name: string): Promise<string> {
  const candidates = codeCandidates(name);
  const taken = new Set((await many<{ code: string }>(c, 'SELECT code FROM organizations WHERE code = ANY($1::text[])', [candidates])).map((r) => r.code));
  const hit = candidates.find((x) => !taken.has(x));
  if (hit) return hit;
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    if (!(await one(c, 'SELECT 1 AS x FROM organizations WHERE code = $1', [code]))) return code;
  }
  throw new Error('no free company code');
}

async function createRegistration(c: PoolClient, r: RegistrationInput): Promise<void> {
  const code = await freeCode(c, r.companyName);
  const now = new Date().toISOString();
  const signup = {
    at: now,
    email: r.email,
    name: r.personName,
    website: r.website,
    volume: r.volume,
    free_email: r.freeEmail,
    privacy_version: r.privacyVersion,
    authority_accepted_at: now,
    verified_at: null,
  };
  const org = await one<{ id: string }>(
    c,
    `INSERT INTO organizations (kind, name, code, country, status, settings, signup)
     VALUES ('partner', $1, $2, $3, 'onboarding', $4::jsonb, $5::jsonb) RETURNING id`,
    [r.companyName, code, r.country, JSON.stringify({ manual_review: true, require_pts: false, sla_days: 3, case_address: r.caseAddress }), JSON.stringify(signup)],
  );
  const user = await one<{ id: string }>(
    c,
    `INSERT INTO users (org_id, email, name, roles, status) VALUES ($1, $2, $3, ARRAY['admin'], 'invited') RETURNING id`,
    [org!.id, r.email, r.personName],
  );
  const content = defaultSpecContent();
  await c.query(
    `INSERT INTO specs (org_id, version, title, content, content_hash, created_side, status, created_by)
     VALUES ($1, 1, 'Production specification', $2::jsonb, $3, 'partner', 'draft', $4)`,
    [org!.id, JSON.stringify(content), await hashSpec(content), user!.id],
  );
  const token = await createUserToken(c, { orgId: org!.id, userId: user!.id, kind: 'verify', ttlMinutes: VERIFY_TTL_MINUTES });
  await queueEmail(c, { to: r.email, template: 'signup_confirm', orgId: org!.id, data: { link: `${config.publicUrl}/verify?token=${token}` } });
  // No typed text in the audit entry: the reviewer reads the registration in the console.
  await audit(c, { actorType: 'system', orgId: org!.id, action: 'signup.registered', targetType: 'organization', targetId: org!.id, details: { freeEmail: r.freeEmail } });
}

async function handleKnownAddress(c: PoolClient, email: string, existing: any): Promise<void> {
  const su = existing.signup ?? {};
  const selfRegistered = existing.org_kind === 'partner' && !!su.at;
  if (selfRegistered && su.declined_at) {
    if (await mayNotify(c, email, 'declined')) await queueEmail(c, { to: email, template: 'signup_declined', orgId: null, data: {} });
    return;
  }
  const unconfirmed = selfRegistered && !su.verified_at && existing.org_status === 'onboarding' && existing.status === 'invited';
  if (unconfirmed) {
    // A fresh link, never a change to what was stored. At most 3 an hour and 5 in total for this registration.
    const n = await one<{ total: number; recent: number }>(
      c,
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS recent
         FROM user_tokens WHERE user_id = $1 AND kind = 'verify'`,
      [existing.id],
    );
    if ((n?.total ?? 0) < MAX_LINKS_TOTAL && (n?.recent ?? 0) < MAX_LINKS_PER_HOUR) {
      const token = await createUserToken(c, { orgId: existing.org_id, userId: existing.id, kind: 'verify', ttlMinutes: VERIFY_TTL_MINUTES });
      await queueEmail(c, { to: email, template: 'signup_confirm', orgId: existing.org_id, data: { link: `${config.publicUrl}/verify?token=${token}` } });
    }
    return;
  }
  if (await mayNotify(c, email, 'existing')) await queueEmail(c, { to: email, template: 'signup_existing', orgId: null, data: { link: `${config.publicUrl}/login` } });
}

/**
 * Handles one validated registration. The caller answers the same text whatever this does or throws.
 * Every query is scoped by the typed email address or by ids created here: the public route runs as the system role.
 */
export async function processRegistration(input: RegistrationInput): Promise<'ceiling' | 'done'> {
  // The ceiling counts every attempt and is checked before the address is looked at.
  if (await overCeiling()) return 'ceiling';
  for (let attempt = 0; ; attempt++) {
    try {
      await tx(SYSTEM, async (c) => {
        const existing = await one<any>(
          c,
          `SELECT u.id, u.org_id, u.status, o.kind AS org_kind, o.status AS org_status, o.signup
             FROM users u JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = $1`,
          [input.email],
        );
        if (existing) await handleKnownAddress(c, input.email, existing);
        else await createRegistration(c, input);
      });
      return 'done';
    } catch (err: any) {
      // A parallel request created the same address or code first: look again (the address is then known).
      if (err?.code === '23505' && attempt < 3) continue;
      throw err;
    }
  }
}

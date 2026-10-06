import { config } from '../config';
import { SYSTEM, many, one, tx, type PoolClient } from '../db';
import { enqueue, registerJob } from '../jobs';
import { permissionsFor, type Permission } from '../../../shared/roles';
import type { EmailTemplate } from './mail';

/** Queues an email (sent by the worker). Call inside the transaction that caused it. Payload must not hold patient data. */
export function queueEmail(c: PoolClient, p: { to: string; template: EmailTemplate; data: Record<string, unknown>; orgId?: string | null }): Promise<number> {
  return enqueue(c, 'email.send', { to: p.to, template: p.template, data: p.data }, { orgId: p.orgId ?? null });
}

/**
 * In app notification for an organisation (or one user). No patient data in title or body.
 * Kinds that matter by email (see NOTICES) also queue a fixed text email to the people who have email notices on.
 */
export async function notifyOrg(
  c: PoolClient,
  p: { orgId: string; userId?: string | null; kind: string; title: string; body?: string; data?: Record<string, unknown> },
): Promise<void> {
  await c.query('INSERT INTO notifications (org_id, user_id, kind, title, body, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [
    p.orgId,
    p.userId ?? null,
    p.kind,
    p.title,
    p.body ?? null,
    JSON.stringify(p.data ?? {}),
  ]);
  await emailNotice(c, { orgId: p.orgId, userId: p.userId ?? null, kind: p.kind, data: p.data ?? {} });
}

/**
 * In app notification for the K Line organisation, written by a worker job. Partner requests run with row level security
 * limited to their own organisation, so they can neither read nor write K Line rows: the job does it as the system.
 * `partnerOrgId` is the partner the request came from (the job row belongs to it). No patient data in title, body or data.
 */
export function notifyKline(c: PoolClient, partnerOrgId: string, p: { kind: string; title: string; body?: string; data?: Record<string, unknown> }): Promise<number> {
  return enqueue(c, 'notify.push', { target: 'kline', kind: p.kind, title: p.title, body: p.body ?? null, data: p.data ?? {} }, { orgId: partnerOrgId });
}

registerJob('notify.push', async (job) => {
  const { target, kind, title, body, data } = job.payload as { target: string; kind: string; title: string; body: string | null; data: Record<string, unknown> };
  await tx(SYSTEM, async (c) => {
    const orgId = target === 'kline' ? (await one<{ id: string }>(c, `SELECT id FROM organizations WHERE kind = 'kline' LIMIT 1`))?.id : target;
    if (orgId) await notifyOrg(c, { orgId, kind, title, body: body ?? undefined, data });
  });
});

// ---------------------------------------------------------------------------
// Email notices
// ---------------------------------------------------------------------------
/** At most one email per person and subject in this window. Changes inside the window are combined into one email when it ends. */
export const NOTICE_WINDOW_MINUTES = 15;

type Data = Record<string, any>;
interface NoticeSpec {
  /** People need this permission to get the email (the same people who could act on it). */
  permission: Permission;
  /** Skip the email for notifications that are not worth one. */
  when?: (d: Data) => boolean;
  subject: (d: Data) => string;
  /** One fixed sentence. References only: never patient names, file names or anything people typed. */
  line: (d: Data) => string;
  /** Where the link goes, by the recipient's organisation kind. */
  path: (kind: 'kline' | 'partner', d: Data) => string;
  /** Notices with the same key are combined inside the window. */
  key: (d: Data) => string;
}

const ref = (d: Data) => (typeof d.ref === 'string' && d.ref ? d.ref : 'your case');
const caseKey = (d: Data) => `case:${d.caseId}`;
const casePath = (k: 'kline' | 'partner', d: Data) => (k === 'kline' ? `/console/cases/${d.caseId}` : `/portal/cases/${d.caseId}`);
const caseNotice = (subject: (d: Data) => string, line: (d: Data) => string, when?: (d: Data) => boolean): NoticeSpec => ({ permission: 'case.read', when, subject, line, path: casePath, key: caseKey });
const claimNotice: NoticeSpec = {
  permission: 'claim.write',
  subject: (d) => `Update on claim ${d.number ?? ''}`.trim(),
  line: (d) => `There is an update on claim ${d.number ?? ''}${d.ref ? ` for case ${d.ref}` : ''}. Open it in the platform to read it.`.replace(/\s+/g, ' '),
  path: (k, d) => (k === 'kline' ? `/console/claims/${d.claimId}` : `/portal/claims/${d.claimId}`),
  key: (d) => `claim:${d.claimId}`,
};
const specNotice: NoticeSpec = {
  permission: 'spec.sign',
  subject: () => 'A production specification is waiting for your signature',
  line: () => 'A production specification is waiting for your signature. Open it in the platform to read it and sign.',
  path: (k, d) => (k === 'kline' ? `/console/specs/${d.orgId}/${d.specId}` : `/portal/spec/${d.specId}`),
  key: (d) => `spec:${d.specId}`,
};

/** The notification kinds that also go out as email, with their fixed text. */
export const NOTICES: Record<string, NoticeSpec> = {
  // Case stage changes: Submitted to Production, Shipped, Delivered. Later factory stages stay in the bell.
  case_stage: caseNotice((d) => `Case ${ref(d)} is in production`, (d) => `Case ${ref(d)} is now in production at K Line.`, (d) => d.stage === 'received' || d.source === 'portal'),
  case_shipped: caseNotice((d) => `Case ${ref(d)} has shipped`, (d) => `Case ${ref(d)} has shipped. You can see the carrier and tracking number in the platform.`),
  case_delivered: caseNotice((d) => `Case ${ref(d)} was delivered`, (d) => `Case ${ref(d)} was delivered.`),
  case_on_hold: caseNotice((d) => `Case ${ref(d)} is on hold`, (d) => `Case ${ref(d)} has been put on hold. See the reason in the platform.`),
  case_cancelled: caseNotice((d) => `Case ${ref(d)} was cancelled`, (d) => `Case ${ref(d)} was cancelled.`),
  claim_opened: claimNotice,
  claim_status: claimNotice,
  claim_message: claimNotice,
  claim_decision: claimNotice,
  claim_closed: claimNotice,
  spec_proposed: specNotice,
  spec_signed: specNotice,
  material_low_stock: {
    permission: 'material.manage',
    subject: () => 'Materials running low at K Line',
    line: (d) => `A material you supply is running low at the K Line site ${d.siteCode ?? ''}. Open Materials in the platform to see which one. Please send more soon.`.replace(/\s+/g, ' '),
    path: () => '/portal/materials',
    key: (d) => `material:${d.materialId ?? 'any'}:${d.siteCode ?? ''}`,
  },
  webhook_disabled: {
    permission: 'integration.manage',
    subject: () => 'A webhook was switched off',
    line: () => 'One of your webhook endpoints failed 25 times in a row and was switched off. Check the endpoint, then switch it back on under ERP and API.',
    path: () => '/portal/integrations',
    key: (d) => `webhook:${d.webhookId}`,
  },
};

function compose(spec: NoticeSpec, d: Data, name: string, kind: 'kline' | 'partner'): { subject: string; text: string } {
  const home = kind === 'kline' ? '/console' : '/portal';
  return {
    subject: spec.subject(d),
    text: [
      `Hello ${name || 'there'},`,
      '',
      spec.line(d),
      '',
      'Open it here:',
      config.publicUrl + spec.path(kind, d),
      '',
      'You can switch these emails off in your account settings:',
      `${config.publicUrl}${home}/account`,
      '',
      `Questions? Write to ${config.supportEmail}.`,
    ].join('\n'),
  };
}

/**
 * Queues the fixed text email for one notification to everyone it is meant for who has email notices on.
 * Inside the window the email is held back and combined (the latest one is sent when the window ends).
 */
async function emailNotice(c: PoolClient, n: { orgId: string; userId: string | null; kind: string; data: Data }): Promise<void> {
  const spec = NOTICES[n.kind];
  if (!spec || (spec.when && !spec.when(n.data))) return;
  const users = await many<{ id: string; email: string; name: string; roles: string[]; org_kind: 'kline' | 'partner' }>(
    c,
    `SELECT u.id, u.email, u.name, u.roles, o.kind AS org_kind FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE u.org_id = $1 AND u.status = 'active' AND u.notify_email AND ($2::uuid IS NULL OR u.id = $2) ORDER BY u.email`,
    [n.orgId, n.userId],
  );
  for (const u of users) {
    if (!permissionsFor(u.roles).has(spec.permission)) continue;
    const mail = compose(spec, n.data, u.name, u.org_kind);
    await sendOrCombine(c, { userId: u.id, orgId: n.orgId, key: spec.key(n.data), to: u.email, mail });
  }
}

/** Sends now when the window is free; otherwise keeps the newest notice for the job that closes the window. */
export async function sendOrCombine(
  c: PoolClient,
  p: { userId: string; orgId: string; key: string; to: string; mail: { subject: string; text: string } },
): Promise<'sent' | 'combined'> {
  const fresh = await c.query(
    `INSERT INTO email_notice_log (user_id, dedupe_key, org_id, sent_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, dedupe_key) DO UPDATE SET sent_at = now(), pending = NULL, org_id = EXCLUDED.org_id
       WHERE email_notice_log.sent_at <= now() - make_interval(mins => $4)
     RETURNING 1`,
    [p.userId, p.key, p.orgId, NOTICE_WINDOW_MINUTES],
  );
  if (fresh.rowCount) {
    await queueEmail(c, { to: p.to, template: 'notice', orgId: p.orgId, data: p.mail });
    return 'sent';
  }
  const row = await one<{ had_pending: boolean; window_end: Date }>(
    c,
    `SELECT pending IS NOT NULL AS had_pending, sent_at + make_interval(mins => $3) AS window_end FROM email_notice_log WHERE user_id = $1 AND dedupe_key = $2 FOR UPDATE`,
    [p.userId, p.key, NOTICE_WINDOW_MINUTES],
  );
  if (!row) return 'combined';
  await c.query(`UPDATE email_notice_log SET pending = $3::jsonb WHERE user_id = $1 AND dedupe_key = $2`, [p.userId, p.key, JSON.stringify(p.mail)]);
  // One closing job per window, however many notices arrive.
  if (!row.had_pending) await enqueue(c, 'notice.flush', { userId: p.userId, key: p.key }, { orgId: p.orgId, runAt: new Date(row.window_end.getTime() + 2000), maxAttempts: 3 });
  return 'combined';
}

registerJob('notice.flush', async (job) => {
  const { userId, key } = job.payload as { userId: string; key: string };
  await tx(SYSTEM, async (c) => {
    const row = await one<{ pending: { subject: string; text: string } | null; org_id: string; open: boolean; email: string; status: string; notify_email: boolean; window_end: Date }>(
      c,
      `SELECT l.pending, l.org_id, l.sent_at + make_interval(mins => $3) > now() AS open, l.sent_at + make_interval(mins => $3) AS window_end, u.email, u.status, u.notify_email
         FROM email_notice_log l JOIN users u ON u.id = l.user_id WHERE l.user_id = $1 AND l.dedupe_key = $2 FOR UPDATE OF l`,
      [userId, key, NOTICE_WINDOW_MINUTES],
    );
    if (!row || !row.pending) return;
    if (row.open) {
      // Woken early: try again when the window really ends.
      await enqueue(c, 'notice.flush', { userId, key }, { orgId: row.org_id, runAt: new Date(row.window_end.getTime() + 2000), maxAttempts: 3 });
      return;
    }
    if (row.status === 'active' && row.notify_email) {
      await queueEmail(c, { to: row.email, template: 'notice', orgId: row.org_id, data: row.pending });
      await c.query(`UPDATE email_notice_log SET sent_at = now(), pending = NULL WHERE user_id = $1 AND dedupe_key = $2`, [userId, key]);
    } else {
      await c.query(`UPDATE email_notice_log SET pending = NULL WHERE user_id = $1 AND dedupe_key = $2`, [userId, key]);
    }
  });
});

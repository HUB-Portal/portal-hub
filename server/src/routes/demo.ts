import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { SYSTEM, many, tx } from '../db';
import { sha256Hex } from '../crypto/tokens';
import { SIGNUP_CONFIRM_SUBJECT } from '../services/mail';
import { notFound } from '../http/errors';
import { demoAllowed } from '../http/proxy';
import { DEMO_PASSWORD, demoCurrentCode, isDemoEmail } from '../services/demo';
import { buildSampleCases, sampleCasesZip } from '../demo/assets';

/**
 * Development conveniences. Not available in production (config refuses DEMO_MODE there). Every route also answers 404 when the request
 * carries proxy or tunnel headers or does not come from a loopback or private address: demo data is for direct local use only.
 */
export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/demo/accounts', async (req) => {
    if (!demoAllowed(req)) throw notFound();
    const rows = await tx(SYSTEM, (c) =>
      many<any>(
        c,
        `SELECT u.email, u.name, u.roles, o.name AS org_name, o.kind AS org_kind
           FROM users u JOIN organizations o ON o.id = u.org_id
          WHERE u.email ILIKE '%.demo' AND u.status <> 'disabled' ORDER BY o.kind, o.name, u.email`,
      ),
    );
    return {
      password: DEMO_PASSWORD,
      accounts: rows
        .filter((r) => isDemoEmail(r.email))
        .map((r) => ({ email: r.email, name: r.name, roles: r.roles, orgName: r.org_name, orgKind: r.org_kind, ...(demoCurrentCode(r.email) ?? {}) })),
    };
  });

  /**
   * Demo mode only, no sign in: a zip with four fictional cases (arch folders with a Word file and a PDF plan, flat files with a text file,
   * a patient named folder with an RTF file, and a case with an open trim line). Fresh case numbers on every download.
   */
  app.get('/api/demo/sample-cases.zip', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!demoAllowed(req)) throw notFound();
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="sample-cases.zip"')
      .header('x-content-type-options', 'nosniff');
    return reply.send(sampleCasesZip(buildSampleCases()));
  });

  app.get('/api/demo/mailbox', async (req) => {
    if (!demoAllowed(req)) throw notFound();
    const rows = await tx(SYSTEM, (c) => many<any>(c, 'SELECT id, to_addr, subject, body, created_at FROM dev_mailbox ORDER BY created_at DESC LIMIT 20'));
    return { messages: rows.map((r) => ({ id: r.id, to: r.to_addr, subject: r.subject, body: r.body, createdAt: r.created_at })) };
  });

  /**
   * Demo mode only: confirmation links of registrations that are still waiting for the email to be confirmed, so the web app can show
   * them on screen (there is no real mailbox). Read from the development mailbox; a link is listed only while its token is still live.
   */
  app.get('/api/demo/registrations', async (req) => {
    if (!demoAllowed(req)) throw notFound();
    const rows = await tx(SYSTEM, (c) =>
      many<any>(c, 'SELECT to_addr, body, created_at FROM dev_mailbox WHERE subject = $1 ORDER BY created_at DESC LIMIT 50', [SIGNUP_CONFIRM_SUBJECT]),
    );
    const items: { email: string; link: string; path: string; sentAt: string; expiresAt: string }[] = [];
    for (const r of rows) {
      const m = /\/verify\?token=([A-Za-z0-9_-]{10,200})/.exec(String(r.body));
      if (!m) continue;
      const live = await tx(SYSTEM, (c) =>
        many<any>(c, `SELECT expires_at FROM user_tokens WHERE token_hash = $1 AND kind = 'verify' AND used_at IS NULL AND expires_at > now()`, [sha256Hex(m[1]!)]),
      );
      if (!live[0]) continue;
      items.push({ email: r.to_addr, link: `${config.publicUrl}/verify?token=${m[1]}`, path: `/verify?token=${m[1]}`, sentAt: new Date(r.created_at).toISOString(), expiresAt: new Date(live[0].expires_at).toISOString() });
    }
    return { items };
  });
}

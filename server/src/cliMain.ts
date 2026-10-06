import { config } from './config';
import { migrate } from './db/migrate';
import { closePools, ownerPool, SYSTEM, tx } from './db';
import { audit } from './audit';
import { seedDemo } from './demo/seed';
import { createUserToken } from './services/userTokens';
import { DEMO_PASSWORD, demoCurrentCode, isDemoEmail } from './services/demo';
import { runRetention } from './services/retention';
import { runPortalSync } from './services/portalSync';
import { REWRAP_KINDS, rewrapAll, type RewrapKind } from './services/rewrap';
import { CLI_USAGE } from './cliUsage';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'migrate': {
      if (!config.databaseOwnerUrl) throw new Error('DATABASE_OWNER_URL is required for migrations');
      const applied = await migrate({ ownerUrl: config.databaseOwnerUrl, appUrl: config.databaseUrl, log: (m) => console.log(m) });
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
      return 0;
    }
    case 'seed': {
      const r = await seedDemo({ force: args.includes('--force'), withCases: true });
      console.log(`Demo data created (${r.users} users, 18 sample cases with real small files, two claims, and a factory system key and a partner API key in server/data/demo-keys.txt). Demo password: Demo2026PartnerHub.`);
      return 0;
    }
    case 'create-admin': {
      const email = flag(args, 'email')?.trim().toLowerCase();
      const name = flag(args, 'name')?.trim();
      const google = args.includes('--google');
      if (!email || !name) throw new Error('--email and --name are required');
      if (google) {
        if (!config.oidc.allowedDomain) throw new Error('Set OIDC_ALLOWED_DOMAIN first: Google sign in is only for accounts in your Workspace domain.');
        if (!email.endsWith(`@${config.oidc.allowedDomain}`)) throw new Error(`The email address must end with @${config.oidc.allowedDomain} for Google sign in.`);
      }
      const link = await tx(SYSTEM, async (c) => {
        const org = await c.query(`SELECT id FROM organizations WHERE kind = 'kline'`);
        let orgId: string = org.rows[0]?.id;
        if (!orgId) {
          const r = await c.query(`INSERT INTO organizations (kind, name, code, legal_name, country, status) VALUES ('kline', 'K Line Europe GmbH', 'KLINE', 'K Line Europe GmbH', 'DE', 'active') RETURNING id`);
          orgId = r.rows[0].id;
        }
        const u = await c.query(`INSERT INTO users (org_id, email, name, roles, status, auth_provider) VALUES ($1, $2, $3, '{kl_admin}', 'invited', $4) RETURNING id`, [orgId, email, name, google ? 'google' : 'local']);
        await audit(c, { actorType: 'system', orgId, action: 'cli.admin_created', targetType: 'user', targetId: u.rows[0].id, details: { provider: google ? 'google' : 'local' } });
        if (google) return null;
        const token = await createUserToken(c, { orgId, userId: u.rows[0].id, kind: 'invite', ttlMinutes: 7 * 24 * 60 });
        return `${config.publicUrl}/invite/${token}`;
      });
      if (link) {
        console.log('Administrator created. Give this one time link to them (valid for 7 days):');
        console.log(link);
      } else {
        console.log('Administrator created. They sign in with "Sign in with Google" on the sign in page, then set up their authenticator app.');
        if (!config.oidc.googleEnabled) console.log('Note: Google sign in is not switched on yet (OIDC_GOOGLE_CLIENT_ID and OIDC_GOOGLE_CLIENT_SECRET).');
      }
      return 0;
    }
    case 'demo-accounts': {
      // The sign in page lists these only for direct local use. Behind a forwarded URL (a Codespace) it is hidden, so print them here.
      if (!config.demoMode) throw new Error('DEMO_MODE is off, so there are no demo accounts to show.');
      const rows = await tx(SYSTEM, (c) => c.query(`SELECT email, roles FROM users WHERE email ILIKE '%.demo' AND status <> 'disabled' ORDER BY email`));
      console.log(`Demo password for every account: ${DEMO_PASSWORD}`);
      console.log('The authenticator code changes every 30 seconds; run this command again for a fresh one.\n');
      for (const r of rows.rows) {
        if (!isDemoEmail(r.email)) continue;
        const c = demoCurrentCode(r.email);
        console.log(`${String(r.email).padEnd(24)} ${String((r.roles as string[]).join(',')).padEnd(16)} code ${c?.code ?? '------'} (${c?.secondsLeft ?? 0}s left)`);
      }
      return 0;
    }
    case 'audit-verify': {
      const r = await ownerPool().query('SELECT * FROM kph_audit_verify()');
      const row = r.rows[0];
      if (row.ok) {
        console.log(`Audit chain OK (${row.checked} entries checked).`);
        return 0;
      }
      console.error(`Audit chain BROKEN near sequence ${row.first_bad_seq} after ${row.checked} good entries.`);
      return 1;
    }
    case 'audit-trim': {
      const months = Number(flag(args, 'months') ?? config.auditRetentionMonths);
      if (!Number.isInteger(months) || months < 1) throw new Error('--months must be a whole number of at least 1');
      const r = await ownerPool().query(`SELECT kph_audit_trim(now() - make_interval(months => $1)) AS n`, [months]);
      console.log(`Removed ${r.rows[0].n} audit entries older than ${months} months. The chain anchor was moved so verification still passes.`);
      return 0;
    }
    case 'retention': {
      const r = await runRetention();
      console.log(`Retention finished: ${r.casesPurged} case(s) purged, ${r.draftsDeleted} old draft(s) deleted, ${r.abandonedUploads} abandoned upload(s) removed, ${r.orphanObjectsRemoved} leftover object(s) cleared.`);
      console.log(`Records removed: sessions ${r.sessions}, user tokens ${r.userTokens}, sign in flows ${r.oidcFlows}, notifications ${r.notifications}, factory events ${r.mesEvents}, dev mailbox ${r.devMailbox}, jobs ${r.jobs}, webhook deliveries ${r.webhookDeliveries}.`);
      console.log(`Also: ${r.casesScrubbed} earlier purged case(s) scrubbed, ${r.transfersHeld} case(s) put on hold because the transfer is no longer covered, ${r.emailJobsScrubbed} old email job(s) wiped.`);
      return 0;
    }
    case 'portal-sync': {
      const r = await runPortalSync();
      console.log(`Portal sync finished: ${r.checked} case(s) checked, ${r.changed} changed, ${r.failed} failed, ${r.skipped} skipped (demo only).`);
      return 0;
    }
    case 'rewrap': {
      const onlyArg = flag(args, 'only');
      const only = onlyArg ? (onlyArg.split(',').map((x) => x.trim()).filter(Boolean) as RewrapKind[]) : undefined;
      const bad = only?.filter((k) => !(REWRAP_KINDS as readonly string[]).includes(k));
      if (bad?.length) throw new Error(`Unknown kind: ${bad.join(', ')}. Choose from: ${REWRAP_KINDS.join(', ')}.`);
      const batch = flag(args, 'batch') ? Number(flag(args, 'batch')) : undefined;
      if (batch !== undefined && (!Number.isInteger(batch) || batch < 1)) throw new Error('--batch must be a whole number of at least 1');
      const report = await rewrapAll({ dryRun: args.includes('--dry-run'), only, batchSize: batch, log: (l) => console.log(l) });
      console.log('');
      console.log(report.dryRun ? 'Dry run finished. Nothing was changed.' : 'Re-wrap finished.');
      for (const k of report.kinds) {
        console.log(`  ${k.kind.padEnd(14)} ${String(k.rewrapped).padStart(7)} ${report.dryRun ? 'to do' : 'done'}, ${String(k.legacyEncrypted).padStart(5)} plaintext, ${String(k.alreadyCurrent).padStart(7)} current, ${k.failed} failed`);
        for (const [keyId, n] of Object.entries(k.failedByKey)) {
          console.log(`      ${n} row(s) still use "${keyId}" and could not be read${config.masterKeys[keyId] ? '' : ' (that key is not in MASTER_KEYS: add it back and run again)'}`);
        }
      }
      for (const v of report.verify) console.log(`  check ${v.kind.padEnd(14)} ${v.ok}/${v.sampled} sampled rows open with the active key only${v.skipped ? `, ${v.skipped} stored object(s) not found` : ''}${v.stillOld ? `, ${v.stillOld} row(s) still use an older key` : ''}`);
      if (report.blindIndexChanged) console.log('  The blind index key changed, so the search indexes were rebuilt.');
      if (!report.dryRun && report.ok) console.log(`Everything uses "${report.activeKeyId}". Older keys can be removed from MASTER_KEYS once you have a verified backup made after this run.`);
      return report.ok ? 0 : 1;
    }
    default:
      console.log(CLI_USAGE);
      return cmd ? 1 : 0;
  }
}

main()
  .then(async (code) => {
    await closePools();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closePools().catch(() => {});
    process.exit(1);
  });

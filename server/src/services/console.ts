import type { AuthContext } from '../auth/context';
import { many, one, tx, type DbCtx } from '../db';
import { scopeCondition, siteScope } from './scope';

const DPA_SQL = `EXISTS (SELECT 1 FROM agreements a WHERE a.org_id = o.id AND a.type = 'dpa' AND a.revoked_at IS NULL AND a.signed_at IS NOT NULL AND (a.valid_until IS NULL OR a.valid_until >= current_date))`;
const SCC_SQL = `EXISTS (SELECT 1 FROM agreements a WHERE a.org_id = o.id AND a.type = 'scc' AND a.revoked_at IS NULL AND a.signed_at IS NOT NULL AND (a.valid_until IS NULL OR a.valid_until >= current_date))`;
export { DPA_SQL, SCC_SQL };

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);

/** Tiles for the K Line console. Production staff tied to sites only count cases at their sites. */
export async function consoleOverview(ctx: DbCtx, a: AuthContext) {
  return tx(ctx, async (c) => {
    const p: unknown[] = [];
    const sc = scopeCondition(a, (v) => {
      p.push(v);
      return '$1';
    });
    const and = sc ? ` AND ${sc}` : '';
    const scoped = !!siteScope(a);
    const n = async (sql: string) => (await one<{ n: number }>(c, sql, p))?.n ?? 0;

    const intakeWaiting = await n(`SELECT count(*)::int AS n FROM cases c WHERE c.status = 'submitted'${and}`);
    const ready = await one<{ total: number; late: number }>(
      c,
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.ready_at < now() - interval '4 hours')::int AS late FROM cases c WHERE c.status = 'ready'${and}`,
      p,
    );
    const inProduction = await n(`SELECT count(*)::int AS n FROM cases c WHERE c.status IN ('received', 'in_production')${and}`);
    const shipped7 = await n(`SELECT count(*)::int AS n FROM cases c WHERE c.status IN ('shipped', 'delivered') AND c.shipped_at >= now() - interval '7 days'${and}`);
    const late = await n(`SELECT count(*)::int AS n FROM cases c WHERE c.due_date < current_date AND c.status IN ('submitted', 'on_hold', 'ready', 'received', 'in_production')${and}`);

    const openClaims = await n(`SELECT count(*)::int AS n FROM claims cl JOIN cases c ON c.id = cl.case_id WHERE cl.status IN ('open', 'in_review', 'awaiting_partner')${and}`);

    const siteRows = await many<any>(
      c,
      `SELECT s.code, s.name,
              count(c.id) FILTER (WHERE c.status = 'ready')::int AS ready,
              count(c.id) FILTER (WHERE c.status IN ('received', 'in_production'))::int AS in_production
         FROM sites s LEFT JOIN cases c ON c.site_id = s.id AND c.status IN ('ready', 'received', 'in_production')
        WHERE s.active ${scoped ? 'AND s.id = ANY($1::uuid[])' : ''}
        GROUP BY s.id ORDER BY s.code`,
      p,
    );

    const mes = await one<any>(
      c,
      `SELECT max(received_at) AS last_at,
              count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS events,
              count(*) FILTER (WHERE received_at > now() - interval '24 hours' AND outcome = 'error')::int AS errors
         FROM mes_events`,
    );
    const sec = await one<any>(
      c,
      `SELECT count(*) FILTER (WHERE action = 'auth.login_failed')::int AS failed, count(*) FILTER (WHERE action = 'file.infected')::int AS malware
         FROM audit_log WHERE at > now() - interval '24 hours' AND action IN ('auth.login_failed', 'file.infected')`,
    );
    const partners = scoped
      ? []
      : await many<any>(
          c,
          `SELECT o.id, o.name, o.code, o.status, o.country, ${DPA_SQL} AS dpa, ${SCC_SQL} AS scc,
                  COALESCE((SELECT array_agg(s.code ORDER BY s.code) FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = o.id), '{}') AS site_codes
             FROM organizations o WHERE o.kind = 'partner' ORDER BY lower(o.name)`,
        );
    // Companies that confirmed their email address and wait for K Line to review them.
    const newSignups = scoped
      ? 0
      : ((await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM organizations WHERE kind = 'partner' AND status = 'onboarding' AND signup ? 'at' AND (signup->>'verified_at') IS NOT NULL AND NOT (signup ? 'declined_at')`))?.n ?? 0);
    return {
      intakeWaiting,
      readyForMes: { count: ready?.total ?? 0, waitingOver4h: ready?.late ?? 0 },
      inProduction,
      shippedLast7Days: shipped7,
      openClaims,
      lateCases: late,
      siteLoad: siteRows.map((s) => ({ siteCode: s.code, name: s.name, ready: s.ready, inProduction: s.in_production })),
      mesHealth: { lastEventAt: iso(mes?.last_at), events24h: mes?.events ?? 0, errors24h: mes?.errors ?? 0 },
      security: { failedSignIns24h: sec?.failed ?? 0, malwareFiles24h: sec?.malware ?? 0 },
      partners: partners.map((o) => ({ id: o.id, name: o.name, code: o.code, status: o.status, country: o.country, dpaOnFile: o.dpa, sccOnFile: o.scc, siteCodes: o.site_codes })),
      newSignups,
    };
  });
}

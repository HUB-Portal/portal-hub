import pg from 'pg';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface MigrateOptions {
  ownerUrl: string;
  appUrl: string;
  log?: (msg: string) => void;
}

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../migrations', '../migrations']) {
    const p = path.resolve(here, rel);
    if (existsSync(p)) return p;
  }
  throw new Error('migrations directory not found');
}

/** Creates or updates the restricted app role. It owns nothing and cannot bypass row level security. */
async function ensureAppRole(c: pg.Client, appUrl: string): Promise<string> {
  const u = new URL(appUrl);
  const role = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('Invalid app role name');
  if (password.length < 16) throw new Error('The app role password must be at least 16 characters');
  const owner = (await c.query('SELECT current_user AS u')).rows[0].u as string;
  if (role === owner) throw new Error('The app role must differ from the owner role');
  const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount! > 0;
  // A role that already carries only the restricted attributes needs just its password set. An owner that is not a superuser
  // (managed hosts such as Neon) is not allowed to restate SUPERUSER, REPLICATION or BYPASSRLS, even as NO... values.
  const current = exists
    ? (await c.query(
        'SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [role],
      )).rows[0]
    : undefined;
  const alreadyRestricted = !!current && current.rolcanlogin && !current.rolsuper && !current.rolcreatedb && !current.rolcreaterole
    && !current.rolreplication && !current.rolbypassrls;
  const stmt = (await c.query(
    alreadyRestricted
      ? `SELECT format('%s ROLE %I PASSWORD %L', $1::text, $2::text, $3::text) AS s`
      : `SELECT format('%s ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text, $3::text) AS s`,
    [exists ? 'ALTER' : 'CREATE', role, password],
  )).rows[0].s as string;
  await c.query(stmt);
  await c.query(`SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS s`, [role]).then((r) => c.query(r.rows[0].s));
  await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await c.query(`GRANT USAGE ON SCHEMA public TO ${pg.escapeIdentifier(role)}`);
  return role;
}

/** Grants to the app role: full DML on everything except the audit tables, SELECT only on audit_log. */
async function applyGrants(c: pg.Client, role: string): Promise<void> {
  const r = pg.escapeIdentifier(role);
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`);
  await c.query(`REVOKE ALL ON audit_log, audit_anchor, schema_migrations FROM ${r}`);
  await c.query(`GRANT SELECT ON audit_log TO ${r}`);
  await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`);
  await c.query(`GRANT EXECUTE ON FUNCTION kph_audit_append(text, text, uuid, text, text, text, text, text, jsonb) TO ${r}`);
  await c.query(`GRANT EXECUTE ON FUNCTION kph_next_counter(text) TO ${r}`);
}

export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const c = new pg.Client({ connectionString: opts.ownerUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    // FORCE ROW LEVEL SECURITY applies to the owner too unless the owner is a superuser (managed hosts such as Neon give none),
    // so the migrations switch the bypass flag on for this connection only, like the app does for its own system work.
    await c.query("SELECT set_config('kph.bypass', 'true', false)");
    const role = await ensureAppRole(c, opts.appUrl);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((x) => x.name as string));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      log(`applying ${f}`);
      const sql = readFileSync(path.join(dir, f), 'utf8');
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
      applied.push(f);
    }
    await applyGrants(c, role);
    await c.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    await c.end();
  }
  return applied;
}

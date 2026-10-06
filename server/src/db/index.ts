import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from '../config';

// int8 -> number, numeric -> number, date -> plain YYYY-MM-DD string.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1016 as any, (v) => (v ? v.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number) : []));
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(1231 as any, (v) => (v ? v.replace(/[{}]/g, '').split(',').filter(Boolean).map(parseFloat) : []));
pg.types.setTypeParser(1082, (v) => v);

export type { PoolClient };

/** Row level security context. K Line users bypass; partners run with their own org id. */
export interface DbCtx {
  orgId: string | null;
  bypass: boolean;
}
export const SYSTEM: DbCtx = { orgId: null, bypass: true };

let appPool: pg.Pool | undefined;
let ownerPoolInstance: pg.Pool | undefined;

function makePool(url: string, max: number): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max, statement_timeout: 60_000, idle_in_transaction_session_timeout: 120_000 });
  p.on('error', () => {
    /* idle client errors are handled by the pool reconnecting */
  });
  return p;
}

/** Pool for the restricted kph_app role (row level security applies). */
export function pool(): pg.Pool {
  return (appPool ??= makePool(config.databaseUrl, 10));
}

/** Pool for kph_owner. Only for migrations, CLI maintenance and audit verification. */
export function ownerPool(): pg.Pool {
  if (!config.databaseOwnerUrl) throw new Error('DATABASE_OWNER_URL is not configured');
  return (ownerPoolInstance ??= makePool(config.databaseOwnerUrl, 2));
}

export async function closePools(): Promise<void> {
  const a = appPool;
  const o = ownerPoolInstance;
  appPool = undefined;
  ownerPoolInstance = undefined;
  await Promise.all([a?.end(), o?.end()]);
}

/** Runs fn in one transaction with the RLS context set first. Every DB access goes through this. */
export async function tx<T>(ctx: DbCtx, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('kph.org_id', $1, true), set_config('kph.bypass', $2, true)", [
      ctx.orgId ?? '',
      ctx.bypass ? 'true' : 'false',
    ]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* connection is broken; release below discards it */
    }
    throw err;
  } finally {
    c.release();
  }
}

/** Convenience: first row or undefined. */
export async function one<T = Record<string, any>>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await c.query(sql, params);
  return r.rows[0] as T | undefined;
}
/** Convenience: all rows. */
export async function many<T = Record<string, any>>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params);
  return r.rows as T[];
}

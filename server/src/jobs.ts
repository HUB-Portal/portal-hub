import type { PoolClient } from './db';

export interface JobRow {
  id: number;
  kind: string;
  payload: any;
  org_id: string | null;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: JobRow) => Promise<void>;

const registry = new Map<string, JobHandler>();

/** Registers the handler for a job kind. Handlers run under SYSTEM and must open their own tx(SYSTEM, ...). */
export function registerJob(kind: string, handler: JobHandler): void {
  registry.set(kind, handler);
}
export function getJobHandler(kind: string): JobHandler | undefined {
  return registry.get(kind);
}
export function registeredJobKinds(): string[] {
  return [...registry.keys()];
}

/**
 * Job kinds whose payload is wiped as soon as the job is finished, whether it succeeded or failed for good (it may hold one time links
 * and addresses). Retries keep the payload until the last attempt. The retention job also wipes any such job older than 24 hours.
 */
export const SCRUB_PAYLOAD_KINDS = new Set(['email.send']);

/**
 * Adds a job inside the caller's transaction, so it is queued only if the surrounding work commits.
 * Never put patient data in a payload; reference ids instead.
 */
export async function enqueue(
  c: PoolClient,
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { orgId?: string | null; runAt?: Date; maxAttempts?: number } = {},
): Promise<number> {
  const r = await c.query(
    `INSERT INTO jobs (kind, payload, org_id, run_at, max_attempts) VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), $5) RETURNING id`,
    [kind, JSON.stringify(payload), opts.orgId ?? null, opts.runAt ?? null, opts.maxAttempts ?? 6],
  );
  return r.rows[0].id as number;
}

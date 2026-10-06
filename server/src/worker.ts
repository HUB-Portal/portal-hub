import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { SYSTEM, tx, closePools } from './db';
import { getJobHandler, SCRUB_PAYLOAD_KINDS, type JobRow } from './jobs';
import './handlers';
import { claimDailyRetention } from './services/retention';
import { claimPortalSync } from './services/portalSync';
import { sweepDueDeliveries } from './services/webhookDelivery';
import { enqueue } from './jobs';

export { registerJob } from './jobs';
export { enqueue };
export type { JobHandler, JobRow } from './jobs';

const WORKER_ID = `${hostname()}:${process.pid}`;
const STALE_MINUTES = 10;

/** Claims the next due job (FOR UPDATE SKIP LOCKED) and marks it running. */
async function claim(): Promise<JobRow | null> {
  return tx(SYSTEM, async (c) => {
    await c.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
        WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`,
      [STALE_MINUTES],
    );
    const r = await c.query(
      `SELECT id, kind, payload, org_id, attempts, max_attempts FROM jobs
        WHERE status = 'queued' AND run_at <= now()
        ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const job = r.rows[0] as JobRow | undefined;
    if (!job) return null;
    await c.query(`UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1 WHERE id = $1`, [job.id, WORKER_ID]);
    return { ...job, attempts: job.attempts + 1 };
  });
}

/** Backoff: 30 s, 1 min, 2 min, 4 min ... capped at one hour. */
export function backoffSeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

/** Fixed error text for job kinds whose payload can hold addresses or one time links. Nothing from the provider's answer is kept. */
export const FIXED_JOB_ERRORS: Record<string, string> = { 'email.send': 'The email could not be sent.' };

/**
 * Short error text for the jobs table. It never holds an email address or a link: those are removed from every message,
 * and the kinds in SCRUB_PAYLOAD_KINDS keep a fixed sentence (plus a numeric SMTP code when the server gave one).
 */
export function safeJobError(kind: string, err: unknown): string {
  if (SCRUB_PAYLOAD_KINDS.has(kind)) {
    const base = FIXED_JOB_ERRORS[kind] ?? 'The job failed.';
    const code = typeof (err as any)?.responseCode === 'number' ? (err as any).responseCode : null;
    return code && code >= 100 && code <= 599 ? `${base.replace(/\.$/, '')} (code ${code}).` : base;
  }
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[address removed]')
    .slice(0, 300);
}

async function finish(job: JobRow, err: unknown): Promise<void> {
  await tx(SYSTEM, async (c) => {
    if (!err) {
      if (SCRUB_PAYLOAD_KINDS.has(job.kind)) {
        await c.query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, payload = '{}'::jsonb, last_error = NULL WHERE id = $1`, [job.id]);
      } else {
        await c.query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [job.id]);
      }
      return;
    }
    // Error text is kept short and is never expected to hold patient data, addresses or links.
    const msg = safeJobError(job.kind, err);
    if (job.attempts >= job.max_attempts) {
      // The last attempt failed. A job whose payload can hold one time links is wiped now, not after the 14 day cleanup.
      if (SCRUB_PAYLOAD_KINDS.has(job.kind)) {
        await c.query(`UPDATE jobs SET status = 'failed', finished_at = now(), locked_at = NULL, payload = '{}'::jsonb, last_error = $2 WHERE id = $1`, [job.id, msg]);
      } else {
        await c.query(`UPDATE jobs SET status = 'failed', finished_at = now(), locked_at = NULL, last_error = $2 WHERE id = $1`, [job.id, msg]);
      }
    } else {
      await c.query(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, run_at = now() + make_interval(secs => $3), last_error = $2 WHERE id = $1`,
        [job.id, msg, backoffSeconds(job.attempts)],
      );
    }
  });
}

/** Claims and runs one job. Returns false when no job is due. */
async function runOneJob(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  const handler = getJobHandler(job.kind);
  try {
    if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
    await handler(job);
    await finish(job, null);
  } catch (err) {
    await finish(job, err);
  }
  return true;
}

/** How many jobs run at the same time in one worker. File checks are mostly waiting on disk and the scanner, so a few in parallel is much faster. */
export const JOB_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.JOB_CONCURRENCY ?? 4) || 4));

/** Runs due jobs until none are left, several at a time. Returns how many were processed. Used by the loop and by tests. */
export async function runDueJobs(max = 100, concurrency = JOB_CONCURRENCY): Promise<number> {
  let started = 0;
  const lane = async () => {
    while (started < max) {
      if (!(await runOneJob())) return;
      started++;
    }
  };
  // Another lane may queue follow-up jobs (for example an email) after this lane found the queue empty, so go round again until a whole pass finds nothing.
  let before: number;
  do {
    before = started;
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => lane()));
  } while (started > before && started < max);
  return started;
}

/**
 * Queues the daily retention job when it has not run in the last 24 hours. The claim and the job are one transaction,
 * and the claim is a conditional update, so several workers never queue it twice.
 */
export async function scheduleDailyJobs(): Promise<boolean> {
  return tx(SYSTEM, async (c) => {
    if (!(await claimDailyRetention(c))) return false;
    await enqueue(c, 'retention', {}, { maxAttempts: 3 });
    return true;
  });
}

/**
 * Queues a portal status sync when the last one was queued more than 10 minutes ago and none is queued or running.
 * Same claim approach as the daily retention job, so several workers never queue it twice.
 */
export async function schedulePortalSync(): Promise<boolean> {
  return tx(SYSTEM, async (c) => {
    if (!(await claimPortalSync(c))) return false;
    await enqueue(c, 'portal.sync', {}, { maxAttempts: 2 });
    return true;
  });
}

export function startWorker(opts: { intervalMs?: number; log?: (m: string) => void } = {}): { stop: () => Promise<void> } {
  const interval = opts.intervalMs ?? 2000;
  let stopped = false;
  const schedule = () => scheduleDailyJobs().catch((e) => opts.log?.(`schedule error: ${e instanceof Error ? e.message : 'unknown'}`));
  void schedule();
  const scheduleTimer = setInterval(() => void schedule(), 60 * 60 * 1000);
  scheduleTimer.unref();
  const syncSchedule = () => schedulePortalSync().catch((e) => opts.log?.(`portal sync schedule error: ${e instanceof Error ? e.message : 'unknown'}`));
  void syncSchedule();
  const syncTimer = setInterval(() => void syncSchedule(), 60 * 1000);
  syncTimer.unref();
  // Webhook deliveries whose job got lost (a crashed worker) are picked up again.
  const sweepWebhooks = () => sweepDueDeliveries().catch((e) => opts.log?.(`webhook sweep error: ${e instanceof Error ? e.message : 'unknown'}`));
  const sweepTimer = setInterval(() => void sweepWebhooks(), 60 * 1000);
  sweepTimer.unref();
  // Independent lanes: a long job (a portal push) never blocks the other lanes from picking up file checks.
  const lanes: Promise<void>[] = [];
  const wakeups = new Set<() => void>();
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); wakeups.delete(done); resolve(); };
    const t = setTimeout(done, ms);
    wakeups.add(done);
  });
  const lane = async (i: number) => {
    await sleep(200 + i * 50);
    while (!stopped) {
      let did = false;
      try {
        did = await runOneJob();
      } catch (e) {
        opts.log?.(`worker error: ${e instanceof Error ? e.message : 'unknown'}`);
      }
      if (!did && !stopped) await sleep(interval);
    }
  };
  for (let i = 0; i < JOB_CONCURRENCY; i++) lanes.push(lane(i));
  return {
    async stop() {
      stopped = true;
      clearInterval(scheduleTimer);
      clearInterval(syncTimer);
      clearInterval(sweepTimer);
      for (const w of [...wakeups]) w();
      await Promise.all(lanes);
    },
  };
}

// Entry point when run as its own process: node dist/worker.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const w = startWorker({ log: (m) => console.error(m) });
  const shutdown = async () => {
    await w.stop();
    await closePools();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  console.log('worker started');
}

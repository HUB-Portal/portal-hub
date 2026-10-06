import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { enqueue, registerJob, SCRUB_PAYLOAD_KINDS } from '../src/jobs';
import { runRetention } from '../src/services/retention';
import { runDueJobs, safeJobError } from '../src/worker';
import { q } from './helpers9';

const LINK = 'https://hub.example.com/invite/accept?token=ONE-TIME-TOKEN-1234';
const ADDRESS = 'new.person@partner.example';
const LEFTOVER_SQL = `payload::text ~* 'ONE-TIME-TOKEN|partner[.]example'`;

beforeAll(async () => {
  await seedDemo({ force: true });
  await q(`DELETE FROM jobs`);
});
afterAll(async () => {
  await closePools();
});

const addEmailJob = (opts: { maxAttempts?: number; createdAgo?: string; status?: string } = {}) =>
  tx(SYSTEM, async (c) => {
    const id = await enqueue(c, 'email.send', { to: ADDRESS, template: 'invite', data: { link: LINK, name: 'Nina' } }, { maxAttempts: opts.maxAttempts ?? 2 });
    if (opts.createdAgo || opts.status) {
      await c.query(
        `UPDATE jobs SET created_at = now() - $2::interval, status = $3, finished_at = CASE WHEN $3 IN ('done', 'failed') THEN now() - $2::interval ELSE NULL END WHERE id = $1`,
        [id, opts.createdAgo ?? '0 seconds', opts.status ?? 'queued'],
      );
    }
    return id;
  });
const job = async (id: number) => (await q('SELECT * FROM jobs WHERE id = $1', [id]))[0];
const dueNow = (id: number) => q(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]);

describe('email jobs that fail', () => {
  it('keep the payload for the retries, and wipe it as soon as the last attempt has failed', async () => {
    registerJob('email.send', async () => {
      throw Object.assign(new Error(`550 5.1.1 <${ADDRESS}> rejected. See ${LINK}`), { responseCode: 550 });
    });
    const id = await addEmailJob({ maxAttempts: 2 });
    await runDueJobs();
    let j = await job(id);
    // first failure: queued for a retry, so the payload is still needed
    expect(j.status).toBe('queued');
    expect(j.attempts).toBe(1);
    expect(JSON.stringify(j.payload)).toContain('ONE-TIME-TOKEN-1234');
    expect(j.last_error).toBe('The email could not be sent (code 550).');
    // last attempt
    await dueNow(id);
    await runDueJobs();
    j = await job(id);
    expect(j.status).toBe('failed');
    expect(j.attempts).toBe(2);
    expect(j.payload).toEqual({});
    expect(j.finished_at).not.toBeNull();
    expect(j.last_error).toBe('The email could not be sent (code 550).');
    expect(j.last_error).not.toMatch(/@|https?:|token/);
    // nothing with a link or an address is left anywhere in the jobs table
    const left = await q(`SELECT id FROM jobs WHERE ${LEFTOVER_SQL} OR coalesce(last_error, '') ~* '@|https?://|token'`);
    expect(left).toEqual([]);
  });

  it('use fixed error text when the error has no code', async () => {
    registerJob('email.send', async () => {
      throw new Error(`connect ECONNREFUSED smtp.partner.example for ${ADDRESS}`);
    });
    const id = await addEmailJob({ maxAttempts: 1 });
    await runDueJobs();
    const j = await job(id);
    expect(j.status).toBe('failed');
    expect(j.payload).toEqual({});
    expect(j.last_error).toBe('The email could not be sent.');
  });

  it('are wiped when a successful send finishes too (unchanged)', async () => {
    registerJob('email.send', async () => undefined);
    const id = await addEmailJob();
    await runDueJobs();
    const j = await job(id);
    expect(j.status).toBe('done');
    expect(j.payload).toEqual({});
  });
});

describe('error text of other jobs', () => {
  it('never keeps an email address or a link, and stays short', async () => {
    registerJob('test.fail', async () => {
      throw new Error(`Request to https://api.partner.example/v1/cases?token=SECRET failed for ${ADDRESS}: ${'x'.repeat(500)}`);
    });
    const id = await tx(SYSTEM, (c) => enqueue(c, 'test.fail', { caseId: 'abc' }, { maxAttempts: 1 }));
    await runDueJobs();
    const j = await job(id);
    expect(j.status).toBe('failed');
    expect(j.last_error.length).toBeLessThanOrEqual(300);
    expect(j.last_error).not.toMatch(/partner\.example|SECRET|@/);
    expect(j.last_error).toContain('[link removed]');
    expect(j.payload).toEqual({ caseId: 'abc' }); // not a kind that holds one time links
    expect(SCRUB_PAYLOAD_KINDS.has('test.fail')).toBe(false);
  });

  it('safeJobError removes addresses and links from every message', () => {
    expect(safeJobError('x', new Error(`mail to ${ADDRESS} at ${LINK}`))).toBe('mail to [address removed] at [link removed]');
    expect(safeJobError('email.send', new Error(`anything ${ADDRESS}`))).toBe('The email could not be sent.');
    expect(safeJobError('email.send', Object.assign(new Error('x'), { responseCode: 421 }))).toBe('The email could not be sent (code 421).');
    expect(safeJobError('email.send', Object.assign(new Error('x'), { responseCode: 99999 }))).toBe('The email could not be sent.');
  });
});

describe('the retention job and old email jobs', () => {
  it('wipes the payload of every email job older than 24 hours, whatever its status, and leaves fresh ones alone', async () => {
    const oldDone = await addEmailJob({ createdAgo: '30 hours', status: 'done' });
    await q(`UPDATE jobs SET payload = $2::jsonb WHERE id = $1`, [oldDone, JSON.stringify({ to: ADDRESS, data: { link: LINK } })]); // a done job from before payloads were wiped
    const oldFailed = await addEmailJob({ createdAgo: '26 hours', status: 'failed' });
    const oldQueued = await addEmailJob({ createdAgo: '25 hours', status: 'queued' });
    const fresh = await addEmailJob({ createdAgo: '2 hours', status: 'queued' });
    const report = await runRetention();
    expect(report.emailJobsScrubbed).toBeGreaterThanOrEqual(3);
    for (const id of [oldDone, oldFailed, oldQueued]) {
      expect((await job(id)).payload).toEqual({});
    }
    expect((await job(oldDone)).status).toBe('done');
    expect((await job(oldFailed)).status).toBe('failed');
    // an email that old is never sent late
    const stale = await job(oldQueued);
    expect(stale.status).toBe('failed');
    expect(stale.last_error).toBe('The email could not be sent.');
    expect(stale.finished_at).not.toBeNull();
    // a recent one keeps its payload and stays queued
    const f = await job(fresh);
    expect(f.status).toBe('queued');
    expect(JSON.stringify(f.payload)).toContain('ONE-TIME-TOKEN-1234');
    // the old rows hold no link or address
    expect(await q(`SELECT id FROM jobs WHERE id <> $1 AND kind = 'email.send' AND ${LEFTOVER_SQL}`, [fresh])).toEqual([]);
  });

  it('removes finished and failed jobs after 14 days as before', async () => {
    const id = await addEmailJob({ createdAgo: '15 days', status: 'failed' });
    await runRetention();
    expect(await q('SELECT id FROM jobs WHERE id = $1', [id])).toEqual([]);
  });
});

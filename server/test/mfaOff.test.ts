import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Runs with two factor sign in switched off (the default of MFA_REQUIRED). The config is read once when it is first imported, so the
// variable is set before the imports below run.
vi.hoisted(() => {
  process.env.MFA_REQUIRED = 'false';
});

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { DEMO_PASSWORD } from '../src/services/demo';
import { Client } from './helpers';

let app: FastifyInstance;

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closePools();
});

describe('two factor sign in switched off', () => {
  it('reads the switch from the environment', () => {
    expect(config.mfaRequired).toBe(false);
  });

  it('gives a full session after the password alone, for partner and K Line staff', async () => {
    for (const email of ['admin@acme.demo', 'upload@acme.demo', 'admin@kline.demo']) {
      const c = new Client(app);
      const l = await c.call('POST', '/api/auth/login', { email, password: DEMO_PASSWORD });
      expect(l.status, email).toBe(200);
      expect(l.json.stage).toBe('full');
      const me = await c.call('GET', '/api/auth/me');
      expect(me.json.stage).toBe('full');
      expect(me.json.mfaRequired).toBe(false);
      expect(me.json.permissions.length).toBeGreaterThan(0);
      expect((await c.call('GET', '/api/org')).status).toBe(200);
    }
  });

  it('still refuses a wrong password', async () => {
    const r = await new Client(app).call('POST', '/api/auth/login', { email: 'admin@acme.demo', password: 'not-the-password' });
    expect(r.status).toBe(401);
  });

  it('does not ask for a step up code on sensitive actions', async () => {
    const admin = new Client(app);
    await admin.call('POST', '/api/auth/login', { email: 'admin@acme.demo', password: DEMO_PASSWORD });
    // An old step up must not matter either.
    await q(`UPDATE sessions SET step_up_at = NULL WHERE user_id = (SELECT id FROM users WHERE email = 'admin@acme.demo') AND revoked_at IS NULL`);
    const inv = await admin.call('POST', '/api/team/invite', { email: 'nomfa@acme.demo', name: 'Nora Nomfa', roles: ['viewer'] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
  });

  it('lets an invited person set a password and in at once, as an active user', async () => {
    const row = (await q<{ id: string }>(`SELECT id FROM users WHERE email = 'nomfa@acme.demo'`))[0]!;
    // The invitation token is stored hashed, so ask for a new one through the service the invite route used.
    const { createUserToken } = await import('../src/services/userTokens');
    const org = (await q<{ org_id: string }>(`SELECT org_id FROM users WHERE id = $1`, [row.id]))[0]!;
    const token = await tx(SYSTEM, (c) => createUserToken(c, { orgId: org.org_id, userId: row.id, kind: 'invite', ttlMinutes: 60 }));
    const c = new Client(app);
    const acc = await c.call('POST', '/api/auth/invite/accept', { token, password: 'Correct-Horse-Battery-Staple-7' });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    expect(acc.json.stage).toBe('full');
    expect((await c.call('GET', '/api/org')).status).toBe(200);
    const u = (await q<{ status: string; mfa_enabled: boolean }>(`SELECT status, mfa_enabled FROM users WHERE id = $1`, [row.id]))[0]!;
    expect(u.status).toBe('active');
    expect(u.mfa_enabled).toBe(false);
  });

  it('shows no authenticator step in the onboarding checklist', async () => {
    const admin = new Client(app);
    await admin.call('POST', '/api/auth/login', { email: 'admin@acme.demo', password: DEMO_PASSWORD });
    const r = await admin.call('GET', '/api/org/onboarding');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items.map((i: { id: string }) => i.id)).not.toContain('account_secured');
  });

  it('treats a password only session that was started while the switch was on as full', async () => {
    const c = new Client(app);
    await c.call('POST', '/api/auth/login', { email: 'upload@acme.demo', password: DEMO_PASSWORD });
    await q(`UPDATE sessions SET stage = 'password' WHERE user_id = (SELECT id FROM users WHERE email = 'upload@acme.demo') AND revoked_at IS NULL`);
    const me = await c.call('GET', '/api/auth/me');
    expect(me.json.stage).toBe('full');
    expect((await c.call('GET', '/api/org')).status).toBe(200);
  });

  it('keeps the public config in step so the sign in page hides the authenticator text', async () => {
    const r = await new Client(app).call('GET', '/api/public/config');
    expect(r.json.mfaRequired).toBe(false);
  });
});

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SYSTEM, tx } from '../src/db';
import { Client, cubeStl, trimLine } from './helpers';

export const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

/** A fresh sign in counts as a recent authenticator code, so tests that need "no step up" age it first. */
export const expireStepUp = (email: string) =>
  q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`, [email]);

let ipCounter = 1;
/** Calls the factory API with a bearer key (no session). */
export async function svcCall(app: FastifyInstance, key: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${key}` }, remoteAddress: `10.9.9.${ipCounter++ % 250}` });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* binary */
  }
  return { status: res.statusCode, json, res };
}

export interface MadeCase {
  id: string;
  ref: string;
  caseId: string;
  fileIds: string[];
  stl: Buffer;
}

/** A standard case with one upper aligner (model and trim line), submitted. It is ready at the partner's first allowed site (or submitted when manual review is on). */
export async function readyStandardCase(c: Client, opts: { caseId?: string; patientName?: string; instructions?: string; model?: Buffer } = {}): Promise<MadeCase> {
  const caseId = opts.caseId ?? `P9-${Math.random().toString(36).slice(2, 9)}`;
  const created = await c.call('POST', '/api/cases', { caseId, patientName: opts.patientName ?? 'Erin Erasable', instructions: opts.instructions ?? 'Please keep the attachments.' });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.case.id as string;
  const stl = opts.model ?? cubeStl(50, `model ${caseId}`);
  const f1 = await c.uploadFile(id, 'U01.stl', stl);
  const f2 = await c.uploadFile(id, 'U01.pts', trimLine());
  const sub = await c.call('POST', `/api/cases/${id}/submit`, { acknowledgeWarnings: true });
  expect(sub.status, JSON.stringify(sub.json)).toBe(200);
  return { id, ref: created.json.case.ref as string, caseId, fileIds: [f1.fileId, f2.fileId], stl };
}

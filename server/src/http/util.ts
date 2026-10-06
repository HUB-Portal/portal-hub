import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from './errors';
import { BIDI_MESSAGE, hasBidiControl } from '../../../shared/text';

/** Validates with zod and turns failures into a consistent 400 without echoing input values. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('Some details are missing or not valid.', 'invalid_request', { fields });
  }
  return r.data;
}

export const uuidSchema = z.string().uuid();

/** Refuses hidden text direction characters in names and text other people read (file names, spec clauses, team names, materials, claims). */
export function assertNoBidi(...texts: Array<string | null | undefined>): void {
  for (const t of texts) if (t && hasBidiControl(t)) throw badRequest(BIDI_MESSAGE, 'invalid_text');
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

export function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 300) : null;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until at least `ms` have passed since `startedAt`. Used so responses take a similar time whatever the outcome. */
export async function padTo(startedAt: number, ms: number): Promise<void> {
  const left = ms - (Date.now() - startedAt);
  if (left > 0) await sleep(left);
}

/** Redacts one time tokens from a URL for logging. */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&](?:token|t|code|state)=)[^&#]*/gi, '$1[redacted]')
    .replace(/(\/invite\/)(?!accept(?:[/?#]|$))[^/?#]+/gi, '$1[redacted]')
    .replace(/(\/api\/auth\/verify\/)[^/?#]+/gi, '$1[redacted]')
    // The address of a portal webhook receiver is not a secret by itself, but there is no reason to keep it in logs.
    .replace(/(\/api\/hooks\/kline-portal\/)[^/?#]+/gi, '$1[redacted]')
    // The partner API finds a case by its reference or by the partner's own case ID, which for direct manufacturing is the patient ID.
    // References and file ids stay in the log, anything else is hidden. Searches and case ID filters may hold a patient name or ID.
    .replace(/(\/api\/v1\/(?:cases|files)\/)(?![A-Za-z0-9]{2,8}-\d{6,}(?:[/?#]|$))(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$))[^/?#]+/gi, '$1[redacted]')
    .replace(/([?&](?:search|case_id)=)[^&#]*/gi, '$1[redacted]');
}

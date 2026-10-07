// API client: cookie session, CSRF header on writes, global step up retry. No tokens are stored in the browser.

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let csrf: string | null = null;
export function setCsrf(token: string | null): void { csrf = token; }

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
export function registerStepUp(fn: StepUpHandler | null): void { stepUpHandler = fn; }

type Listener = () => void;
const unauthListeners = new Set<Listener>();
export function onUnauthenticated(fn: Listener): () => void {
  unauthListeners.add(fn);
  return () => { unauthListeners.delete(fn); };
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Do not treat 401 as "signed out" (used by the sign in flow). */
  quiet401?: boolean;
}

async function ensureCsrf(): Promise<string | null> {
  if (csrf) return csrf;
  try {
    const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    if (r.ok) {
      const j = (await r.json()) as { csrfToken?: string };
      csrf = j.csrfToken ?? null;
    }
  } catch { /* the caller's own request reports the failure */ }
  return csrf;
}

async function parseBody(res: Response): Promise<any> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  try { return await res.json(); } catch { return null; }
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}, retried = { step: false, csrf: false }): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  if (method !== 'GET') {
    const t = await ensureCsrf();
    if (t) headers['x-csrf-token'] = t;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'We could not reach the server. Check your connection and try again.');
  }
  const data = await parseBody(res);
  if (res.ok) {
    if (data && typeof data === 'object' && typeof (data as any).csrfToken === 'string') csrf = (data as any).csrfToken;
    return data as T;
  }
  const code: string = data?.code ?? 'error';
  const message: string = data?.message ?? 'Something went wrong. Please try again.';
  if (res.status === 403 && code === 'step_up_required' && !retried.step && stepUpHandler) {
    const ok = await stepUpHandler();
    if (ok) return api<T>(path, opts, { ...retried, step: true });
    throw new ApiError(403, 'step_up_cancelled', 'Confirmation was cancelled.');
  }
  if (res.status === 403 && /csrf/i.test(code) && !retried.csrf) {
    csrf = null;
    return api<T>(path, opts, { ...retried, csrf: true });
  }
  if (res.status === 401 && !opts.quiet401) {
    csrf = null;
    unauthListeners.forEach((f) => f());
  }
  throw new ApiError(res.status, code, message, data && typeof data === 'object' ? data : {});
}

/** What people read when K Line cannot take a case because the case address is missing. */
export const CASE_ADDRESS_REQUIRED_TEXT = 'The company case address is missing. An administrator can add it in the company profile, then try again.';

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'case_address_required') return CASE_ADDRESS_REQUIRED_TEXT;
    if (e.code === 'org_not_approved') return 'This is locked until K Line approves your company. Open Getting started on your overview to see what is left.';
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Downloads a file with the session cookie and returns it as a blob, so the page can save it as a normal download.
 * A step up prompt is shown when the server asks for one, then the download is tried once more.
 */
export async function apiBlob(path: string, retried = false, signal?: AbortSignal): Promise<{ blob: Blob; filename: string | null }> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'GET', headers: { accept: 'text/csv, application/json' }, credentials: 'same-origin', signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'We could not reach the server. Check your connection and try again.');
  }
  if (res.ok) {
    const disp = res.headers.get('content-disposition') ?? '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
    const name = m?.[1] ? decodeURIComponent(m[1]).replace(/[^A-Za-z0-9._-]/g, '_') : null;
    return { blob: await res.blob(), filename: name };
  }
  const data = await parseBody(res);
  const code: string = data?.code ?? 'error';
  const message: string = data?.message ?? 'Something went wrong. Please try again.';
  if (res.status === 403 && code === 'step_up_required' && !retried && stepUpHandler) {
    const ok = await stepUpHandler();
    if (ok) return apiBlob(path, true, signal);
    throw new ApiError(403, 'step_up_cancelled', 'Confirmation was cancelled.');
  }
  if (res.status === 401) {
    csrf = null;
    unauthListeners.forEach((f) => f());
  }
  throw new ApiError(res.status, code, message, data && typeof data === 'object' ? data : {});
}

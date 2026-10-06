import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { CaseAddress } from '../../../../shared/caseAddress';
import { isCompleteCaseAddress } from '../../../../shared/caseAddress';
import { PortalError, toPortalShipping, type PortalShippingBody, type PortalCaseInfo, type PortalCaseInput, type PortalClient, type PortalErrorCode, type PortalField } from './client';

export interface FakeUpload {
  field: PortalField;
  name: string;
  size: number;
  data: Buffer;
}

export interface FakeCase {
  uuid: string;
  input: PortalCaseInput;
  uploads: FakeUpload[];
  /** The nine portal fields exactly as the Hub sent them (see toPortalShipping). */
  shippingAddress?: PortalShippingBody;
  submitted: boolean;
  /** Set by tests to play the part of the portal moving the case on. When empty the status follows `submitted`. */
  status?: string | null;
  trackingNumber?: string | null;
  expectedShippingDate?: string | null;
}

export type FakeOp = 'ping' | 'createCase' | 'uploadFile' | 'setShippingAddress' | 'submitCase' | 'getCase';

/** In memory portal. Used by tests, and in development or tests when an organisation has no credentials and PORTAL_FAKE is on. Nothing is ever sent anywhere. */
export class FakePortalClient implements PortalClient {
  cases = new Map<string, FakeCase>();
  /** Every call in order, without file bytes. */
  calls: { op: FakeOp; caseUuid?: string; field?: PortalField; name?: string; size?: number }[] = [];
  private failures: { op: FakeOp; code: PortalErrorCode; status?: number; times: number; skip: number }[] = [];

  /** Makes the next `times` calls of `op` fail with a portal error, after letting `skip` calls through. */
  failNext(op: FakeOp, code: PortalErrorCode = 'server', times = 1, status?: number, skip = 0): void {
    this.failures.push({ op, code, status, times, skip });
  }
  clearFailures(): void {
    this.failures = [];
  }
  reset(): void {
    this.cases.clear();
    this.calls = [];
    this.failures = [];
  }
  private maybeFail(op: FakeOp): void {
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f && f.skip > 0) {
      f.skip--;
      return;
    }
    if (f) {
      f.times--;
      throw new PortalError(f.code, f.status);
    }
  }
  private need(uuid: string): FakeCase {
    const c = this.cases.get(uuid);
    if (!c) throw new PortalError('not_found', 404);
    return c;
  }

  async ping(): Promise<void> {
    this.calls.push({ op: 'ping' });
    this.maybeFail('ping');
  }
  async createCase(input: PortalCaseInput): Promise<{ uuid: string }> {
    this.calls.push({ op: 'createCase' });
    this.maybeFail('createCase');
    if (!input.lastName) throw new PortalError('validation', 422);
    const uuid = randomUUID();
    this.cases.set(uuid, { uuid, input, uploads: [], submitted: false });
    return { uuid };
  }
  async uploadFile(caseUuid: string, field: PortalField, name: string, stream: Readable, size: number): Promise<{ fileUuid: string | null }> {
    this.calls.push({ op: 'uploadFile', caseUuid, field, name, size });
    this.maybeFail('uploadFile');
    const c = this.need(caseUuid);
    const parts: Buffer[] = [];
    for await (const p of stream) parts.push(Buffer.from(p));
    const data = Buffer.concat(parts);
    c.uploads.push({ field, name, size: data.length, data });
    return { fileUuid: randomUUID() };
  }
  async setShippingAddress(caseUuid: string, address: CaseAddress): Promise<void> {
    this.calls.push({ op: 'setShippingAddress', caseUuid });
    this.maybeFail('setShippingAddress');
    const c = this.need(caseUuid);
    // The portal answers 400 when a field is missing and 409 for a submitted direct manufacturing case.
    if (!isCompleteCaseAddress(address)) throw new PortalError('validation', 400);
    if (c.submitted) throw new PortalError('validation', 409);
    c.shippingAddress = toPortalShipping(address);
  }
  async submitCase(caseUuid: string): Promise<void> {
    this.calls.push({ op: 'submitCase', caseUuid });
    this.maybeFail('submitCase');
    this.need(caseUuid).submitted = true;
  }
  async getCase(caseUuid: string): Promise<PortalCaseInfo> {
    this.calls.push({ op: 'getCase', caseUuid });
    this.maybeFail('getCase');
    const c = this.need(caseUuid);
    return {
      uuid: caseUuid,
      status: c.status !== undefined ? c.status : c.submitted ? 'InPlanning' : 'New',
      trackingNumber: c.trackingNumber ?? null,
      expectedShippingDate: c.expectedShippingDate ?? null,
    };
  }
  /** Test helper: plays the portal changing a case. */
  setPortalState(caseUuid: string, state: { status?: string | null; trackingNumber?: string | null; expectedShippingDate?: string | null }): void {
    Object.assign(this.need(caseUuid), state);
  }
}

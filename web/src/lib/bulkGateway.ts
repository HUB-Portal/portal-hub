// Everything Direct manufacturing needs from the server, behind one interface. The upload hook depends on this interface and not on fetch, so it can
// be given another implementation (a fake in a test, or a different transport) without a change to the hook.
import { api } from './api';
import { INSTRUCTIONS_MAX } from './instructions';
import { clean, type Row } from './bulkRows';
import { submitCase, uploadCaseFiles, type CaseUploadResult, type SubmitOutcome, type UploadHooks, type UploadSpec } from './upload';

export interface CreatedCase { id?: string; ref?: string; error?: string }

export interface BulkGateway {
  /** Creates the draft case of a card. */
  create(row: Row, signal?: AbortSignal): Promise<CreatedCase>;
  /** Writes changed details to a draft case. */
  update(caseUuid: string, changes: Record<string, unknown>): Promise<void>;
  /** Deletes a draft case. */
  remove(caseUuid: string): Promise<void>;
  /** Sends the files of a case. */
  upload(caseUuid: string, specs: UploadSpec[], hooks: UploadHooks): Promise<CaseUploadResult>;
  /** Submits a case when its checks allow it. */
  submit(caseUuid: string): Promise<SubmitOutcome>;
}

export const httpBulkGateway: BulkGateway = {
  async create(row, signal) {
    const instructions = row.instructions.trim() ? row.instructions.slice(0, INSTRUCTIONS_MAX) : undefined;
    const body = { key: row.key, patientId: clean(row.patientId) || undefined, firstName: clean(row.firstName), lastName: clean(row.lastName), ...(instructions ? { instructions } : {}) };
    const r = await api<{ cases: CreatedCase[] }>('/api/bulk/batches', { method: 'POST', signal, body: { cases: [body] } });
    return r.cases[0] ?? { error: 'invalid_request' };
  },
  async update(caseUuid, changes) {
    await api(`/api/cases/${caseUuid}`, { method: 'PATCH', body: changes });
  },
  async remove(caseUuid) {
    await api(`/api/cases/${caseUuid}`, { method: 'DELETE' });
  },
  upload: (caseUuid, specs, hooks) => uploadCaseFiles(caseUuid, specs, hooks),
  submit: (caseUuid) => submitCase(caseUuid),
};

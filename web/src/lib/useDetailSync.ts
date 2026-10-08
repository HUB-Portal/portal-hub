import { useEffect, useRef } from 'react';
import { ApiError } from './api';
import type { BulkGateway } from './bulkGateway';
import { canSyncDetails, changedDetails, detailsOf, isDetailProblem, problemsOf, type Row } from './bulkRows';
import { friendlyUploadError } from './upload';

const DELAY_MS = 700;

/**
 * Writes what the partner changes on a card (patient ID, names, instructions) to its draft case, a moment after the last keystroke. A change that
 * is not valid yet (a name that is too long) waits until it is. `flush` sends what is pending at once, before the case is sent to K Line.
 */
export function useDetailSync(rows: Row[], rowsRef: { current: Row[] }, patch: (key: string, p: Partial<Row>) => void, gateway: BulkGateway) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const cancel = (key: string) => {
    const t = timers.current.get(key);
    if (t) clearTimeout(t);
    timers.current.delete(key);
  };

  async function write(key: string, caseUuid: string, changes: Record<string, unknown>, sentDetails: ReturnType<typeof detailsOf>) {
    try {
      await gateway.update(caseUuid, changes);
      patch(key, { synced: sentDetails });
    } catch (e) {
      patch(key, { nameError: e instanceof ApiError && e.code === 'case_not_open' ? 'This case was already sent, so the details cannot be changed here. Contact K Line.' : friendlyUploadError(e) });
    }
  }

  // Which edits are pending is told by this key: it changes when a row's stage or details change, and not for upload progress.
  const signature = rows.map((r) => `${r.key}|${r.stage}|${r.patientId}|${r.firstName}|${r.lastName}|${r.instructions}|${r.synced?.firstName}|${r.synced?.lastName}|${r.synced?.patientId}|${r.synced?.instructions}`).join('\n');
  useEffect(() => {
    for (const r of rowsRef.current) {
      cancel(r.key);
      if (!canSyncDetails(r) || problemsOf(r).some(isDetailProblem)) continue;
      const changes = changedDetails(r);
      if (!Object.keys(changes).length) continue;
      const sentDetails = detailsOf(r);
      timers.current.set(r.key, setTimeout(() => { timers.current.delete(r.key); void write(r.key, r.caseUuid!, changes, sentDetails); }, DELAY_MS));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  /** Sends the pending change of one card now (and drops its timer). Resolves when the server has it. */
  async function flush(r: Row): Promise<void> {
    cancel(r.key);
    const changes = changedDetails(r);
    if (Object.keys(changes).length) await gateway.update(r.caseUuid!, changes);
  }

  return { flush, cancel };
}

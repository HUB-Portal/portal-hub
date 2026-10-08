import { createEffect, createMemo, on, onCleanup } from 'solid-js';
import { ApiError } from './api';
import type { BulkGateway } from './bulkGateway';
import { canSyncDetails, changedDetails, detailsOf, isDetailProblem, problemsOf, type Row } from './bulkRows';
import { friendlyUploadError } from './upload';

const DELAY_MS = 700;

/**
 * Writes what the partner changes on a card (patient ID, names, instructions) to its draft case, a moment after the last keystroke. A change that
 * is not valid yet (a name that is too long) waits until it is. `flush` sends what is pending at once, before the case is sent to K Line.
 * `rows` is the reactive list of cards (a store): the hook reads it, it never copies it.
 */
export function useDetailSync(rows: Row[], patch: (key: string, p: Partial<Row>) => void, gateway: BulkGateway) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (key: string) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
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
  const signature = createMemo(() => rows.map((r) => `${r.key}|${r.stage}|${r.patientId}|${r.firstName}|${r.lastName}|${r.instructions}|${r.synced?.firstName}|${r.synced?.lastName}|${r.synced?.patientId}|${r.synced?.instructions}`).join('\n'));
  createEffect(on(signature, () => {
    for (const r of rows) {
      cancel(r.key);
      if (!canSyncDetails(r) || problemsOf(r).some(isDetailProblem)) continue;
      const changes = changedDetails(r);
      if (!Object.keys(changes).length) continue;
      const sentDetails = detailsOf(r);
      const caseUuid = r.caseUuid!;
      timers.set(r.key, setTimeout(() => { timers.delete(r.key); void write(r.key, caseUuid, changes, sentDetails); }, DELAY_MS));
    }
  }));

  onCleanup(() => { for (const t of timers.values()) clearTimeout(t); });

  /** Sends the pending change of one card now (and drops its timer). Resolves when the server has it. */
  async function flush(r: Row): Promise<void> {
    cancel(r.key);
    const changes = changedDetails(r);
    if (Object.keys(changes).length) await gateway.update(r.caseUuid!, changes);
  }

  return { flush, cancel };
}

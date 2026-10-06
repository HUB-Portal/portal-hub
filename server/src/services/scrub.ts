import { many, one, type PoolClient } from '../db';

/** Fixed text that replaces anything people typed. */
export const REMOVED = '[removed]';

export interface ScrubOptions {
  /**
   * 'direct': the partner case ID is removed for direct manufacturing cases only (there it is the patient ID). This is what a purge does.
   * 'always': it is removed for every case. This is what an erasure on request does, because a case ID can be a folder name with a name in it.
   */
  partnerCaseId: 'direct' | 'always';
}

export interface ScrubReport {
  partnerCaseId: boolean;
  events: number;
  claims: number;
  claimItems: number;
  claimMessages: number;
  webhookDeliveries: number;
  notifications: number;
}

/**
 * Removes the personal data that a case leaves around its files and names, for a case that is being purged (retention) or erased on request.
 * Call it inside the caller's transaction AFTER the case has `purged_at` set (the identifier check on `cases` allows no case ID only then).
 * Safe to run again. References (K Line reference, status, dates, counts, claim numbers and decisions) stay.
 *
 *  - cases.partner_case_id (the patient ID of direct manufacturing cases; see ScrubOptions) and cases.hold_reason
 *  - case_events.data: hold reasons and notes
 *  - claims on the case: summary, description, root cause, corrective action, decision note, item notes, messages written by people
 *  - webhook_deliveries: case_id and partner_case_id in the payloads of deliveries for this case reference
 *  - notifications for the case that quote the old case ID
 */
export async function scrubCase(c: PoolClient, caseId: string, opts: ScrubOptions = { partnerCaseId: 'direct' }): Promise<ScrubReport> {
  const cs = await one<any>(c, 'SELECT id, org_id, ref, partner_case_id, manufacturing_mode, purged_at FROM cases WHERE id = $1', [caseId]);
  if (!cs) return { partnerCaseId: false, events: 0, claims: 0, claimItems: 0, claimMessages: 0, webhookDeliveries: 0, notifications: 0 };
  if (!cs.purged_at) throw new Error('scrubCase is only for purged or erased cases');
  const oldCaseId: string | null = cs.partner_case_id ?? null;
  const clearId = opts.partnerCaseId === 'always' || cs.manufacturing_mode === 'direct';

  // Text of notifications that quoted the case ID: put the K Line reference in its place.
  let notifications = 0;
  if (clearId && oldCaseId) {
    const r = await c.query(
      `UPDATE notifications SET title = replace(title, $2::text, $3::text), body = replace(body, $2::text, $3::text)
        WHERE data->>'caseId' = $1::text AND (position($2::text in title) > 0 OR position($2::text in COALESCE(body, '')) > 0)`,
      [caseId, oldCaseId, cs.ref],
    );
    notifications = r.rowCount ?? 0;
  }

  await c.query(
    `UPDATE cases SET partner_case_id = CASE WHEN $2::boolean THEN NULL ELSE partner_case_id END,
            hold_reason = CASE WHEN hold_reason IS NULL THEN NULL ELSE $3::text END,
            scrubbed_at = now(), updated_at = now()
      WHERE id = $1`,
    [caseId, clearId, REMOVED],
  );

  // Events: the hold reason and the note of stage changes are free text. The type and time stay. 'purged' and 'erased' events carry only fixed words.
  const ev = await c.query(
    `UPDATE case_events SET data = CASE
              WHEN type = 'instructions_updated' THEN '{}'::jsonb
              ELSE data
                || CASE WHEN data ? 'reason' THEN jsonb_build_object('reason', $2::text) ELSE '{}'::jsonb END
                || CASE WHEN data ? 'note' THEN jsonb_build_object('note', $2::text) ELSE '{}'::jsonb END
            END
      WHERE case_id = $1 AND type NOT IN ('purged', 'erased') AND (type = 'instructions_updated' OR data ? 'reason' OR data ? 'note')`,
    [caseId, REMOVED],
  );

  // Claims on this case: everything a person typed.
  const claims = await many<{ id: string }>(c, 'SELECT id FROM claims WHERE case_id = $1', [caseId]);
  let claimRows = 0;
  let items = 0;
  let messages = 0;
  if (claims.length) {
    const ids = claims.map((x) => x.id);
    const cl = await c.query(
      `UPDATE claims SET summary = $2::text,
              description = CASE WHEN description IS NULL THEN NULL ELSE $2::text END,
              root_cause = CASE WHEN root_cause IS NULL THEN NULL ELSE $2::text END,
              corrective_action = CASE WHEN corrective_action IS NULL THEN NULL ELSE $2::text END,
              decision_note = CASE WHEN decision_note IS NULL THEN NULL ELSE $2::text END,
              updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND (summary IS DISTINCT FROM $2::text OR description IS DISTINCT FROM $2::text OR root_cause IS DISTINCT FROM $2::text OR corrective_action IS DISTINCT FROM $2::text OR decision_note IS DISTINCT FROM $2::text)`,
      [ids, REMOVED],
    );
    claimRows = cl.rowCount ?? 0;
    items = (await c.query(`UPDATE claim_items SET note = $2::text WHERE claim_id = ANY($1::uuid[]) AND note IS NOT NULL AND note IS DISTINCT FROM $2::text`, [ids, REMOVED])).rowCount ?? 0;
    // Messages typed by people. The fixed status messages the system wrote ("Claim opened.") stay.
    messages = (await c.query(`UPDATE claim_messages SET body = $2::text WHERE claim_id = ANY($1::uuid[]) AND side <> 'system' AND body IS DISTINCT FROM $2::text`, [ids, REMOVED])).rowCount ?? 0;
  }

  // Webhook deliveries (and their stored payloads) for this case reference: the partner case ID is dropped, the reference stays.
  const wh = await c.query(
    `UPDATE webhook_deliveries SET payload = jsonb_set(payload, '{data}', (payload->'data') - 'case_id' - 'partner_case_id')
      WHERE org_id = $1 AND payload->'data'->>'ref' = $2 AND (payload->'data' ? 'case_id' OR payload->'data' ? 'partner_case_id')`,
    [cs.org_id, cs.ref],
  );

  return {
    partnerCaseId: clearId && !!oldCaseId,
    events: ev.rowCount ?? 0,
    claims: claimRows,
    claimItems: items,
    claimMessages: messages,
    webhookDeliveries: wh.rowCount ?? 0,
    notifications,
  };
}

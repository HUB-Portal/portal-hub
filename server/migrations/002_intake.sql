-- Phase 2: intake and direct manufacturing bulk. Additive only.

-- Patient name search: both name orders are stored so "Marc Alonso" and "Alonso Marc" find the same case.
ALTER TABLE cases ADD COLUMN patient_bidxs text[] NOT NULL DEFAULT '{}';
CREATE INDEX cases_bidxs_idx ON cases USING gin (patient_bidxs);
UPDATE cases SET patient_bidxs = ARRAY[patient_bidx] WHERE patient_bidx IS NOT NULL;

ALTER TABLE bulk_batches ADD COLUMN submit_when_clean boolean NOT NULL DEFAULT false;
ALTER TABLE bulk_batches ADD COLUMN priority text NOT NULL DEFAULT 'normal';

CREATE INDEX files_case_state_idx ON files (case_id, state) WHERE case_id IS NOT NULL;
CREATE INDEX cases_direct_pid_idx ON cases (org_id, lower(partner_case_id)) WHERE manufacturing_mode = 'direct' AND cancelled_at IS NULL;

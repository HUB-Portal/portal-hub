-- Phase 3: production stages, MES events, retention bookkeeping. Additive only.

-- ---------------------------------------------------------------------------
-- Stage map: code -> target (a stage id, hold, cancelled or ignore)
-- ---------------------------------------------------------------------------
ALTER TABLE mes_stage_map ALTER COLUMN stage DROP NOT NULL;
ALTER TABLE mes_stage_map ADD COLUMN target text;
ALTER TABLE mes_stage_map ADD COLUMN note text;
ALTER TABLE mes_stage_map ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO mes_stage_map (mes_code, target, note, label) VALUES
  ('RECEIVED', 'received', 'Case received at the factory', 'Received at factory'),
  ('CAD', 'received', 'Design work started', 'Received at factory'),
  ('PRINT', 'printing', '3D printing', '3D printing'),
  ('POSTPRINT', 'printing', 'Post print cleaning', '3D printing'),
  ('THERMO', 'thermoforming', 'Thermoforming', 'Thermoforming'),
  ('TRIM', 'trimming', 'Trimming', 'Trimming'),
  ('LASER', 'trimming', 'Laser marking and cutting', 'Trimming'),
  ('POLISH', 'finishing', 'Polishing', 'Finishing and cleaning'),
  ('CLEAN', 'finishing', 'Cleaning', 'Finishing and cleaning'),
  ('QC', 'quality_check', 'Quality check', 'Quality check'),
  ('PACK', 'packing', 'Packing', 'Packing'),
  ('SHIP', 'shipped', 'Shipped, needs carrier and tracking', 'Shipped'),
  ('DELIVERED', 'delivered', 'Delivered', 'Delivered'),
  ('HOLD', 'hold', 'Put the case on hold', NULL),
  ('CANCEL', 'cancelled', 'Cancel the case', NULL)
ON CONFLICT (mes_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- MES event log: outcome per event. No patient data is ever stored here.
-- ---------------------------------------------------------------------------
ALTER TABLE mes_events ADD COLUMN source text NOT NULL DEFAULT 'mes' CHECK (source IN ('mes', 'csv'));
ALTER TABLE mes_events ADD COLUMN outcome text CHECK (outcome IN ('applied', 'ignored', 'error', 'duplicate'));
ALTER TABLE mes_events ADD COLUMN message text;
ALTER TABLE mes_events ADD COLUMN stage_code text;
ALTER TABLE mes_events ADD COLUMN occurred_at timestamptz;
CREATE INDEX mes_events_received_idx ON mes_events (received_at DESC);
CREATE INDEX mes_events_outcome_idx ON mes_events (outcome, received_at DESC);
CREATE INDEX mes_events_case_idx ON mes_events (case_id) WHERE case_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Cases: MES case id lookup, console filters, the routed event
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX cases_mes_case_id_uq ON cases (mes_case_id) WHERE mes_case_id IS NOT NULL;
CREATE INDEX cases_status_site_idx ON cases (status, site_id);
CREATE INDEX cases_purge_idx ON cases (purge_after) WHERE purge_after IS NOT NULL AND purged_at IS NULL;

ALTER TABLE case_events DROP CONSTRAINT case_events_type_check;
ALTER TABLE case_events ADD CONSTRAINT case_events_type_check CHECK (type IN (
  'created', 'submitted', 'resubmitted', 'files_checked', 'stage', 'stage_reported', 'on_hold', 'released',
  'cancelled', 'rerouted', 'claim_opened', 'replacement_ordered', 'rework_ordered', 'instructions_updated',
  'purged', 'portal_pushed', 'portal_push_failed', 'routed'
));

-- ---------------------------------------------------------------------------
-- Agreements: a free reference (contract number, document reference)
-- ---------------------------------------------------------------------------
ALTER TABLE agreements ADD COLUMN reference text;

-- ---------------------------------------------------------------------------
-- Scheduled jobs bookkeeping (daily retention)
-- ---------------------------------------------------------------------------
CREATE TABLE job_runs (
  name text PRIMARY KEY,
  last_run_at timestamptz NOT NULL,
  last_status text,
  last_detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY kline_only ON job_runs USING (kph_bypass()) WITH CHECK (kph_bypass());

-- ---------------------------------------------------------------------------
-- Audit chain verification for the API. The original function stays owner only; this wrapper is
-- SECURITY DEFINER and read only, so the app role never receives the trim function.
-- ---------------------------------------------------------------------------
CREATE FUNCTION kph_audit_verify_chain() RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM kph_audit_verify()
$$;

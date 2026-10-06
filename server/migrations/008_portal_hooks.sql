-- Phase 8: receiver for K Line portal webhooks. Additive only.
-- One receiver per partner organisation. The public hook id is in the address the portal calls; the secret token is
-- stored as a field encrypted value (AAD org|<org_id>|portal_hook) and is shown once. Nothing from a received message is stored here:
-- only counters and the outcome.
CREATE TABLE portal_hooks (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  hook_id text NOT NULL UNIQUE CHECK (hook_id ~ '^[A-Za-z0-9_-]{32}$'),
  secret_enc text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  last_received_at timestamptz,
  received_count bigint NOT NULL DEFAULT 0,
  last_result text CHECK (last_result IS NULL OR last_result IN ('ok', 'ignored', 'bad_secret')),
  -- wrong secret attempts: a counter, the last time, and the last time one was written to the audit log (at most one entry a minute)
  bad_secret_count bigint NOT NULL DEFAULT 0,
  last_bad_secret_at timestamptz,
  last_bad_audit_at timestamptz
);

ALTER TABLE portal_hooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_hooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_hooks USING (kph_can_access(org_id)) WITH CHECK (kph_can_access(org_id));

-- Looking for a queued or running single case sync (message bursts are coalesced into one job).
CREATE INDEX jobs_portal_sync_case_idx ON jobs ((payload->>'caseId')) WHERE kind = 'portal.sync.case' AND status IN ('queued', 'running');

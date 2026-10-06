-- Phase 6: partner API keys (management), webhooks with an outbox, email notice bookkeeping. Additive only.
-- Migration 001 already has api_keys. It had no webhook tables.

-- ---------------------------------------------------------------------------
-- API keys: who revoked, and a cheap list of the live ones per organisation
-- ---------------------------------------------------------------------------
ALTER TABLE api_keys ADD COLUMN revoked_by uuid;
CREATE INDEX api_keys_live_idx ON api_keys (org_id, created_at DESC) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Webhook endpoints of a partner
-- ---------------------------------------------------------------------------
CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (char_length(url) <= 500),
  events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
  description text CHECK (description IS NULL OR char_length(description) <= 200),
  -- whsec_... encrypted as a field, AAD webhook|<id>. Never returned after creation or rotation.
  secret_enc text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  disabled_reason text,
  disabled_at timestamptz,
  -- failed attempts in a row, reset by a success. 25 switches the endpoint off.
  consecutive_failures int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status_code int,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN ('delivered', 'failed')),
  secret_rotated_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_org_idx ON webhooks (org_id, created_at);

-- ---------------------------------------------------------------------------
-- Outbox: one row per event and endpoint, written in the same transaction as the business change.
-- The id is also the `id` of the payload and the x-kph-delivery header, and stays the same across retries.
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  -- references and counts only: never patient data or free text
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'delivered', 'dead')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_status_code int,
  -- fixed short text, never the endpoint's own answer
  last_error text,
  locked_until timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC, id);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);

-- ---------------------------------------------------------------------------
-- Email notices: at most one email per person and subject every 15 minutes. `pending` holds the latest notice that was
-- held back inside the window; a job sends it when the window ends, so the last state is never lost.
-- ---------------------------------------------------------------------------
CREATE TABLE email_notice_log (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  pending jsonb,
  PRIMARY KEY (user_id, dedupe_key)
);
CREATE INDEX email_notice_log_sent_idx ON email_notice_log (sent_at);

-- ---------------------------------------------------------------------------
-- Row level security: partners see only their own rows, K Line and the system bypass
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhooks', 'webhook_deliveries', 'email_notice_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (kph_can_access(org_id)) WITH CHECK (kph_can_access(org_id))', t);
  END LOOP;
END $$;

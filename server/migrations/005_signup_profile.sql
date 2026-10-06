-- Phase 5: self registration, K Line review, company profile. Additive only.

-- ---------------------------------------------------------------------------
-- Structured address (the old text column stays as a single line for lists and letters)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ADD COLUMN address_details jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Registrations are found by their sign up state (review tab, retention).
CREATE INDEX organizations_signup_idx ON organizations (created_at) WHERE signup ? 'at';

-- ---------------------------------------------------------------------------
-- Brands can carry a logo; documents carry a kind (qc_criteria, packaging, other)
-- ---------------------------------------------------------------------------
ALTER TABLE brands ADD COLUMN logo_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE brands ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE files ADD COLUMN doc_kind text CHECK (doc_kind IS NULL OR doc_kind IN ('qc_criteria', 'packaging', 'other'));
CREATE INDEX files_org_purpose_idx ON files (org_id, purpose) WHERE purpose IN ('logo', 'document');

-- ---------------------------------------------------------------------------
-- Public registration bookkeeping. No names, no addresses, no IP addresses: counts and hashes only.
-- ---------------------------------------------------------------------------
-- One row per registration attempt that got past validation (new and known addresses alike): the daily ceiling.
CREATE TABLE signup_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_attempts_at_idx ON signup_attempts (at);

-- Fixed text notices sent to an address ("you already have an account", "not approved"), at most one an hour per address and kind.
CREATE TABLE signup_mail_log (
  email_hash text NOT NULL,
  kind text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_hash, kind)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signup_attempts', 'signup_mail_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY kline_only ON %I USING (kph_bypass()) WITH CHECK (kph_bypass())', t);
  END LOOP;
END $$;

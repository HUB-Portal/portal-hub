-- K Line Partner Hub: initial schema (phase 1). Runs as kph_owner. Roles and grants are handled by the migration runner.

-- ---------------------------------------------------------------------------
-- Session setting helpers used by row level security
-- ---------------------------------------------------------------------------
CREATE FUNCTION kph_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('kph.bypass', true), ''), 'false')::boolean
$$;

CREATE FUNCTION kph_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('kph.org_id', true), '')::uuid
$$;

CREATE FUNCTION kph_can_access(o uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT kph_bypass() OR (o IS NOT NULL AND o = kph_org())
$$;

-- ---------------------------------------------------------------------------
-- Reference and organisation tables
-- ---------------------------------------------------------------------------
CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  city text,
  country text NOT NULL,
  eea boolean NOT NULL DEFAULT false,
  adequacy boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('kline', 'partner')),
  name text NOT NULL,
  code text CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  legal_name text,
  country text,
  vat_id text,
  address text,
  status text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'suspended')),
  retention_months int NOT NULL DEFAULT 24 CHECK (retention_months BETWEEN 1 AND 180),
  default_site_id uuid REFERENCES sites(id),
  logo_file_id uuid,
  contacts jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  signup jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_code_uq ON organizations (code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX organizations_one_kline ON organizations ((kind)) WHERE kind = 'kline';

CREATE TABLE org_sites (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, site_id)
);

CREATE TABLE agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('msa', 'qaa', 'dpa', 'scc', 'it')),
  version text NOT NULL DEFAULT '1.0',
  signed_at date,
  signed_by text,
  valid_until date,
  file_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX agreements_org_idx ON agreements (org_id, type);

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_org_name_uq ON brands (org_id, lower(name));

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  site_ids uuid[] NOT NULL DEFAULT '{}',
  auth_provider text NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local', 'oidc')),
  oidc_subject text,
  password_hash text,
  password_changed_at timestamptz,
  totp_secret_enc text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_enrolled_at timestamptz,
  totp_last_step bigint,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  failed_logins int NOT NULL DEFAULT 0,
  lockout_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  notify_email boolean NOT NULL DEFAULT true,
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_org_idx ON users (org_id);

CREATE TABLE user_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invite', 'reset', 'verify')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, kind);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  stage text NOT NULL CHECK (stage IN ('password', 'mfa_setup', 'full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  step_up_at timestamptz,
  mfa_failures int NOT NULL DEFAULT 0,
  mfa_window_start timestamptz,
  ip text,
  user_agent text,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  cidrs text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  last_used_ip text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);

CREATE TABLE oidc_flows (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  redirect text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- Specs, cases, files
-- ---------------------------------------------------------------------------
CREATE TABLE specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version int NOT NULL,
  title text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'signed', 'superseded')),
  partner_signed_by uuid,
  partner_signed_at timestamptz,
  kline_signed_by uuid,
  kline_signed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, version)
);

CREATE TABLE bulk_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  case_count int NOT NULL DEFAULT 0
);
CREATE INDEX bulk_batches_org_idx ON bulk_batches (org_id);

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref text NOT NULL UNIQUE,
  partner_case_id text,
  patient_enc text,
  patient_bidx text,
  brand_id uuid REFERENCES brands(id),
  kind text NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'replacement', 'rework')),
  parent_id uuid REFERENCES cases(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'on_hold', 'ready', 'received', 'in_production', 'shipped', 'delivered', 'cancelled')),
  stage text,
  hold_reason text,
  site_id uuid REFERENCES sites(id),
  spec_id uuid REFERENCES specs(id),
  notes_enc text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'rush')),
  due_date date,
  checks jsonb NOT NULL DEFAULT '{"errors":[],"warnings":[]}'::jsonb,
  warnings_acknowledged boolean NOT NULL DEFAULT false,
  warnings_acknowledged_at timestamptz,
  warnings_acknowledged_by uuid,
  aligners_upper int NOT NULL DEFAULT 0,
  aligners_lower int NOT NULL DEFAULT 0,
  aligners_templates int NOT NULL DEFAULT 0,
  aligners_shipped int NOT NULL DEFAULT 0,
  mes_case_id text,
  carrier text,
  tracking text,
  submitted_at timestamptz,
  ready_at timestamptz,
  received_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  purge_after timestamptz,
  purged_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  manufacturing_mode text NOT NULL DEFAULT 'standard' CHECK (manufacturing_mode IN ('standard', 'direct')),
  patient_first_enc text,
  patient_last_enc text,
  portal_case_uuid text,
  portal_push jsonb,
  bulk_batch_id uuid REFERENCES bulk_batches(id),
  CONSTRAINT cases_identifier_chk CHECK (
    purged_at IS NOT NULL OR partner_case_id IS NOT NULL OR patient_enc IS NOT NULL OR patient_first_enc IS NOT NULL
  ),
  CONSTRAINT cases_direct_names_chk CHECK (
    manufacturing_mode <> 'direct' OR purged_at IS NOT NULL OR (patient_first_enc IS NOT NULL AND patient_last_enc IS NOT NULL)
  )
);
CREATE INDEX cases_org_status_idx ON cases (org_id, status, created_at DESC);
CREATE INDEX cases_bidx_idx ON cases (org_id, patient_bidx) WHERE patient_bidx IS NOT NULL;
CREATE INDEX cases_bulk_idx ON cases (bulk_batch_id) WHERE bulk_batch_id IS NOT NULL;
CREATE UNIQUE INDEX cases_partner_id_uq ON cases (org_id, lower(partner_case_id))
  WHERE kind = 'new' AND partner_case_id IS NOT NULL AND cancelled_at IS NULL;

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('case', 'claim', 'logo', 'document', 'agreement', 'shipment')),
  case_id uuid REFERENCES cases(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('stl', 'pts', 'pdf', 'csv', 'svg', 'image', 'video', 'other')),
  arch text CHECK (arch IN ('upper', 'lower')),
  step int,
  is_template boolean NOT NULL DEFAULT false,
  name_enc text,
  ext text,
  content_type text,
  size bigint NOT NULL DEFAULT 0,
  chunk_size int NOT NULL DEFAULT 8388608,
  chunk_count int NOT NULL DEFAULT 0,
  wrapped_key text,
  key_id text,
  nonce_prefix text,
  storage_prefix text,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'processing', 'ready', 'rejected', 'purged')),
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'error', 'skipped')),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploader_id uuid,
  api_key_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  processed_at timestamptz,
  purged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_case_idx ON files (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX files_org_idx ON files (org_id, created_at DESC);

ALTER TABLE organizations ADD CONSTRAINT organizations_logo_fk FOREIGN KEY (logo_file_id) REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE agreements ADD CONSTRAINT agreements_file_fk FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL;

CREATE TABLE file_chunks (
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idx int NOT NULL,
  size int NOT NULL,
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, idx)
);

CREATE TABLE case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'created', 'submitted', 'resubmitted', 'files_checked', 'stage', 'stage_reported', 'on_hold', 'released',
    'cancelled', 'rerouted', 'claim_opened', 'replacement_ordered', 'rework_ordered', 'instructions_updated',
    'purged', 'portal_pushed', 'portal_push_failed'
  )),
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_events_case_idx ON case_events (case_id, created_at);

CREATE TABLE mes_stage_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mes_code text NOT NULL UNIQUE,
  stage text NOT NULL,
  status text,
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mes_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text UNIQUE,
  case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org_idx ON notifications (org_id, created_at DESC);

CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 6,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';

CREATE TABLE counters (
  key text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0
);

CREATE TABLE dev_mailbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_addr text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit log: append only, hash chained
-- ---------------------------------------------------------------------------
CREATE TABLE audit_anchor (
  id int PRIMARY KEY CHECK (id = 1),
  last_seq bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL,
  trimmed_seq bigint NOT NULL DEFAULT 0,
  trimmed_hash text NOT NULL
);
INSERT INTO audit_anchor (id, last_seq, last_hash, trimmed_seq, trimmed_hash)
VALUES (1, 0, encode(sha256('kph-audit-genesis'::bytea), 'hex'), 0, encode(sha256('kph-audit-genesis'::bytea), 'hex'));

CREATE TABLE audit_log (
  seq bigint PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'service', 'system')),
  actor_id text,
  org_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  ip text,
  user_agent text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, seq DESC);
CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE FUNCTION kph_audit_canonical(
  p_seq bigint, p_at timestamptz, p_actor_type text, p_actor_id text, p_org_id uuid, p_action text,
  p_target_type text, p_target_id text, p_ip text, p_ua text, p_details jsonb
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(
    p_seq, to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), p_actor_type, p_actor_id, p_org_id,
    p_action, p_target_type, p_target_id, p_ip, p_ua, p_details
  )::text
$$;

-- The four SECURITY DEFINER functions below need row level security bypass while they run. They switch it on inside the body
-- and put the caller's value back before every RETURN, instead of using a function level "SET kph.bypass = 'true'": that
-- form needs superuser (or an explicit GRANT SET ON PARAMETER) on PostgreSQL 15 and later, which managed hosts such as Neon do not give.
-- set_config(..., true) is transaction local, and a failed statement or rolled back savepoint undoes it as well.
CREATE FUNCTION kph_audit_append(
  p_actor_type text, p_actor_id text, p_org_id uuid, p_action text, p_target_type text, p_target_id text,
  p_ip text, p_ua text, p_details jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bypass text := current_setting('kph.bypass', true);
  a audit_anchor%ROWTYPE;
  v_seq bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
  v_hash text;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
BEGIN
  PERFORM set_config('kph.bypass', 'true', true);
  SELECT * INTO a FROM audit_anchor WHERE id = 1 FOR UPDATE;
  v_seq := a.last_seq + 1;
  v_hash := encode(sha256(convert_to(
    a.last_hash || kph_audit_canonical(v_seq, v_at, p_actor_type, p_actor_id, p_org_id, p_action, p_target_type, p_target_id, p_ip, p_ua, v_details),
    'UTF8')), 'hex');
  INSERT INTO audit_log (seq, at, actor_type, actor_id, org_id, action, target_type, target_id, ip, user_agent, details, prev_hash, hash)
  VALUES (v_seq, v_at, p_actor_type, p_actor_id, p_org_id, p_action, p_target_type, p_target_id, p_ip, p_ua, v_details, a.last_hash, v_hash);
  UPDATE audit_anchor SET last_seq = v_seq, last_hash = v_hash WHERE id = 1;
  PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
  RETURN v_seq;
END $$;

-- Walks the chain from the last trim anchor. Returns (ok, checked, first_bad_seq).
CREATE FUNCTION kph_audit_verify() RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bypass text := current_setting('kph.bypass', true);
  a audit_anchor%ROWTYPE;
  r audit_log%ROWTYPE;
  v_prev text;
  v_expected_seq bigint;
  v_count bigint := 0;
BEGIN
  PERFORM set_config('kph.bypass', 'true', true);
  SELECT * INTO a FROM audit_anchor WHERE id = 1;
  v_prev := a.trimmed_hash;
  v_expected_seq := a.trimmed_seq + 1;
  FOR r IN SELECT * FROM audit_log ORDER BY seq LOOP
    IF r.seq <> v_expected_seq OR r.prev_hash <> v_prev OR r.hash <> encode(sha256(convert_to(
         v_prev || kph_audit_canonical(r.seq, r.at, r.actor_type, r.actor_id, r.org_id, r.action, r.target_type, r.target_id, r.ip, r.user_agent, r.details),
         'UTF8')), 'hex') THEN
      PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
      RETURN QUERY SELECT false, v_count, r.seq;
      RETURN;
    END IF;
    v_prev := r.hash;
    v_expected_seq := r.seq + 1;
    v_count := v_count + 1;
  END LOOP;
  IF v_prev <> a.last_hash OR v_expected_seq - 1 <> a.last_seq THEN
    PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
    RETURN QUERY SELECT false, v_count, v_expected_seq;
    RETURN;
  END IF;
  PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
  RETURN QUERY SELECT true, v_count, NULL::bigint;
END $$;

-- Removes entries older than p_before (a contiguous prefix only) and moves the anchor. Owner only.
CREATE FUNCTION kph_audit_trim(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bypass text := current_setting('kph.bypass', true);
  v_upto bigint;
  v_hash text;
  v_deleted bigint;
BEGIN
  PERFORM set_config('kph.bypass', 'true', true);
  PERFORM 1 FROM audit_anchor WHERE id = 1 FOR UPDATE;
  SELECT coalesce(min(seq) - 1, (SELECT max(seq) FROM audit_log)) INTO v_upto FROM audit_log WHERE at >= p_before;
  IF v_upto IS NULL OR v_upto <= (SELECT trimmed_seq FROM audit_anchor WHERE id = 1) THEN
    PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
    RETURN 0;
  END IF;
  SELECT hash INTO v_hash FROM audit_log WHERE seq = v_upto;
  PERFORM set_config('kph.audit_maint', 'on', true);
  DELETE FROM audit_log WHERE seq <= v_upto;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE audit_anchor SET trimmed_seq = v_upto, trimmed_hash = v_hash WHERE id = 1;
  PERFORM set_config('kph.audit_maint', 'off', true);
  PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
  RETURN v_deleted;
END $$;

-- Extra guard: even the table owner cannot modify entries outside kph_audit_trim.
CREATE FUNCTION kph_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('kph.audit_maint', true), '') = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION kph_audit_guard();
CREATE TRIGGER audit_log_guard_trunc BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION kph_audit_guard();

-- Monotonic counters (case references etc.)
CREATE FUNCTION kph_next_counter(p_key text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bypass text := current_setting('kph.bypass', true);
  v bigint;
BEGIN
  PERFORM set_config('kph.bypass', 'true', true);
  INSERT INTO counters (key, value) VALUES (p_key, 1)
  ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
  RETURNING value INTO v;
  PERFORM set_config('kph.bypass', coalesce(v_bypass, ''), true);
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION kph_audit_append(text, text, uuid, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION kph_audit_verify() FROM PUBLIC;
REVOKE ALL ON FUNCTION kph_audit_trim(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION kph_audit_canonical(bigint, timestamptz, text, text, uuid, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION kph_next_counter(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kph_audit_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kph_bypass(), kph_org(), kph_can_access(uuid) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Row level security. FORCE applies it to the table owner as well.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_sites', 'agreements', 'brands', 'users', 'user_tokens', 'sessions', 'api_keys', 'specs', 'bulk_batches',
    'cases', 'files', 'file_chunks', 'case_events', 'notifications', 'jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (kph_can_access(org_id)) WITH CHECK (kph_can_access(org_id))', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['oidc_flows', 'mes_stage_map', 'mes_events', 'dev_mailbox', 'counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY kline_only ON %I USING (kph_bypass()) WITH CHECK (kph_bypass())', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (kph_can_access(id)) WITH CHECK (kph_can_access(id));

-- Sites are shared reference data: everyone reads, only K Line (bypass) writes.
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
CREATE POLICY sites_read ON sites FOR SELECT USING (true);
CREATE POLICY sites_write ON sites FOR ALL USING (kph_bypass()) WITH CHECK (kph_bypass());

-- Audit log: readable per organisation; inserts only through kph_audit_append; deletes only inside kph_audit_trim.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT USING (kph_can_access(org_id));
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_maint_delete ON audit_log FOR DELETE USING (coalesce(current_setting('kph.audit_maint', true), '') = 'on');

ALTER TABLE audit_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY anchor_all ON audit_anchor USING (kph_bypass()) WITH CHECK (kph_bypass());

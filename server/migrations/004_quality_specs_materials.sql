-- Phase 4: quality claims, production specifications, child cases and partner supplied materials. Additive only.
-- Migration 001 already holds `specs` (with older status names) and the file purposes `claim` and `shipment`.

-- ---------------------------------------------------------------------------
-- Specs: new status names, hash, signatures, rejection, one active version per organisation
-- ---------------------------------------------------------------------------
ALTER TABLE specs DROP CONSTRAINT specs_status_check;
UPDATE specs SET status = 'proposed' WHERE status = 'pending';
UPDATE specs SET status = 'active' WHERE status = 'signed';
ALTER TABLE specs ADD CONSTRAINT specs_status_check CHECK (status IN ('draft', 'proposed', 'active', 'superseded', 'rejected'));

ALTER TABLE specs ADD COLUMN content_hash text;
ALTER TABLE specs ADD COLUMN change_note text;
ALTER TABLE specs ADD COLUMN created_side text NOT NULL DEFAULT 'partner' CHECK (created_side IN ('partner', 'kline'));
ALTER TABLE specs ADD COLUMN proposed_by uuid;
ALTER TABLE specs ADD COLUMN proposed_at timestamptz;
ALTER TABLE specs ADD COLUMN partner_signed_name text;
ALTER TABLE specs ADD COLUMN kline_signed_name text;
ALTER TABLE specs ADD COLUMN rejection_note text;
ALTER TABLE specs ADD COLUMN rejected_by uuid;
ALTER TABLE specs ADD COLUMN rejected_at timestamptz;
ALTER TABLE specs ADD COLUMN activated_at timestamptz;
ALTER TABLE specs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX specs_one_active_uq ON specs (org_id) WHERE status = 'active';
CREATE INDEX specs_org_idx ON specs (org_id, version DESC);

-- ---------------------------------------------------------------------------
-- Quality claims
-- ---------------------------------------------------------------------------
CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE,
  case_id uuid NOT NULL REFERENCES cases(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'awaiting_partner', 'accepted', 'rejected', 'closed')),
  resolution text CHECK (resolution IN ('remake', 'credit', 'no_action', 'other')),
  summary text NOT NULL,
  description text,
  spec_clause_ids text[] NOT NULL DEFAULT '{}',
  root_cause text,
  corrective_action text,
  decision_note text,
  rework_case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  opened_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_org_status_idx ON claims (org_id, status, created_at DESC);
CREATE INDEX claims_case_idx ON claims (case_id);
CREATE INDEX claims_status_idx ON claims (status, created_at DESC);

CREATE TABLE claim_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  arch text NOT NULL CHECK (arch IN ('upper', 'lower')),
  step int NOT NULL CHECK (step BETWEEN 0 AND 999),
  is_template boolean NOT NULL DEFAULT false,
  defect_code text NOT NULL,
  note text,
  /** Order in which the partner listed the aligners. */
  pos int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_items_claim_idx ON claim_items (claim_id);

CREATE TABLE claim_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  author_id uuid,
  side text NOT NULL CHECK (side IN ('partner', 'kline', 'system')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_messages_claim_idx ON claim_messages (claim_id, created_at);

-- ---------------------------------------------------------------------------
-- Partner supplied materials
-- ---------------------------------------------------------------------------
CREATE TABLE materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('box', 'bag', 'elastic', 'button', 'insert', 'other')),
  unit text NOT NULL DEFAULT 'pieces',
  per_case numeric NOT NULL DEFAULT 0 CHECK (per_case >= 0),
  per_aligner numeric NOT NULL DEFAULT 0 CHECK (per_aligner >= 0),
  min_stock numeric NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX materials_org_sku_uq ON materials (org_id, lower(sku));

CREATE TABLE material_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE,
  site_id uuid NOT NULL REFERENCES sites(id),
  carrier text,
  tracking text,
  expected_date date,
  status text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received', 'discrepancy', 'cancelled')),
  declared_by uuid,
  received_by uuid,
  received_at timestamptz,
  receive_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_shipments_org_idx ON material_shipments (org_id, created_at DESC);
CREATE INDEX material_shipments_status_idx ON material_shipments (status, site_id);

CREATE TABLE material_shipment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL REFERENCES material_shipments(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES materials(id),
  quantity int NOT NULL CHECK (quantity > 0),
  received_quantity int CHECK (received_quantity >= 0),
  UNIQUE (shipment_id, material_id)
);

CREATE TABLE material_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id),
  kind text NOT NULL CHECK (kind IN ('receipt', 'consumption', 'adjustment')),
  quantity numeric NOT NULL,
  case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  shipment_id uuid REFERENCES material_shipments(id) ON DELETE SET NULL,
  reason text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_movements_stock_idx ON material_movements (material_id, site_id, created_at);
-- A case books its consumption once.
CREATE UNIQUE INDEX material_movements_consumption_uq ON material_movements (case_id, material_id) WHERE kind = 'consumption' AND case_id IS NOT NULL;

-- Last low stock notice per material and site (at most one a day).
CREATE TABLE material_alerts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id),
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, site_id)
);

-- ---------------------------------------------------------------------------
-- Files: claim evidence, shipment documents, files shared with a child case
-- ---------------------------------------------------------------------------
ALTER TABLE files ADD COLUMN claim_id uuid REFERENCES claims(id) ON DELETE CASCADE;
ALTER TABLE files ADD COLUMN shipment_id uuid REFERENCES material_shipments(id) ON DELETE CASCADE;
-- A child case (replacement or rework) reuses the stored bytes of its parent's file. The stored data is bound to the
-- parent's file id, so the child's row remembers it here. NULL means the file's own id.
ALTER TABLE files ADD COLUMN cipher_file_id uuid;
CREATE INDEX files_claim_idx ON files (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX files_shipment_idx ON files (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX files_storage_prefix_idx ON files (storage_prefix) WHERE storage_prefix IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Cases: child case items, rework link to the claim
-- ---------------------------------------------------------------------------
ALTER TABLE cases ADD COLUMN requested_items jsonb;
ALTER TABLE cases ADD COLUMN claim_id uuid REFERENCES claims(id) ON DELETE SET NULL;
CREATE INDEX cases_parent_idx ON cases (parent_id) WHERE parent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row level security for the new tables (partners see only their own organisation)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['claims', 'claim_items', 'claim_messages', 'materials', 'material_shipments', 'material_shipment_lines', 'material_movements', 'material_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (kph_can_access(org_id)) WITH CHECK (kph_can_access(org_id))', t);
  END LOOP;
END $$;

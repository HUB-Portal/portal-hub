-- A patient ID may be used more than once for direct manufacturing cases (the same patient can have several cases).
-- The case ID of a standard case stays unique per partner. Additive: only the unique index is narrowed to standard cases.
DROP INDEX IF EXISTS cases_partner_id_uq;
CREATE UNIQUE INDEX cases_partner_id_uq ON cases (org_id, lower(partner_case_id))
  WHERE kind = 'new' AND manufacturing_mode = 'standard' AND partner_case_id IS NOT NULL AND cancelled_at IS NULL;

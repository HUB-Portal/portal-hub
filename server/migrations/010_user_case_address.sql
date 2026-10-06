-- A Case address of one's own for every partner user (the nine portal shipping fields, see shared/caseAddress.ts).
-- Null means the user has none: the company address in organizations.settings.case_address is used. Additive only.
-- Row level security on users is unchanged: the column is tenant isolated like the rest of the row.
ALTER TABLE users ADD COLUMN case_address jsonb;

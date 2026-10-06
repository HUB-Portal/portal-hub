-- Phase 7: Google Workspace sign in for K Line staff. Additive only.

-- A sign in flow is bound to the browser that started it (a hash of a short lived cookie), so a link cannot be completed in another browser.
ALTER TABLE oidc_flows ADD COLUMN browser_hash text;

-- The stable Google account id (the `sub` claim) is remembered at the first Google sign in and must match from then on.
-- (users.oidc_subject already exists from migration 001.)
CREATE UNIQUE INDEX users_oidc_subject_uq ON users (oidc_subject) WHERE oidc_subject IS NOT NULL;

-- Staff created with `create-admin --google` have auth_provider 'google'.
ALTER TABLE users DROP CONSTRAINT users_auth_provider_check;
ALTER TABLE users ADD CONSTRAINT users_auth_provider_check CHECK (auth_provider IN ('local', 'oidc', 'google'));

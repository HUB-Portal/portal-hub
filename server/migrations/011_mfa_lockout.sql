-- Wrong second factor codes are counted per user across sessions (not per session), so a fresh password sign in no longer gives
-- five fresh guesses. Additive only. A correct password never resets these columns; only a correct authenticator code
-- (or an administrator unlock, or a password reset by email link) does.
ALTER TABLE users
  ADD COLUMN mfa_failed_codes integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_fail_window_start timestamptz,
  ADD COLUMN mfa_lockout_count integer NOT NULL DEFAULT 0;

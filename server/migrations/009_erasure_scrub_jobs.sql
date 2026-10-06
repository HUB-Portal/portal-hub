-- Erasure on demand, scrubbing of what a purge used to leave behind, transfer gate holds, and one time links in failed email jobs.
-- Additive only.

-- A new case event type: the partner (or K Line) erased the case data on request.
ALTER TABLE case_events DROP CONSTRAINT case_events_type_check;
ALTER TABLE case_events ADD CONSTRAINT case_events_type_check CHECK (type IN (
  'created', 'submitted', 'resubmitted', 'files_checked', 'stage', 'stage_reported', 'on_hold', 'released',
  'cancelled', 'rerouted', 'claim_opened', 'replacement_ordered', 'rework_ordered', 'instructions_updated',
  'purged', 'portal_pushed', 'portal_push_failed', 'routed', 'erased'
));

-- Set when the personal data around a purged or erased case (patient ID of direct cases, hold reasons, claim text, webhook payload ids)
-- was removed. The retention job scrubs purged cases that do not have it yet, so cases purged before this migration are cleaned too.
ALTER TABLE cases ADD COLUMN scrubbed_at timestamptz;
CREATE INDEX cases_unscrubbed_idx ON cases (id) WHERE purged_at IS NOT NULL AND scrubbed_at IS NULL;

-- Email jobs can hold invitation and reset links with one time tokens. Wipe the payload of every failed email job, and of
-- every email job older than 24 hours whatever its state (an old email is never worth sending). Short fixed error text only.
UPDATE jobs
   SET payload = '{}'::jsonb,
       last_error = 'The email could not be sent.',
       status = CASE WHEN status IN ('done', 'failed') THEN status ELSE 'failed' END,
       finished_at = COALESCE(finished_at, now()),
       locked_at = NULL
 WHERE kind = 'email.send' AND (status = 'failed' OR created_at < now() - interval '24 hours');

-- Failed jobs of other kinds: keep the error text free of addresses and links.
UPDATE jobs
   SET last_error = regexp_replace(regexp_replace(last_error, 'https?://[^[:space:]]+', '[link removed]', 'gi'), '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', '[address removed]', 'g')
 WHERE last_error IS NOT NULL AND (last_error ~* 'https?://' OR last_error ~ '@');

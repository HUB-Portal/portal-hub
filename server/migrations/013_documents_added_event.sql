-- A new case event type: the partner added documents to a case after it was sent (paperclip "Add documents", usability review of 8 Oct 2026).
-- Additive only.
ALTER TABLE case_events DROP CONSTRAINT case_events_type_check;
ALTER TABLE case_events ADD CONSTRAINT case_events_type_check CHECK (type IN (
  'created', 'submitted', 'resubmitted', 'files_checked', 'stage', 'stage_reported', 'on_hold', 'released',
  'cancelled', 'rerouted', 'claim_opened', 'replacement_ordered', 'rework_ordered', 'instructions_updated',
  'purged', 'portal_pushed', 'portal_push_failed', 'routed', 'erased', 'documents_added'
));

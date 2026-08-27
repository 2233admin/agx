-- Phase 2 follow-up: bind deployment and operation records to the exact config revision.
ALTER TABLE deployment_status ADD COLUMN revision_id TEXT;
ALTER TABLE operation_status ADD COLUMN revision_id TEXT;

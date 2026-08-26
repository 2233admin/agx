-- Preserve the nullable Unknown Fact metadata for deployment_status.last_operation_id.
-- The repository guards each ALTER with pragma_table_info for idempotent upgrades.
ALTER TABLE deployment_status ADD COLUMN last_operation_reason TEXT;
ALTER TABLE deployment_status ADD COLUMN last_operation_observed_at TEXT;

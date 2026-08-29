-- Phase 2: local deployment and operation status state.
-- STRICT tables, explicit columns, and no external payloads.

CREATE TABLE IF NOT EXISTS deployment_status (
  deployment_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN (
    'planned', 'applying', 'configured', 'awaiting', 'drifted',
    'inconclusive', 'failed', 'verified'
  )),
  last_operation_id TEXT,
  reason TEXT,
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS operation_status (
  operation_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployment_status (deployment_id),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared', 'applying', 'observing', 'succeeded', 'degraded',
    'failed', 'cancelled', 'inconclusive', 'needs-resume',
    'needs-manual-cleanup', 'verified'
  )),
  reason TEXT,
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operation_status_deployment_id
  ON operation_status (deployment_id);

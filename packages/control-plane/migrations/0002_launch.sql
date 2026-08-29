-- Story 1.2: launch plan state machine storage. STRICT, explicit columns,
-- no `SELECT *` in any query against this table. Independent of Story
-- 1.1's migration -- both share the same .sqlite3 file but manage their
-- own tables/migrations.

CREATE TABLE IF NOT EXISTS launch_plan (
  plan_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  config_name TEXT NOT NULL,
  client TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared', 'awaiting-confirmation', 'applying', 'observing',
    'succeeded', 'degraded', 'failed', 'cancelled', 'requires-restart', 'incomplete'
  )),
  created_at TEXT NOT NULL,

  confirmed_at_status TEXT NOT NULL CHECK (confirmed_at_status IN ('known', 'unknown')),
  confirmed_at_value TEXT,
  confirmed_at_reason TEXT,
  confirmed_at_observed_at TEXT,

  failure_reason_status TEXT NOT NULL CHECK (failure_reason_status IN ('known', 'unknown')),
  failure_reason_value TEXT,
  failure_reason_reason TEXT,
  failure_reason_observed_at TEXT,

  observed_outcome_status TEXT NOT NULL CHECK (observed_outcome_status IN ('known', 'unknown')),
  observed_outcome_value TEXT CHECK (observed_outcome_value IN ('succeeded', 'degraded', 'failed', 'incomplete')),
  observed_outcome_reason TEXT,
  observed_outcome_observed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_launch_plan_client_created_at
  ON launch_plan (client, created_at);

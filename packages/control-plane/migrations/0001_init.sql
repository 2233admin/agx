-- Story 1.1: read-only configuration revision storage.
-- STRICT tables, explicit columns, no `SELECT *` in any query against them.

CREATE TABLE IF NOT EXISTS stable_config (
  config_name TEXT PRIMARY KEY
) STRICT;

CREATE TABLE IF NOT EXISTS stable_config_revision (
  revision_id TEXT PRIMARY KEY,
  config_name TEXT NOT NULL REFERENCES stable_config (config_name),
  schema_version INTEGER NOT NULL,
  default_marker_status TEXT NOT NULL CHECK (default_marker_status IN ('known', 'unknown')),
  default_marker_value TEXT CHECK (default_marker_value IN ('true', 'false')),
  default_marker_reason TEXT,
  default_marker_observed_at TEXT,

  scope_boundary_status TEXT NOT NULL CHECK (scope_boundary_status IN ('known', 'unknown')),
  scope_boundary_value TEXT,
  scope_boundary_reason TEXT,
  scope_boundary_observed_at TEXT,

  availability_status TEXT NOT NULL CHECK (availability_status IN ('known', 'unknown')),
  availability_value TEXT,
  availability_reason TEXT,
  availability_observed_at TEXT,

  -- Each column holds a JSON array of CapabilityReference (see
  -- src/domain/config.ts). Never raw prompt text, credentials,
  -- transcripts or tool payloads.
  instructions_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  mcp_json TEXT NOT NULL,
  hooks_json TEXT NOT NULL,
  plugins_json TEXT NOT NULL,

  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_stable_config_revision_config_name
  ON stable_config_revision (config_name);

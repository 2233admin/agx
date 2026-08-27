-- Versioned append-only operation step events. Each transition adds a higher
-- revision for the same planned sequence; the latest revision is the current projection.
CREATE TABLE IF NOT EXISTS operation_step (
  operation_id TEXT NOT NULL REFERENCES operation_status (operation_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('github-repository', 'github-project', 'provider-activation')),
  resource TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'succeeded', 'inconclusive', 'needs-manual-cleanup')),
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, sequence, revision),
  CHECK (length(resource) > 0),
  CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 128 AND reason NOT GLOB '*[^a-z0-9-]*'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operation_step_latest
  ON operation_step (operation_id, sequence, revision DESC);

CREATE TABLE IF NOT EXISTS operation_resolution (
  operation_id TEXT NOT NULL REFERENCES operation_status(operation_id),
  deployment_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL CHECK (kind IN ('github-repository', 'github-project', 'provider-activation')),
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'absent', 'drifted')),
  fingerprint TEXT NOT NULL CHECK (fingerprint GLOB '[0-9a-f]*' AND length(fingerprint) = 64),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, sequence)
) STRICT;

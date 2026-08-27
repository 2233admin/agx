# Changelog

All notable changes to AGXCLI are documented here.

## [0.1.0.0] - 2026-08-27

### Added

- Added the Agent System X Project configs-primary migration proposal, design, BDD specification, and bounded task plan under `openspec/changes/configs-primary-migration/`.
- Imported the upstream `agent-systemX` `packages/control-plane` baseline at commit `139b2e770dbe56c1530a1d7ae79cc03eda7091b`, including its ConfigRevision, LaunchPlan, domain facts, SQLite migrations, repositories, and tests.
- Added pure configs domain contracts for deployment ownership, deployment and operation status transitions, external evidence observations, and status redaction.
- Added typed SQLite persistence for current DeploymentStatus and OperationStatus records with strict tables, explicit columns, parameterized updates, foreign-key enforcement, and versioned Fact metadata migration.

### Changed

- Added the `agx config` transitional bridge and runtime status presentation while the final configs-primary migration remains in progress.
- Added Bundle descriptor/schema support and synthetic fixture coverage for a platform-specific configs runtime without changing the production manifest.
- Clarified migration phases, ownership, security boundaries, remote-resource retention, and the eventual deletion plan for the old AGX installer, Bundle, archive, and sidecar paths.
- Kept the old AGX installer and sidecar transitional. They are not deleted by this release and remain separate from the final configs-primary authority.

### Fixed

- Preserved unknown deployment operation Fact reason and observation timestamps across SQLite round-trips.
- Made the versioned Fact-column migration idempotent and tolerant of duplicate-column and SQLite lock races.
- Hardened pure-domain evidence freshness, ownership fingerprints, migration input validation, reserved path handling, and typed test coverage.

### Release gate

- No published, verifiable upstream `configs-v*` Release/tag/assets were available at release preparation time. Production configs distribution and cutover remain blocked by G0; no upstream release tag, commit, URL, or digest is fabricated here.

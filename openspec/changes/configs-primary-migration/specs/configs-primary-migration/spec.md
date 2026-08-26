# Specification: configs-primary-migration

## Purpose

Define the observable contracts for moving AGX business capabilities into a single `configs` CLI/state/runtime authority and deleting the old AGX local installer, Bundle, and sidecar path.

## Requirement 1: configs is the sole final authority

The final supported workflow MUST execute through `configs`. It MUST use one versioned local state store and one operation journal for configuration, deployment, lifecycle, migration, upgrade, rollback, and uninstall. No final workflow may require an AGX Bundle or `.agx/receipt.json`.

### Scenario: fresh configs deployment uses one state owner

- **Given** the operator has a supported `configs` distribution and valid external credentials already configured in their official stores
- **And** the operator selects a new installation/workspace scope
- **When** the operator runs the configs initialization workflow
- **Then** configs creates or updates only its versioned state store and operation journal
- **And** the workflow does not download an AGX Bundle, extract an `agent-plugins` archive, create a runtime sidecar, or write `.agx/receipt.json`
- **And** status can reconstruct the operation from configs state alone

### Scenario: legacy AGX mutation path is rejected after cutover

- **Given** the old AGX binary or an old `--bundle` invocation is present
- **When** the operator attempts to create or update an installation through that path after cutover
- **Then** no AGX Bundle is downloaded and no legacy Receipt is written
- **And** the command returns a migration/handoff result that names the configs workflow
- **And** no remote resource is mutated by the rejected path

## Requirement 2: upstream release gate

Production support MUST require a real upstream `configs-v*` release or official package with target-platform assets, checksums/provenance, source identity, and documented CLI/state contracts. The implementation MUST NOT invent release details or use mutable source.

### Scenario: missing upstream release blocks production

- **Given** the upstream release query has no published `configs-v*` release with required assets and checksums
- **When** a maintainer evaluates the production cutover gate
- **Then** Gate G0 is rejected as blocked
- **And** the production manifest is not changed to add an invented tag, hash, URL, or asset
- **And** only deterministic fixtures or explicitly non-production packages may be used for development verification

### Scenario: verified upstream release permits planning, not silent assumptions

- **Given** a later upstream release provides verifiable source identity, platform assets, checksums, and CLI/state documentation
- **When** the maintainer records the release evidence
- **Then** the exact evidence is attached to G0 and used to pin implementation and smoke tests
- **And** unsupported platforms remain preview-only until separately evidenced

## Requirement 3: capability parity

Configs MUST expose or compose typed operations for GitHub repositories, GitHub Projects, Provider activation, Multica subjects/readback, Evidence Profiles, init, activation, bootstrap, first-use, recovery, status, diagnose, Receipt/operation history, upgrade, rollback, and uninstall.

### Scenario: init provisions deployment resources in order

- **Given** a valid owner, provider selection, profile, visibility, template version, and Evidence Profile
- **When** the operator requests a read-only plan
- **Then** configs lists the intended repositories, Project, Provider actions, template digest, evidence subject, risks, and compensation without mutation
- **When** the operator confirms the plan
- **Then** configs creates only deployment-owned resources, records structured readback and ownership, and activates selected Providers after required remote resources exist
- **And** the operation journal records each stage and result

### Scenario: same-name or unknown-owner resource is rejected

- **Given** a target repository, Project, or Provider source already exists without a matching ownership record
- **When** the operator runs the apply workflow
- **Then** configs stops before adopting, overwriting, or rebinding that resource
- **And** status reports a typed conflict and a safe next action
- **And** remote state is left unchanged by the rejected mutation

### Scenario: first-use evidence is recorded without private execution data

- **Given** initialization completed and a first-use contract is available
- **When** an Agent/client creates the Bootstrap Verification Issue, Project item, and PR through the documented workflow
- **Then** configs records only allowlisted URLs, identifiers, statuses, timestamps, and evidence summaries
- **And** prompts, transcripts, sessions, private content, credentials, and tool payloads are not persisted

## Requirement 4: recovery and uncertain remote mutation

Every remote mutation and lifecycle operation MUST have an idempotency identity, durable stage, structured readback, and explicit compensation or manual-cleanup result. An uncertain response MUST NOT be interpreted as absence or success.

### Scenario: interrupted initialization resumes safely

- **Given** configs has a journal with completed repository creation and an interrupted Project step
- **When** the operator reruns the same operation identity
- **Then** configs verifies the recorded repository through structured readback
- **And** it performs only the missing Project step or reports the exact conflict
- **And** it does not duplicate or overwrite the repository

### Scenario: timeout produces an inconclusive result

- **Given** a remote mutation reaches its deadline without a conclusive readback
- **When** the operation returns
- **Then** configs records `inconclusive` or `needs_resume`
- **And** status and diagnose identify the uncertain stage and readback action
- **And** configs does not report `configured` or `verified` solely from the timeout path

## Requirement 5: unified status and diagnose

`configs status` and `configs diagnose` MUST present local state, configuration active revision, deployment bindings, Provider state, Multica readback, Evidence freshness, operation stage, drift, and next action from one state projection. Human and JSON output MUST use an allowlist.

### Scenario: healthy deployment is configured but not verified without evidence

- **Given** local bindings and external resource readback match
- **And** the current Evidence Profile still lacks one required fresh observation
- **When** the operator requests status
- **Then** status reports `configured` or `awaiting` according to the state machine
- **And** status does not report `verified`
- **And** diagnose names the missing Evidence requirement and next observation

### Scenario: drift is visible and fail-closed

- **Given** a deployment binding, Provider source, Multica selector, or local state digest no longer matches the recorded identity
- **When** the operator requests status or tries a dependent mutation
- **Then** status reports `drifted` with the affected binding and safe repair action
- **And** dependent mutation stops before writing remote or local state

## Requirement 6: Receipt, upgrade, rollback, and uninstall ownership

Configs MUST replace the legacy Receipt with versioned operation/resource records. Upgrade and rollback MUST be journaled and scoped to configs-owned state. Uninstall MUST remove only explicitly owned local objects and MUST retain remote repositories and Projects by default.

### Scenario: old receipt is imported once

- **Given** a legacy `.agx/receipt.json` contains valid non-sensitive ownership and binding metadata
- **When** the operator runs the migration workflow
- **Then** configs writes one migration run and corresponding resource bindings in its state store
- **And** the importer does not invoke the old installer or download a new Bundle
- **And** the imported data is sufficient for reconciliation without copying unknown file contents or client execution data

### Scenario: malformed or unowned legacy state stops migration

- **Given** the legacy receipt is missing, malformed, path-drifting, or cannot prove ownership
- **When** the operator runs migration
- **Then** configs stops before deleting or adopting any object
- **And** diagnose reports the exact missing proof and required operator action
- **And** the legacy input remains available for recovery

### Scenario: failed upgrade rolls back configs state

- **Given** a configs schema or distribution upgrade has a recorded pre-upgrade checkpoint
- **When** the upgrade fails validation or smoke
- **Then** configs restores the prior configs schema/state checkpoint or reports an explicit unrecoverable gate
- **And** it does not reinstall an AGX Bundle or sidecar
- **And** the rollback operation records what was restored

### Scenario: uninstall retains remote resources and unknown files

- **Given** configs owns local state and a deployment repository/Project exists remotely
- **And** unknown local files or pre-existing Provider/client state are present
- **When** the operator runs configs uninstall
- **Then** configs removes only its receipt-bound local state and newly-owned activation
- **And** it retains remote repositories, Projects, unknown files, and pre-existing Provider/client state
- **And** the operation records retained resources and the deletion proof

## Requirement 7: security and direct process boundaries

All subprocess calls MUST use direct argv, explicit working directory, controlled environment, structured output, and cancellation. State and diagnostics MUST exclude secrets and private execution content. Path, ownership, provenance, and digest checks MUST fail closed.

### Scenario: argument and environment boundaries are preserved

- **Given** a configs operation needs to invoke an official Provider, Multica, or client CLI
- **When** configs starts the process
- **Then** it passes arguments as an argv vector without shell interpolation
- **And** it sets only the documented state scope and required environment
- **And** it preserves typed exit, stdout, stderr, and cancellation results without writing raw payloads to logs

### Scenario: unsafe path or provenance is rejected

- **Given** a runtime, state path, external source, or migration binding is absolute, escaping, symlinked, mutable, unsupported, or digest-mismatched
- **When** configs validates the operation
- **Then** it rejects the operation before spawn, extraction, mutation, or deletion
- **And** it reports a typed diagnostic without revealing credentials or private content

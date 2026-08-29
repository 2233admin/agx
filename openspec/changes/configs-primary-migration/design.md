# Design: configs-primary migration

## 1. Target architecture

```text
verified configs distribution/package
            │
            ▼
  configs CLI + control-plane runtime
  ┌───────────────┬────────────────┬──────────────────┐
  │ config state  │ lifecycle ops  │ typed adapters   │
  │ SQLite        │ journal        │ GitHub/Project   │
  │ revisions     │ receipts       │ Provider         │
  │               │ recovery       │ Multica/Evidence │
  └───────────────┴────────────────┴──────────────────┘
            │
            ▼
 unified status / diagnose / upgrade / rollback / uninstall
            │
            ├── GitHub and Project remain external authorities
            ├── Provider clients remain credential authorities
            ├── Multica remains Workspace/Runtime/Agent authority
            └── Evidence is derived from fresh external observations
```

`configs` owns command parsing, operation sequencing, local state, redaction, and lifecycle decisions. Adapters own protocol-specific calls and return typed results. External services remain authoritative for their resources. No AGX executable is required to install or start the final runtime.

The final command contract must cover the existing configuration commands (`list`, `show`, `compare`, `use`, `status`, `switch`, `establish`, `revise`, `supply`) and the migrated lifecycle capabilities. A command may be nested under an upstream-approved namespace, but it must have one documented owner and one state path.

## 2. Capability migration map

| Capability | Existing AGX behavior | New `configs` design | Evidence of parity |
| --- | --- | --- | --- |
| GitHub repositories | Create deployment-owned `agent-control` and `agent-contracts`; read initial commit, visibility, required paths; stop on collision | GitHub adapter and `deployment_repositories` records; mutation result plus structured readback in operation journal | collision, create, readback, retry, unknown-owner tests |
| GitHub Project | Create/link Project, persist number/node/URL/visibility, retain on uninstall | Project adapter and `projects` binding linked to deployment | create/link/readback and remote-retention tests |
| Provider | Read Codex/Claude inventory; activate Marketplace source; preserve pre-existing source; track AGX ownership | Provider adapter and `provider_activations`; external credentials never enter state | inventory, conflict, activation, ownership, revoke tests |
| Multica | Validate typed Workspace/Runtime/Agent UUIDs; read back Task/Run evidence | Multica adapter and typed `multica_subjects`; no untyped IDs or opaque payloads | selector validation, readback, timeout, inconclusive tests |
| Evidence | `github-delivery/v1` and `multica-execution/v1`; freshness and `verified` restrictions | Versioned Evidence Profile/evaluator over stored observation summaries | missing/stale/mismatch/verified-boundary tests |
| init | Guided discovery and explicit plan/apply; owner, provider, profile, visibility, repositories | `configs init` operation plan and mutation workflow | no-write preview, deterministic plan, apply and conflict tests |
| activation | Activate providers and deploy resources after remote mutations | Ordered operation steps with compensating action and ownership | partial-success and retry tests |
| bootstrap | Render versioned clean templates; never copy history/live work | Configs-owned bootstrap package and digest-bound renderer | rendered-tree digest and required-path tests |
| first-use | Create Bootstrap Verification Issue/Project item/PR contract and read evidence | First-use contract and Agent/client adapter with evidence record | contract output and smoke readback tests |
| recovery | Re-run same init; verify prior resources; continue missing steps; mark uncertain remote result | Durable operation journal, idempotency key, `needs_resume`, `needs_manual_cleanup` | cancellation, timeout, retry, remote-uncertain tests |
| status | Combine local receipt, drift, external deployment, Project, smoke, and evidence | One status projection from configs state plus fresh adapter observations | human/JSON redaction and state transition tests |
| diagnose | Explain phase, missing/modified files, evidence gaps and next action | Structured diagnostic codes with stage, cause, evidence, and next safe action | failure matrix and no-overclaim tests |
| Receipt | `.agx/receipt.json` stores Bundle/component/owned-file binding | Versioned `migration_runs`, `operations`, and `resource_bindings` in configs state | import/export reconciliation; no long-term second Receipt |
| upgrade | AGX Bundle/version and digest checks, no overwrite of unrelated installation | Configs package/schema migration with preflight, journal, and rollback checkpoint | upgrade success/failure/rollback tests |
| rollback | Retain unknown files and remote resources; revert only owned local state | Roll back configs schema/runtime operation, never reintroduce AGX Bundle | failed-upgrade restoration and ownership tests |
| uninstall | Remove only AGX-owned local files and owned provider activation; retain remote resources | `configs uninstall` removes only new owned local state; remote retention default | unknown-file, remote-retention, and ownership tests |
| old installer | Download/extract immutable `agent-plugins` archive and write `.agx` metadata | No equivalent; final configs distribution/install contract owns runtime delivery | fresh install proves no Bundle/archive/sidecar path |
| runtime sidecar | AGX validates receipt-bound direct executable and forwards `agx config` | No sidecar; configs invokes its own commands and owns its DB | process bridge absent from final build and package scan |

## 3. State ownership and schema

The configs state store is the sole local write authority. Its schema is versioned and transactionally migrated. It must represent at least:

- configuration revisions and active revision;
- deployment identity, template/version digest, repository bindings, and Project binding;
- Provider source, activation state, pre-existing versus newly-owned status;
- typed Multica Workspace/Runtime/Agent subject;
- Evidence Profile, observations, freshness, diagnostics, and verified decision;
- operation, step, idempotency key, remote request identity where safe, readback, compensation, and next action;
- migration, upgrade, rollback, and uninstall checkpoints.

External resources are never made subordinate to the local database. A missing or stale local binding cannot be repaired by adopting a same-name remote resource. A remote mutation with an uncertain result is recorded as inconclusive and requires a readback or operator action.

Legacy `.agx/receipt.json` is migration input only. The importer preserves non-sensitive binding facts needed for reconciliation, then writes a migration checkpoint. It does not copy unknown file content or turn the legacy Receipt into a second live source of truth.

## 4. Security and privacy

- Production runtime/package provenance must be verified from an actual upstream release or official distribution. No tag, commit, URL, checksum, or platform asset is invented.
- Every subprocess uses direct argv, explicit working directory, controlled environment, structured output, and cancellation. Shell concatenation is prohibited.
- GitHub, Provider, and Multica credentials stay in their official credential stores or existing login sessions. State and logs contain only opaque references and allowlisted summaries.
- Installation/workspace state is explicitly scoped; arbitrary database-path overrides and cross-project reads are rejected.
- Same-name resources, unknown ownership, path traversal, symlink/junction escape, modified state, and unsupported selectors fail closed.
- `configured`, `effective`, `awaiting`, `drifted`, `inconclusive`, and `verified` remain distinct. No local runtime success can produce external `verified`.
- Uninstall deletes only objects with explicit new-architecture ownership and matching content identity. Remote repositories and Projects remain unless an explicit future operator action says otherwise.
- Diagnostics and support output exclude prompts, transcripts, sessions, private repository content, tool payloads, tokens, cookies, API keys, and authorization headers.

## 5. Compatibility and deletion

### Migration window

A temporary read-only `configs migrate-agx` workflow may inspect a legacy installation and produce a deterministic plan. It must:

1. validate the old Receipt and ownership metadata without invoking the old installer;
2. read remote resources through typed adapters or operator-supplied identities;
3. write one transactional migration run into configs state;
4. reconcile resources and evidence before declaring migration complete;
5. require explicit operator confirmation before deleting any legacy local object;
6. retain unknown files and all remote resources.

During the window, an old `agx` invocation may print a migration instruction or hand off argv to configs. It must not create a new Bundle installation, write `.agx/receipt.json`, perform remote mutation independently, or become a second state authority.

### Deletion sequence

1. Freeze new features in old AGX installer/Bundle/sidecar paths.
2. Ship and verify configs state schema, adapters, lifecycle operations, and importer.
3. Run fresh configs deployments and representative legacy migrations.
4. Disable old AGX mutation paths and publish the handoff behavior.
5. Remove old Bundle schema/manifest embedding, archive downloader/extractor, installer Receipt writer, sidecar bridge, and old drift evaluator.
6. Remove CI, packaging, docs, and fixtures that promise old installation behavior.
7. Prove the final binary/package cannot execute the removed paths and can complete the configs-only smoke matrix.

No deletion step is allowed while G0–G4 evidence is incomplete. Rollback of the migration implementation means restoring the configs schema/operation version, not resurrecting a second long-term AGX state owner.

## 6. Migration phases and realistic complexity

The estimate is engineering effort for one maintainer familiar with both repositories; upstream review and release waiting time are excluded. Confidence is medium-low until G0 confirms the extension seam and state contract.

| Phase | Scope | Exit gate | Complexity / effort |
| --- | --- | --- | --- |
| 0. Contract and release review | Verify upstream source, CLI seam, state schema, release process, supported platforms, and real `configs-v*` assets | G0 signed review; current empty release listing remains a blocker | M / 1–2 days |
| 1. State/domain contract | Define versioned configs schema, lifecycle state machine, ownership, redaction, and migration model | schema review plus migration fixtures | L / 4–7 days |
| 2. GitHub/Project/Provider | Port typed adapters, conflicts, ownership, readback, compensation | adapter contract and remote sandbox matrix | L / 7–12 days |
| 3. Multica/Evidence | Port typed selectors, readback, freshness, profiles, verified gate | evidence matrix and timeout/inconclusive tests | XL / 8–15 days |
| 4. Init/bootstrap/first-use/recovery | Port plan/apply, clean templates, first-use contract, resumable operations | fresh and partial-success migration rehearsals | L / 7–12 days |
| 5. Status/diagnose/upgrade/rollback/uninstall | Build unified projections, diagnostics, package/schema lifecycle, safe local cleanup | state and failure matrix | L / 7–12 days |
| 6. Migration and deletion | Import legacy receipts, cut over, remove old paths, package scan and release smoke | G4/G5 evidence | L / 6–10 days |

Total implementation effort is approximately **39–70 engineer-days** across the required capability groups. The largest risks are not CLI parsing: they are state convergence, remote mutation uncertainty, Multica/Evidence contracts, and safe deletion. The estimate must be re-baselined after G0; it must not be reduced by silently dropping capability rows.

## 7. Acceptance gates

### G0 — Phase 0 review gate and upstream prerequisite

- The upstream repository and source history are identified from evidence, not guessed.
- A real published `configs-v*` release/tag with target-platform assets, checksums/provenance, source identity, and documented CLI/state contract exists.
- The current evidence is negative: `gh api repos/2233admin/agent-systemX/releases --paginate` returned an empty list. Until a later checked result changes that fact, G0 is blocked.
- No production release tag, hash, URL, or asset name is written into this change. Existing production AGX manifest remains unchanged.
- Reviewers explicitly approve the upstream extension seam and database isolation before implementation starts.

### G1 — Unified state

- Fresh configs operation and legacy import produce one state store and one operation journal.
- No new `.agx/receipt.json`, AGX Bundle, archive extraction, or sidecar runtime is required.
- Interrupted operations are resumable or explicitly inconclusive with safe next action.

### G2 — Capability parity

- Every row in the capability map has a passing contract test, integration evidence, and named state owner.
- GitHub/Project/Provider/Multica/Evidence behavior preserves conflict, ownership, readback, retention, and `verified` boundaries.
- init/activation/bootstrap/first-use/recovery/status/diagnose/Receipt/upgrade/rollback/uninstall behavior is represented in the configs operation model.

### G3 — Security and privacy

- Direct argv, path containment, symlink/junction, digest/provenance, secret redaction, unknown ownership, and uncertain-remote tests pass.
- State, logs, diagnostics, and support output contain no credentials or private execution content.
- Local success cannot produce `verified` without matching fresh external evidence.

### G4 — Migration safety

- Fresh install, representative old-receipt import, partial success, retry, upgrade failure, rollback, and uninstall are repeatable.
- Remote repositories and Projects survive local migration/uninstall.
- Unknown local files and non-owned Provider/client state survive.
- Migration can stop without destroying the legacy input or requiring the old installer to recover.

### G5 — Deletion and release

- Static/package scans show no production path to AGX Bundle download, archive extraction, old local installer, old Receipt writer, or runtime sidecar.
- Legacy `agx` behavior is limited to documented read-only handoff or migration diagnostics.
- The configs-only binary/package passes supported-platform smoke and status/diagnose/upgrade/rollback/uninstall checks.

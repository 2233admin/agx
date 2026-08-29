# Tasks: configs-primary-migration

Each task is intentionally bounded to no more than one engineering day. A task is not complete until its named test or evidence check passes. Tasks are ordered by dependency; parallel work is allowed only after the listed contract is accepted.

## Phase 0 — review gate before implementation

- [ ] **0.1 — Confirm upstream release evidence (0.5 day).** Query the upstream release API and inspect the actual release workflow, source tree, and package metadata. Record whether a real `configs-v*` release/tag, platform assets, checksums, source identity, and documented state/CLI contracts exist. **Test/evidence:** attach the command output or API response and links; current expected result is an empty release list, so production Gate G0 remains blocked.
- [ ] **0.2 — Review the target boundary (0.5 day).** Have maintainers approve configs as the sole final CLI/state/runtime authority, the capability map, remote-retention rule, secret boundary, and old installer/Bundle/sidecar deletion plan. **Test/evidence:** signed review checklist with no unresolved scope decision and an explicit G0 result.
- [ ] **0.3 — Confirm extension and state seams (1 day).** Trace upstream `packages/control-plane`, CLI entrypoints, SQLite path handling, adapter boundaries, release packaging, and test harness. **Test/evidence:** architecture note names exact extension points, schema migration entrypoint, supported platforms, and unsupported assumptions; reject the phase if any required seam is not evidenced.

## Phase 1 — state and operation contracts

- [ ] **1.1 — Define state schema (1 day).** Specify versioned tables/records for revisions, deployments, repositories, Projects, Providers, Multica subjects, Evidence, operations, migrations, upgrades, rollbacks, and uninstall checkpoints. **Test:** schema fixture opens with an empty database and round-trips every required record without secret fields.
- [ ] **1.2 — Define state transitions (1 day).** Encode `configured`, `awaiting`, `effective`, `drifted`, `inconclusive`, `needs_resume`, `needs_manual_cleanup`, and `verified` transitions. **Test:** transition table rejects local-success-to-verified and ambiguous-remote-to-success paths.
- [ ] **1.3 — Define redaction contract (0.5 day).** Create the allowlist for state, operation logs, diagnostics, JSON, and support output. **Test:** fixture scan rejects credentials, prompts, transcripts, sessions, private content, authorization headers, and raw tool payloads.
- [ ] **1.4 — Define migration input contract (0.5 day).** Specify which legacy AGX Receipt fields can be imported and which paths/objects require operator proof. **Test:** valid, missing, malformed, drifted, and unknown-ownership fixtures produce deterministic import decisions.

## Phase 2 — GitHub, Project, and Provider capabilities

- [ ] **2.1 — Port GitHub repository adapter (1 day).** Implement typed create/readback/visibility/initial-revision results and same-name conflict detection in the configs extension seam. **Test:** API fixtures cover create, existing collision, wrong revision, and inconclusive response without adopting unknown resources.
- [ ] **2.2 — Port Project adapter (1 day).** Implement Project create/link/readback and deployment binding persistence. **Test:** fixtures cover successful link, same-name collision, missing link, and retained Project on local uninstall.
- [ ] **2.3 — Port Provider inventory (1 day).** Implement structured Codex/Claude inventory and availability checks. **Test:** inventory fixtures cover one provider, both providers, missing CLI, malformed output, and no credential persistence.
- [ ] **2.4 — Port Provider activation ownership (1 day).** Implement activation, pre-existing-source preservation, conflict rejection, and owned-source revoke. **Test:** activation fixtures prove only newly-owned sources are revoked and conflicting sources are never rebound.
- [ ] **2.5 — Exercise remote mutation compensation (1 day).** Connect repository/Project/Provider operations to the operation journal and compensation result model. **Test:** injected failure after each mutation yields a resumable or manual-cleanup record with no false success.

## Phase 3 — Multica and Evidence

- [ ] **3.1 — Port typed Multica subject contract (1 day).** Define Workspace/Runtime/Agent IDs and adapter request/response shapes. **Test:** invalid UUID, incomplete subject, unsupported selector, and valid subject fixtures behave deterministically.
- [ ] **3.2 — Port Multica readback (1 day).** Add structured Workspace/Runtime/Agent and Task/Run readback with deadline and cancellation handling. **Test:** fresh, mismatch, unavailable, timeout, and inconclusive readback fixtures produce distinct states.
- [ ] **3.3 — Port Evidence Profiles (1 day).** Implement GitHub-only and Multica-inclusive profile requirements, observation storage, and freshness windows. **Test:** profile fixtures cover all satisfied, missing, stale, rejected, and mismatched observations.
- [ ] **3.4 — Preserve verified gate (0.5 day).** Connect evidence evaluation to status without allowing runtime, migration, or zero exit code to prove verification. **Test:** every local-success path remains non-verified until fresh external evidence matches.
- [ ] **3.5 — Redaction and evidence diagnostics (0.5 day).** Render typed evidence diagnostics and next actions. **Test:** JSON/human fixtures contain only allowlisted identifiers and summaries.

## Phase 4 — init, bootstrap, first-use, recovery

- [ ] **4.1 — Port deterministic init plan (1 day).** Build configs plan output for owner, repositories, Project, visibility, Provider actions, template digest, Evidence subject, conflicts, and compensation. **Test:** identical inputs produce byte-stable plans and no mutation.
- [ ] **4.2 — Port bootstrap renderer (1 day).** Move clean, versioned template rendering and required-path checks under configs ownership. **Test:** fixture rendering proves deterministic digest, no Git history/live Issues/PRs, and no private input leakage.
- [ ] **4.3 — Port init apply ordering (1 day).** Execute repository, Project, Provider, and client activation in the approved order with journal checkpoints. **Test:** successful apply and every injected stage failure produce expected records and safe retry behavior.
- [ ] **4.4 — Port first-use contract (1 day).** Render the Bootstrap Verification contract and accept structured Issue/Project-item/PR evidence. **Test:** contract fixture verifies required evidence and rejects private prompt/transcript/session persistence.
- [ ] **4.5 — Port recovery and idempotency (1 day).** Re-run interrupted operations using operation identity and structured remote readback. **Test:** retry does not duplicate or adopt resources; timeout remains inconclusive until readback resolves it.

## Phase 5 — status, diagnose, lifecycle

- [ ] **5.1 — Build unified status projection (1 day).** Combine config revision, local state, resource bindings, Provider, Multica, Evidence, operation, migration, and drift into one typed projection. **Test:** fresh, configured, awaiting, drifted, inconclusive, and verified fixtures produce distinct statuses.
- [ ] **5.2 — Build diagnose projection (1 day).** Map failures to typed stage, cause, evidence, next safe action, and retention behavior. **Test:** failure matrix covers local, GitHub, Project, Provider, Multica, Evidence, upgrade, and migration errors.
- [ ] **5.3 — Port upgrade journal (1 day).** Add preflight, schema/distribution migration, checkpoint, smoke, and result records. **Test:** successful upgrade, validation rejection, interrupted upgrade, and retry fixtures are repeatable.
- [ ] **5.4 — Port rollback (1 day).** Restore configs-owned schema/state/operation checkpoint without reintroducing AGX Bundle or sidecar. **Test:** failed upgrade returns prior configs state and records what was restored.
- [ ] **5.5 — Port uninstall ownership (1 day).** Delete only configs-owned local state and newly-owned activation; retain remote repositories, Projects, unknown files, and pre-existing client state. **Test:** ownership matrix verifies every retained/deleted object.

## Phase 6 — migration, cutover, deletion

- [ ] **6.1 — Implement legacy Receipt importer (1 day).** Read only valid non-sensitive legacy fields and create one configs migration run. **Test:** valid receipt imports; malformed, drifted, and unknown-owned input stops without deletion.
- [ ] **6.2 — Reconcile migrated resources (1 day).** Re-read GitHub/Project/Provider/Multica resources through typed adapters and bind them to configs state. **Test:** matching, missing, conflicting, and inconclusive readback fixtures remain explicit.
- [ ] **6.3 — Run fresh and legacy migration rehearsals (1 day).** Execute fresh configs setup and representative old AGX imports in isolated test environments. **Test:** before/after state reconciliation proves capability parity, remote retention, and secret redaction.
- [ ] **6.4 — Freeze old mutation paths (0.5 day).** Change the release boundary so legacy AGX commands only hand off or report migration and cannot download Bundle/write old Receipt/mutate remote resources. **Test:** command matrix proves each old mutation path has zero network and zero legacy-state writes.
- [ ] **6.5 — Delete old installer and Bundle paths (1 day).** Remove AGX installer, Bundle schema/manifest embedding, archive download/extract, old Receipt writer, and old drift evaluator after G1–G4 pass. **Test:** build, static search, and package scan show no production references; configs-only smoke still passes.
- [ ] **6.6 — Delete runtime sidecar bridge (0.5 day).** Remove the AGX-managed configs executable binding and argv bridge after configs owns its own runtime/state. **Test:** package scan and command smoke prove configs works without a sidecar or `CONTROL_PLANE_DB_PATH` handoff from AGX.
- [ ] **6.7 — Update release and support contracts (0.5 day).** Remove old install claims, document configs-only support, and link the migration/deletion evidence. **Test:** documentation command examples match the final CLI contract and contain no fabricated release values.
- [ ] **6.8 — Final G5 review (0.5 day).** Review capability parity, security, deletion, release smoke, and rollback evidence. **Test/evidence:** G5 checklist passes; if any required row lacks evidence, do not cut over.

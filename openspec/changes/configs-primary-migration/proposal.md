# Proposal: make configs the primary Agent System X control plane

## Summary

Replace the superseded “AGX installer plus configs sidecar” approach with a single control-plane architecture. The upstream `configs` CLI and state store become the final user-facing and lifecycle authority. AGX capabilities are migrated selectively by business value, then the old AGX local installer and Bundle/sidecar path are removed.

This proposal requests approval to plan and implement that migration. It does not authorize product-code changes in this change set.

## Why the thin integration is not the target

The earlier design made `agx config` forward argv to a receipt-bound executable, but retained AGX Bundle download, archive extraction, `.agx/receipt.json`, AGX drift evaluation, and a second state owner. That boundary creates two lifecycle authorities:

- AGX owns installation, component ownership, recovery metadata, and lifecycle status;
- `configs` owns configuration revisions and its SQLite database.

Upgrades, rollback, uninstall, and evidence then require cross-reading two state machines. A process bridge hides the split; it does not remove it. The target must move the business contracts into `configs` and delete the old local control plane.

## Goals

1. Make `configs` the sole final CLI, state-store, and runtime authority.
2. Migrate all required AGX business capabilities without weakening their existing safety contracts:
   GitHub, GitHub Project, Provider, Multica, Evidence, init, activation, bootstrap, first-use, recovery, status, diagnose, Receipt/operation history, upgrade, rollback, and uninstall.
3. Preserve remote-resource retention: local uninstall and migration must not delete deployment repositories or Projects by default.
4. Preserve secret boundaries: no credentials, prompts, transcripts, sessions, private source, or raw tool payloads in state, receipts, logs, or support bundles.
5. Eliminate long-term dual-write and dual-state behavior.
6. Establish a reviewable migration and deletion sequence with explicit gates.
7. Keep production claims honest: no production `configs` pin until a real upstream release and its checksums/provenance exist.

## Non-goals

- Rewriting the upstream `configs` product without an agreed extension boundary.
- Treating an upstream `main` commit, local checkout, or mutable URL as a production release.
- Preserving AGX installer, Bundle archive, or sidecar as a final fallback.
- Adding daily task scheduling, daemon supervision, telemetry, or a new general-purpose orchestration service.
- Automatically deleting remote repositories, GitHub Projects, unknown local files, or non-owned client state.
- Copying AGX Git history, live Issues/PRs, credentials, user paths, prompts, transcripts, or private content into the new architecture.

## Required capability result

The new architecture must provide one coherent operation model:

```text
configs CLI
  ├── configuration revisions and client supply
  ├── deployment init / bootstrap / first-use
  ├── GitHub + Project + Provider adapters
  ├── Multica subject + readback adapter
  ├── Evidence profiles and verified evaluator
  ├── operation journal + Receipt history
  └── status / diagnose / upgrade / rollback / uninstall
          │
          └── one configs state store; external systems remain external authorities
```

The command names may be grouped according to the upstream CLI contract, but every capability in the required list must be reachable through `configs`; a hidden AGX mutation path does not satisfy this proposal.

## Acceptance summary

The proposal is successful only when:

- a fresh deployment uses `configs` without AGX Bundle download or local AGX installer state;
- an old AGX deployment can first be inspected through a read-only migration plan, then (after explicit operator confirmation) imported and reconciled through a controlled state-changing apply phase;
- all capability-map rows have parity evidence and explicit ownership;
- failure, retry, inconclusive remote mutation, drift, rollback, and uninstall behaviors are testable;
- code and release scans show the old installer, Bundle, archive extraction, and sidecar are not production paths;
- G0–G5 in `design.md` pass, including the currently blocked upstream-release gate.

## Decision requested

Approve the configs-primary target and the deletion plan. Do not begin destructive implementation work until Phase 0 confirms the upstream release, extension seam, state schema, platform packaging, and migration contract. The present upstream evidence is insufficient for production: the release endpoint check returned no releases, so the design remains blocked at G0.

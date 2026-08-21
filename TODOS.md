# TODOS

## Review

### Generalize metadatafile TOCTOU-safe helper into a checkpoint/resume framework

**What:** Extend the consolidated `internal/metadatafile` atomic read/write helper (landing as part of issue #77's fix) beyond receipt/profile into a reusable checkpointed-resume primitive that future evidence profiles can share.

**Why:** The office-hours design doc (`docs/designs/fleet-provisioning-substrate-premise-validation.md`) identified this as the real architecture gap behind the netbird provisioning pain — a late-step failure currently forces redoing the whole deployment. If a `netbird-reachability/v1` evidence profile gets built later, it will need the same resumable-write shape `internal/activation`/`internal/fleet` now share.

**Context:** No second real consumer exists yet — this is speculative until the office-hours validation spike (recruiting a DevOps engineer to test whether standard IaC already solves the provisioning pain) comes back. Don't build the generalized shape blind; wait for a second concrete need before designing the abstraction, per the review skill's own YAGNI guidance.

**Effort:** M
**Priority:** P3
**Depends on:** office-hours Approach C validation spike outcome (see `docs/designs/fleet-provisioning-substrate-premise-validation.md`); issue #77's metadatafile consolidation landing first.

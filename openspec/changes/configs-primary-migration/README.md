# configs-primary-migration

## Change status

Draft OpenSpec change for the Agent System X Project. This change supersedes the thin sidecar design in `docs/superpowers/specs/2026-08-26-agent-system-x-merge-design.md` and the implementation context from commits `dc61e62`, `7cf5458`, and `77061a0`. Those commits demonstrate the existing AGX Bundle, installer, Receipt, runtime bridge, and status behavior; they are not the target architecture.

The change is design and planning only. It does not modify product code, the production manifest, or `.serena/`.

## Decision

`configs` becomes the sole final CLI, state, and runtime authority. The valuable AGX business capabilities move into the `configs` architecture:

- GitHub repositories and Projects;
- Codex/Claude Provider inventory, activation, and ownership;
- Multica subject binding and readback;
- Evidence Profiles, freshness, diagnostics, and the `verified` gate;
- init, activation, bootstrap, first-use, and recovery;
- status, diagnose, Receipt/operation history, upgrade, rollback, and uninstall.

After cutover, the old local AGX installer, Bundle download/archive extraction, and AGX-managed `configs` sidecar are deleted. Remote repositories and Projects remain operator-owned and are not deleted by default. Credentials, prompts, transcripts, sessions, private content, and tool payloads remain outside persisted AGX/configs state.

## Evidence and blocker

The upstream source of truth is [2233admin/agent-systemX](https://github.com/2233admin/agent-systemX), whose visible repository tree includes `packages/control-plane`, `openspec`, `contracts`, `entrypoints`, and `tests`. The current AGX upstream-release check was:

```text
gh api repos/2233admin/agent-systemX/releases --paginate
```

It returned an empty list. No published `configs-v*` release/tag/assets are therefore assumed or named here. A real release with checksums, source identity, target-platform assets, and a documented state/CLI contract is a mandatory Phase 0 Gate G0. Until G0 passes, production cutover is blocked and the existing production Bundle manifest remains unchanged.

## File map

| File | Purpose |
| --- | --- |
| `proposal.md` | Problem, intent, scope, constraints, and decision request |
| `design.md` | Target architecture, capability migration, ownership, deletion, security, complexity, and gates |
| `specs/configs-primary-migration/spec.md` | Testable BDD requirements and rejection behavior |
| `tasks.md` | Ordered implementation tasks, each no longer than one day, with explicit tests and Phase 0 review gate |

## Review order

1. Review `proposal.md` for scope and deletion intent.
2. Review `design.md` for target architecture, ownership, and migration risk.
3. Review `specs/configs-primary-migration/spec.md` for observable acceptance behavior.
4. Review `tasks.md` for executable sequencing and test evidence.
5. Do not approve implementation work until Gate G0 has a recorded upstream release and contract evidence.

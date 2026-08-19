# Authority map

This directory defines portable operating boundaries for this Installation.

Read in this order:

1. `01-knowledge.md` — how durable knowledge is admitted and maintained.
2. `02-long-horizon-work.md` — how bounded work survives session boundaries.
3. `04-collaboration.md` — how owners, implementers, and reviewers coordinate.
4. `10-operating-ledger.md` — the minimum durable operational record.

Active GitHub Issues control their own goal, scope, permissions, revisions, and
lifecycle. Repository rules control reusable project behavior. Generated files,
branches, pull requests, local observations, `python tools/validate.py`, and
chat are derived evidence. None of those records grants credentials or
permissions beyond the operator's explicit authorization.

## Evidence Profile and Verification

AGX reports Installation state from an Evidence Profile, not from this tree.

- `github-delivery/v1` can reach `verified` only with matching GitHub readback
  for this Installation.
- `multica-execution/v1` additionally requires matching Multica readback.
- A locally intact control repository, passing validator, or first-use checklist
  is at most `configured`. Do not emit `verified` from a local tree.

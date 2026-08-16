# AGX repository instructions

- Read `README.md` before changing product behavior.
- Every product change must have a bounded Issue contract with acceptance criteria. Closely related completed work may be integrated in one PR.
- Preserve the boundary: AGX is an installation/deployment/lifecycle CLI, not a daily task scheduler.
- Multica integration is optional and outside the AGX 0.1 release. Any future adapter must use a versioned official CLI and structured output only.
- Consume `agent-control` and `agent-plugins` through immutable Release artifacts and verified digests in production.
- Never emit the reserved `verified` state without matching external evidence. A locally intact Bundle installation is reported as `configured`.
- Keep credentials out of config, logs, plans, receipts, fixtures, and support bundles.
- Use Go for persistent implementation. Run `go test ./...` before delivery.
- Develop on a branch and deliver through a PR; do not push implementation directly to protected `main` after the bootstrap commit.
- In this single-maintainer repository, the maintainer may merge their own PR after all required automated checks pass. Do not require an impossible second-person approval.

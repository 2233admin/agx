# AGX repository instructions

- Read `README.md` before changing product behavior.
- Every implementation change must have a bounded Issue contract with acceptance criteria.
- Preserve the boundary: AGX is an installation/deployment/lifecycle CLI, not a daily task scheduler.
- Integrate with Multica only through a versioned official CLI adapter. Do not fork, vendor, call private HTTP APIs, or parse human-oriented output.
- Consume `agent-control` and `agent-plugins` through immutable Release artifacts and verified digests in production.
- Never claim installation success before the safe GitHub-to-Multica end-to-end acceptance reaches `verified`.
- Keep credentials out of config, logs, plans, receipts, fixtures, and support bundles.
- Use Go for persistent implementation. Run `go test ./...` before delivery.
- Develop on a branch and deliver through a Draft PR; do not push implementation directly to protected `main` after the bootstrap commit.

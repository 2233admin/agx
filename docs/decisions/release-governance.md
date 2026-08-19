# AGXCLI release governance

Status: active for `main` on `2233admin/agx` as of 2026-08-16.

`main` is protected through GitHub branch protection before non-bootstrap work is merged. The rule applies to administrators and requires the branch to be up to date before merge.

Required status contexts:

- `test (ubuntu-latest)`
- `test (windows-latest)`
- `build`
- `GitGuardian Security Checks`

`CodeRabbit` and other advisory review bots may report findings, but they are not merge-blocking because their latency and availability are outside the repository's control.

Pull request review policy:

- zero approving reviews are required while the repository has one maintainer;
- the maintainer may merge their own PR only after every required automated check passes;
- unresolved conversations block merge.

History and branch mutation policy:

- linear history is required;
- force pushes are disabled;
- branch deletion is disabled;
- the branch is not locked, so protected merges remain possible.

This rule supports the lightweight project process: Issue -> branch -> PR -> local validation -> push -> required CI -> maintainer merge. It does not authorize bypassing checks or claiming live installation success without every external observation required by the explicitly selected, versioned Evidence Profile. `github-delivery/v1` is GitHub-only; `multica-execution/v1` additionally requires matching Multica evidence. If additional maintainers join, approval requirements can be restored without changing the product delivery contract.

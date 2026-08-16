# AGXCLI release governance

Status: active for `main` on `2233admin/agx` as of 2026-08-16.

`main` is protected through GitHub branch protection before non-bootstrap work is merged. The rule applies to administrators and requires the branch to be up to date before merge.

Required status contexts:

- `test (ubuntu-latest)`
- `test (windows-latest)`
- `build`
- `CodeRabbit`
- `GitGuardian Security Checks`

Pull request review policy:

- one approving review is required;
- stale approvals are dismissed after new commits;
- the last pusher cannot approve their own final push;
- unresolved conversations block merge.

History and branch mutation policy:

- linear history is required;
- force pushes are disabled;
- branch deletion is disabled;
- the branch is not locked, so protected merges remain possible.

This rule supports the project process: Issue -> branch -> PR -> local validation -> push -> CI/review. It does not authorize self-merge, bypassing review, or claiming live installation success.

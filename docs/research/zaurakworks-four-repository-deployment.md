# Zaurakworks Four-Repository Deployment Notes

Observed on 2026-08-17 from GitHub primary sources and the current AGX
repository. The public `zaurakworks` organization currently exposes three AGX
related repositories: `agent-plugins`, `agent-control`, and `agent-contracts`.
The fourth repository in the deployment UX is the AGX CLI repository,
`2233admin/agx`, which installs and initializes the other pieces for a user
deployment.

## Repository Roles

| Repository | Current role | Source evidence |
| --- | --- | --- |
| `2233admin/agx` | Installer and lifecycle CLI. It owns `apply`, `init`, `status`, `uninstall`, receipts, and the clean bootstrap templates. | Local [README.md](../../README.md), local [docs/decisions/repository-provenance.md](../decisions/repository-provenance.md). |
| `zaurakworks/agent-plugins` | Long-term installable Plugin source. AGX should install only this source through a pinned release artifact; Codex and Claude each have their own marketplace manifest. | Repository page: <https://github.com/zaurakworks/agent-plugins>. Pinned README: <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/README.md>. Codex manifest: <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/.agents/plugins/marketplace.json>. Claude manifest: <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/.claude-plugin/marketplace.json>. |
| `zaurakworks/agent-control` | Reference source for the deployment control-state template. It is not installed as a runtime component and must not be copied with live history or current work state. | Repository page: <https://github.com/zaurakworks/agent-control>. Pinned README: <https://github.com/zaurakworks/agent-control/blob/b0e6e0e8244ef518f671e2326745cd67c6d2307a/README.md>. AGX rendered template README: [internal/bootstrap/templates/agent-control/v1/README.md](../../internal/bootstrap/templates/agent-control/v1/README.md). |
| `zaurakworks/agent-contracts` | Reference source for the deployment contract repository template. It provides Issue-driven contract forms, schema, examples, and validation tools. | Repository page: <https://github.com/zaurakworks/agent-contracts>. Pinned README: <https://github.com/zaurakworks/agent-contracts/blob/5bb8ea0b54f063b0758c294b73ea270ba69322d2/README.md>. AGX rendered template README: [internal/bootstrap/templates/agent-contracts/v1/README.md](../../internal/bootstrap/templates/agent-contracts/v1/README.md). |

## Pinned Inputs Used by AGX

AGX currently pins the template/reference inputs in
[docs/contracts/agx-bundle-v2.md](../contracts/agx-bundle-v2.md):

| Input | Commit |
| --- | --- |
| `zaurakworks/agent-plugins` | `ad07742ade0f0039ed1df1a9262e8f087117fca0` |
| `zaurakworks/agent-control` | `b0e6e0e8244ef518f671e2326745cd67c6d2307a` |
| `zaurakworks/agent-contracts` | `5bb8ea0b54f063b0758c294b73ea270ba69322d2` |

GitHub commit permalinks:

- <https://github.com/zaurakworks/agent-plugins/commit/ad07742ade0f0039ed1df1a9262e8f087117fca0>
- <https://github.com/zaurakworks/agent-control/commit/b0e6e0e8244ef518f671e2326745cd67c6d2307a>
- <https://github.com/zaurakworks/agent-contracts/commit/5bb8ea0b54f063b0758c294b73ea270ba69322d2>

## Deployment Sequence

1. User downloads or builds `agx` from `2233admin/agx`.
2. `agx apply --bundle ... --root <new-install-dir>` installs the pinned
   `agent-plugins` artifact into the local installation root and writes an AGX
   receipt.
3. `agx init --root <install-dir> --github-owner <owner> --provider ...`
   performs a read-only preflight and prints the exact repositories, template
   digests, provider changes, and collision behavior.
4. `agx init ... --apply` creates `<owner>/agent-control` and
   `<owner>/agent-contracts` from AGX's clean templates, persisting a recovery
   receipt after each repository.
5. The same `--apply` run activates the selected profile for Codex and/or
   Claude from the installed `agent-plugins` source, then prints provider
   qualified first-use prompts.

AGX does not create a deployment-owned `agent-plugins` repository. It also does
not copy upstream repository history, live Issues, comments, user paths,
credentials, run packages, or current work state into the two deployment
repositories. Those exclusions are stated in the local template READMEs linked
above and in [docs/decisions/repository-provenance.md](../decisions/repository-provenance.md).

## Provider Entry Points

`zaurakworks/agent-plugins` documents the native marketplace installation
commands in its pinned README:

- Codex adds the repository root as a marketplace and installs plugins such as
  `grilling@agent-plugins`; explicit entry examples include `$grilling` and
  `$github-collaboration:issue-workflow`.
- Claude adds the same repository root as a marketplace and installs plugins
  with user scope; explicit entry examples include `/grilling:grilling` and
  `/github-collaboration:issue-workflow`.

AGX wraps those native provider operations with receipts, idempotence, preflight
checks, and safe uninstall behavior. The provider command shapes are documented
by the upstream README, while the AGX wrapper behavior is implemented and tested
in `internal/provider`, `internal/activation`, and `internal/cli`.

## Upgrade and Uninstall Boundaries

`agent-plugins` upgrades are AGX Bundle upgrades: a future Bundle must point to
a new immutable artifact and digest. `agent-control` and `agent-contracts`
deployment repositories are user-owned state repositories; AGX initialization
creates them, but `agx uninstall` deliberately does not delete them.

Uninstall only reverses receipt-proven local/provider additions and removes
AGX-owned files. Remote repository deletion, archival, migration, or adoption
requires a separate operator decision because those repositories can contain
deployment state after first use.

## Open Questions

- There is no fourth public `zaurakworks` repository in the current GitHub
  organization listing available to this environment. If a private or newly
  transferred repository exists, AGX docs should name it only after primary
  source confirmation.
- The current PR intentionally has not run live `init --apply` against a real
  GitHub owner, so repository creation and provider activation remain simulated
  or read-only validated in AGX tests and CI.
- AGX currently documents and implements the bootstrap path; future upgrade or
  template migration UX still needs a separate issue contract before changing
  deployment state.

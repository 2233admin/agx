# Zaurakworks Four-Repository Deployment Notes

Observed on 2026-08-17 against current AGX head
`f78e59b05f0d16b17eb3877aa47130490e8d7df0` and primary sources only.
This note answers: how should the AGX four-repository model be used and
deployed, and what initialization UX gaps remain?

**2026-08-19 provenance update:** Plugin Source is now
`zaurakworks/agent-system` (the renamed and merged former `agent-control`).
Production input remains the `2233admin` immutable Release
`agx-plugins-20260819.1` / `ef07a9f`. Do not follow Source git `main`.
Historical permalinks below that still name `zaurakworks/agent-control` should
be read as the Source snapshot now served from
`zaurakworks/agent-system@b0e6e0e8244ef518f671e2326745cd67c6d2307a`.

## Scope and Evidence Classes

- **Fact** means the statement is directly supported by linked source,
  repository content, or official CLI documentation.
- **Inference** means the statement follows from AGX source plus upstream
  repository content, but was not itself observed in a live deployment.
- **Unverified boundary** means AGX has tests or dry-run evidence, but this
  review did not perform the external mutation.

Primary AGX source for this review:

- Current AGX README at head `f78e59b`:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/README.md>
- Current AGX CLI implementation:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>
- Embedded production Bundle:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production.go>
  and
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>
- Apply/install implementation:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/install/install.go>
- Initialization lifecycle:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/activation/activation.go>
- Repository provisioning implementation:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/repository/repository.go>
- Provider wrapper implementation:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/provider/provider.go>
- Bundle v2 contract:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/docs/contracts/agx-bundle-v2.md>

Official GitHub CLI sources used for precondition claims:

- `gh` manual and authentication entry point:
  <https://cli.github.com/manual/> and <https://cli.github.com/manual/gh_auth_login>
- `gh auth status` manual:
  <https://cli.github.com/manual/gh_auth_status>
- `gh repo create` manual:
  <https://cli.github.com/manual/gh_repo_create>

## Confirmed Repository Model

| Repository | Classification | How AGX uses it | Source |
| --- | --- | --- | --- |
| `2233admin/agx` | **Fact:** installer/lifecycle CLI repository. | Builds the `agx` binary, owns `apply`, `init`, `status`, `uninstall`, receipts, embedded production Bundle, and clean templates. | AGX README and CLI source at `f78e59b`: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/README.md>, <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>. |
| `zaurakworks/agent-plugins` | **Fact:** installable Plugin source. | AGX installs this single source through a pinned production artifact; provider activation points Codex/Claude Marketplace at the installed copy. AGX does not create a deployment-owned `agent-plugins` repository. | Upstream README and manifests: <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/README.md>, <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/.agents/plugins/marketplace.json>, <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/.claude-plugin/marketplace.json>. AGX Bundle source: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>. |
| `<owner>/agent-control` | **Fact:** deployment-generated repository, not an installed component. | `agx init --apply` creates this user-owned control-state repository from AGX's `agent-control/v1` clean template. It holds deployment control state and work entry rules. | Upstream reference README after rename: <https://github.com/zaurakworks/agent-system/blob/b0e6e0e8244ef518f671e2326745cd67c6d2307a/README.md>. AGX template README: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bootstrap/templates/agent-control/v1/README.md>. |
| `<owner>/agent-contracts` | **Fact:** deployment-generated repository, not an installed component. | `agx init --apply` creates this user-owned contract repository from AGX's `agent-contracts/v1` clean template. It holds Issue contract forms, schema, examples, and validation tools. | Upstream reference README: <https://github.com/zaurakworks/agent-contracts/blob/5bb8ea0b54f063b0758c294b73ea270ba69322d2/README.md>. AGX template README: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bootstrap/templates/agent-contracts/v1/README.md>. |

**Fact:** the public `zaurakworks` repository listing available to this review
also includes `zaurakworks/ticket-decision-core`. It is not referenced by AGX
head `f78e59b` in Bundle, template, provider, or repository initialization
sources, so it is outside the current AGX four-repository initialization model.
Primary listing: <https://github.com/zaurakworks?tab=repositories>. Current AGX
references: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>
and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/docs/contracts/agx-bundle-v2.md>.

## Pinned Inputs Used by AGX

**Fact:** AGX pins the plugin source and template references in its Bundle v2
contract and embedded production manifest.

| Input | Commit | Source |
| --- | --- | --- |
| `zaurakworks/agent-plugins` | `ad07742ade0f0039ed1df1a9262e8f087117fca0` | Commit permalink: <https://github.com/zaurakworks/agent-plugins/commit/ad07742ade0f0039ed1df1a9262e8f087117fca0>. AGX manifest: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>. |
| `zaurakworks/agent-system` | `b0e6e0e8244ef518f671e2326745cd67c6d2307a` | Commit permalink after rename: <https://github.com/zaurakworks/agent-system/commit/b0e6e0e8244ef518f671e2326745cd67c6d2307a>. AGX manifest: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>. |
| `zaurakworks/agent-contracts` | `5bb8ea0b54f063b0758c294b73ea270ba69322d2` | Commit permalink: <https://github.com/zaurakworks/agent-contracts/commit/5bb8ea0b54f063b0758c294b73ea270ba69322d2>. AGX manifest: <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>. |

**Fact:** the embedded production manifest points to the production
`agent-plugins` release asset and pins both compressed asset SHA-256 and
gzip-uncompressed tar-stream SHA-256. Source:
<https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>.
The install implementation accepts exactly one Bundle source, either
`BundleData` or `BundlePath`, decodes the Bundle, downloads the asset, and
performs digest checks. Source:
<https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/install/install.go>.

## From a New Machine to First Usable Session

1. **Install prerequisites.** **Fact:** AGX help requires `git`, authenticated
   GitHub CLI `gh`, and every selected provider CLI (`codex` and/or `claude`) on
   `PATH`. Source:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.
   GitHub CLI official docs say `gh auth login` authenticates and
   `gh auth status` displays the active account/authentication state. Sources:
   <https://cli.github.com/manual/gh_auth_login> and
   <https://cli.github.com/manual/gh_auth_status>.
2. **Install AGX's pinned plugin source.** **Fact:** run
   `agx apply --root <new-install-dir>`. At head `f78e59b`, omitting
   `--bundle` uses `bundle.Production()` and the embedded production manifest;
   `--bundle <bundle.json>` is an explicit local override. Sources:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>,
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production.go>,
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/bundle/production-v2.json>.
3. **Preview initialization.** **Fact:** run
   `agx init --root <install-dir> --github-owner <owner> --provider ...`.
   Without `--apply`, AGX calls the plan path and prints a no-mutation
   initialization plan. Source:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.
4. **Review defaults and collisions.** **Fact:** defaults are profile `core`,
   visibility `private`, repositories `agent-control` and `agent-contracts`;
   same-name repositories are collisions and are not adopted or overwritten.
   Sources: AGX help/README and repository preflight implementation:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/README.md>,
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/repository/repository.go>.
5. **Apply initialization.** **Fact:** rerun the same init arguments with
   `--apply`. AGX creates `<owner>/agent-control` and
   `<owner>/agent-contracts`, persists recovery state during provisioning, then
   activates selected provider plugins from the installed `agent-plugins`
   source. Sources:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/activation/activation.go>,
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/repository/repository.go>,
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/provider/provider.go>.
   GitHub CLI's official `gh repo create` manual confirms the CLI supports
   non-interactive repository creation with `--public`, `--private`, or
   `--internal`. Source: <https://cli.github.com/manual/gh_repo_create>.
6. **Start a new provider session and use the printed first-use prompt.**
   **Fact:** AGX output includes provider-qualified prompts such as Codex
   `$grilling:grilling ...` and GitHub profile prompts for
   `$github-collaboration:issue-workflow ...`; Claude uses
   `/grilling:grilling ...` and
   `/github-collaboration:issue-workflow ...`. Source:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.
   Upstream `agent-plugins` documents native provider entry points and
   Marketplace manifests. Sources:
   <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/README.md>,
   <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/.agents/plugins/marketplace.json>,
   <https://github.com/zaurakworks/agent-plugins/blob/ad07742ade0f0039ed1df1a9262e8f087117fca0/.claude-plugin/marketplace.json>.

## Dry-Run, Apply, Recovery, Status, and Uninstall

- **Dry-run fact:** `agx init` without `--apply` is the intended no-mutation
  preview path; the CLI formats the exact copyable follow-up command with
  `--apply` appended. Source:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.
- **Apply fact:** `agx init ... --apply` is the mutation boundary for remote
  repository creation and provider activation. Sources:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>
  and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/activation/activation.go>.
- **Recovery fact:** AGX does not expose a separate `agx resume` command in
  the current CLI help. Human output tells the operator to fix the reported
  problem and rerun the original `agx init ... --apply` unchanged; the
  activation implementation validates existing receipts and continues based on
  recorded objects. Sources:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>
  and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/activation/activation.go>.
- **Status fact:** `agx status` reads receipts, reports configured/drifted
  initialization state, and prints next actions for absent initialization,
  drift, and needs-resume/provisioning. Source:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.
- **Uninstall fact:** `agx uninstall` reverses AGX-owned provider activation
  and removes AGX-owned local files while retaining remote deployment
  repositories and unknown files. Sources:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>
  and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/activation/activation.go>.

## Upgrade and Migration Boundaries

- **Fact:** `agent-plugins` upgrades are Bundle upgrades: a future production
  Bundle must point to a new immutable artifact and new digest values. Source:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/docs/contracts/agx-bundle-v2.md>.
- **Inference:** `agent-control` and `agent-contracts` are user-owned state
  repositories after creation. AGX can create them from templates, but future
  template migrations are not equivalent to reinstalling `agent-plugins`;
  migration policy needs a separate issue contract before AGX mutates existing
  deployment state. Source for current create-only model:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/activation/activation.go>.
- **Fact:** uninstall deliberately does not delete remote repositories. Any
  remote deletion, archival, rename, migration, or adoption is an operator
  decision outside the current uninstall behavior. Sources:
  <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/README.md>
  and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.

## Initialization UX Gaps and Remaining Risk

1. **Subsequent acceptance evidence:** a controlled acceptance run verified
   repository creation and readback, first use, repeat-initialization
   idempotence, and ownership-safe uninstall with remote repository retention.
   Operational identifiers and environment-specific evidence are intentionally
   not published. This closes the earlier live-mutation evidence gap for the
   exercised path; it does not create a general `verified` claim.
2. **UX follow-up:** controlled acceptance also showed that recommending
   `both` blindly is poor first-run UX when one provider has a Marketplace
   source conflict. AGX therefore adds a human-only, side-effect-free guided
   path that discovers the authenticated GitHub identity and provider
   inventories before recommending an available provider. Explicit
   non-interactive flags and JSON output remain the automation path.
3. **UX gap:** collision recovery is safe but manual: same-name repositories
   stop before writes, and the user must choose different names with
   `--control-repo` and/or `--contracts-repo` or perform a separate audited
   ownership/adoption flow that does not exist yet. Sources:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/README.md>
   and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/repository/repository.go>.
4. **Remaining boundary:** provider Marketplace conflicts remain fail-closed:
   AGX will not rebind an existing `agent-plugins` Marketplace that points
   elsewhere. Guided initialization can recommend an unaffected provider, but
   resolving or replacing the conflicting source remains an explicit operator
   action. Source:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/provider/provider.go>.
5. **Unverified boundary:** no local step should claim `verified`. Current docs
   and CLI frame install/initialization as `configured` or initialized, while
   external validation remains separate. Sources:
   <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/README.md>
   and <https://github.com/2233admin/agx/blob/f78e59b05f0d16b17eb3877aa47130490e8d7df0/internal/cli/cli.go>.

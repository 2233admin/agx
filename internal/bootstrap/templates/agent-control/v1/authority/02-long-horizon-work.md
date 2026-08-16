# Long-horizon work

Long-running work must remain recoverable without relying on one chat session.

## Minimum durable state

- a GitHub Issue with goal, scope, acceptance criteria, permissions, and stop
  conditions;
- a named owner and one explicit next action;
- a dedicated branch or worktree for implementation;
- evidence attached to the Issue or pull request at meaningful checkpoints.

Before resuming, reread the Issue and its approved revisions. Stop on material
contract drift, missing authority, unsafe collisions, or unavailable required
dependencies. A passing build or an open pull request is delivery evidence, not
automatic acceptance.

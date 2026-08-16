# @@AGX_REPOSITORY@@

This repository is the control-state home for one AGX deployment. It starts
from a clean, versioned baseline; it does not contain another deployment's
tasks, observations, history, or credentials.

The installable Agent Plugin source is
[@@AGX_PLUGIN_SOURCE@@](@@AGX_PLUGIN_SOURCE_URL@@). Plugin source code is not
copied into this repository.

## Start here

1. Read `AGENTS.md` and `authority/00-map.md`.
2. Open a Goal, Need, Delivery, Experiment, Research, Friction, or Proposal
   Issue using the repository forms.
3. Replace the bootstrap text in `work/current.md` only after a bounded Issue
   exists and the responsible operator has selected it.
4. Keep durable, accepted lessons in `knowledge/`; keep transient execution
   artifacts outside version control.

Run the repository baseline check with:

```console
python tools/validate.py
```

## Template provenance

AGX template `agent-control/v1` was distilled from the portable control rules
at `zaurakworks/agent-control@b0e6e0e8244ef518f671e2326745cd67c6d2307a` and
the seven Issue categories shared with
`zaurakworks/agent-plugins@ad07742ade0f0039ed1df1a9262e8f087117fca0`. It
deliberately omits live Issues,
work logs, monitoring snapshots, learned project content, local tool output,
provider caches, and machine-specific paths.

# @@AGX_REPOSITORY@@

This repository is the control-state home for one AGX Installation. It starts
from a clean, versioned baseline; it does not contain another Installation's
tasks, observations, history, or credentials, and it is not a copy of the
Plugin Source tree.

Plugin **Source** is `zaurakworks/agent-system`. Production **Distribution** is
a `2233admin` immutable GitHub Release. This Installation's installed plugin
identity is [@@AGX_PLUGIN_SOURCE@@](@@AGX_PLUGIN_SOURCE_URL@@). Do not clone
Source git `main`, and do not copy plugin source code into this repository.

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

That local check is baseline hygiene. It is not Installation Verification and
must not be reported as `verified`. Verification uses the Evidence Profile
selected at `agx init`.

## Template provenance

AGX template `agent-control/v1` is a deployment-owned clean subset. Portable
control rules were distilled from
`zaurakworks/agent-system@b0e6e0e8244ef518f671e2326745cd67c6d2307a` (the
historical snapshot preserved after that repository was renamed from
`agent-control`) and the seven Issue categories shared with
`zaurakworks/agent-plugins@ad07742ade0f0039ed1df1a9262e8f087117fca0`. The
template does not follow Source `main`, and it deliberately omits CAP,
`.cap/`, `src/agent_system/`, live Issues, `work/records/`, monitoring
snapshots, learned project content, local tool output, provider caches, and
machine-specific paths.

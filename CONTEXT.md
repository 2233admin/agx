# AGX Installation Domain

This context defines the terms used to describe an AGX-managed installation.
It separates a requested deployment, observed evidence, and the narrow condition
under which an installation is verified.

## Language

**Installation**:
A user-owned deployment instance identified by an installation ID.
_Avoid_: Deploy, environment

**Bundle**:
An immutable, identified set of inputs selected for an Installation.
_Avoid_: Checkout, latest release

**Plan**:
A side-effect-free description of the changes AGX proposes for an Installation.
_Avoid_: Apply, deployment

**Receipt**:
The recorded outcome of a deployment attempt for one Installation.
_Avoid_: Log, success message

**Evidence Profile**:
A versioned, explicitly selected set of required Observation kinds
(`github-delivery/v1` or `multica-execution/v1`) that defines what counts
as success for one Installation. Never inferred from installed tooling or
discovered resources.
_Avoid_: Mode, config

**Observation**:
One type-safe, credential-free external fact a Source Adapter (GitHub,
Multica, ...) reports about an Installation: source, kind, installation ID,
resource ID, evidence ID, status, schema version, observed-at.
_Avoid_: Event, log line

**Evidence Evaluator**:
The single domain function that takes an Installation ID, an Evidence
Profile, and a set of Observations, and deterministically returns phase,
satisfied/missing requirements, and diagnostics. It never calls an Adapter
and never infers a profile.
_Avoid_: Validator, checker

**Verification** (legacy):
The original fixed GitHub+Multica readback pair. Retained only so old
Receipts stay readable; new code selects an Evidence Profile instead.
_Avoid_: Ready, configured

**Verified**:
The Receipt/EvidenceReceipt phase reached only when every Observation the
selected Evidence Profile requires is present, satisfied, and matches the
same Installation ID. `github-delivery/v1` alone is a complete baseline; it
never requires Multica evidence.
_Avoid_: Completed, deployed

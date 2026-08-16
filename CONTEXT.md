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

**Verification**:
Matching readback evidence for an Installation from GitHub and Multica.
_Avoid_: Ready, configured

**Verified**:
The Receipt state reached only when Verification contains matching GitHub and
Multica evidence for the same Installation.
_Avoid_: Completed, deployed

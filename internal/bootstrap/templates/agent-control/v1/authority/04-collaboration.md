# Collaboration

Split work only when ownership boundaries and integration order are explicit.

- The coordinator owns the Issue contract, shared branch integration, and the
  final acceptance mapping.
- Each implementer owns a disjoint path or responsibility and must preserve
  concurrent work outside it.
- Reviewers are read-only unless separately authorized to fix findings.
- Handoffs name the exact head or working tree, changed files, checks run,
  remaining risks, and the next responsible action.
- Conflicting instructions, overlapping writes, or a changed Issue contract are
  stop conditions for the affected slice.

Use independent review for security-sensitive ownership, credential, deletion,
or remote-mutation behavior. Never describe a local check as external proof.

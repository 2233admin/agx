#!/usr/bin/env python3
"""Validate the portable agent-control repository baseline."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    ".gitattributes",
    ".gitignore",
    ".github/ISSUE_TEMPLATE/01-goal.yml",
    ".github/ISSUE_TEMPLATE/02-need.yml",
    ".github/ISSUE_TEMPLATE/03-delivery.yml",
    ".github/ISSUE_TEMPLATE/04-experiment.yml",
    ".github/ISSUE_TEMPLATE/05-research.yml",
    ".github/ISSUE_TEMPLATE/06-friction.yml",
    ".github/ISSUE_TEMPLATE/07-proposal.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/workflows/validate.yml",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "authority/00-map.md",
    "authority/01-knowledge.md",
    "authority/02-long-horizon-work.md",
    "authority/04-collaboration.md",
    "authority/10-operating-ledger.md",
    "knowledge/README.md",
    "work/current.md",
)
FORBIDDEN = (
    "C:" + "/" + "Users/",
    "C:" + chr(92) + "Users" + chr(92),
    "/" + "Users/",
    "observed" + "At",
    "zaurakworks/" + "agent-control",
)
FORBIDDEN_PATH_PREFIXES = (
    ".cap/",
    "src/agent_system/",
    "work/records/",
    "work/history/",
    "plugins/",
    "entrypoints/",
)


def main() -> int:
    errors: list[str] = []
    for relative in REQUIRED:
        path = ROOT / relative
        if not path.is_file():
            errors.append(f"missing required file: {relative}")
    agents = ROOT / "AGENTS.md"
    if agents.is_file():
        agents_text = agents.read_text(encoding="utf-8")
        if "Evidence Profile" not in agents_text:
            errors.append("AGENTS.md: missing Evidence Profile language")
        if "verified" in agents_text and "never `verified`" not in agents_text:
            errors.append("AGENTS.md: must reserve verified for Evidence Profile readback")
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or ".git" in path.parts:
            continue
        data = path.read_bytes()
        relative = path.relative_to(ROOT).as_posix()
        if any(relative == prefix[:-1] or relative.startswith(prefix) for prefix in FORBIDDEN_PATH_PREFIXES):
            errors.append(f"source-monorepo path is not part of the clean template: {relative}")
        if b"\r" in data:
            errors.append(f"non-LF line ending: {relative}")
        text = data.decode("utf-8")
        for marker in FORBIDDEN:
            if marker in text:
                errors.append(f"forbidden instance marker in {relative}: {marker}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("agent-control baseline: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

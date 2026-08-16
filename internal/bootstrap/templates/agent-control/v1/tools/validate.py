#!/usr/bin/env python3
"""Validate the portable agent-control repository baseline."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    ".gitattributes",
    ".gitignore",
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
)


def main() -> int:
    errors: list[str] = []
    for relative in REQUIRED:
        path = ROOT / relative
        if not path.is_file():
            errors.append(f"missing required file: {relative}")
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or ".git" in path.parts:
            continue
        data = path.read_bytes()
        relative = path.relative_to(ROOT).as_posix()
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

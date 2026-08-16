#!/usr/bin/env python3
"""Validate the project-local contract formats without third-party packages."""

from __future__ import annotations

import io
import json
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATHS = {
    "goal": ROOT / "schemas" / "goal.schema.json",
    "execution-contract": ROOT / "schemas" / "execution-contract.schema.json",
    "receipt": ROOT / "schemas" / "receipt.schema.json",
}
FORM_PATHS = (
    ROOT / ".github" / "ISSUE_TEMPLATE" / "goal.yml",
    ROOT / ".github" / "ISSUE_TEMPLATE" / "execution.yml",
)
SUPPORTED_SCHEMA_KEYS = {
    "$schema",
    "$id",
    "$defs",
    "$ref",
    "title",
    "description",
    "type",
    "additionalProperties",
    "required",
    "properties",
    "items",
    "minItems",
    "minLength",
    "minimum",
    "uniqueItems",
    "pattern",
    "format",
    "enum",
    "const",
    "x-issue-form-required",
}
TYPE_CHECKS = {
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "string": lambda value: isinstance(value, str),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "null": lambda value: value is None,
}


def load_json(path: Path, errors: list[str]) -> Any | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{path.relative_to(ROOT)}: cannot load JSON: {exc}")
        return None


def resolve_ref(root_schema: dict[str, Any], reference: str) -> dict[str, Any]:
    if not reference.startswith("#/"):
        raise ValueError(f"only local JSON Pointer references are supported: {reference}")
    node: Any = root_schema
    for raw_part in reference[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            raise ValueError(f"unresolved reference: {reference}")
        node = node[part]
    if not isinstance(node, dict):
        raise ValueError(f"reference does not identify a schema object: {reference}")
    return node


def inspect_schema(
    node: Any,
    root_schema: dict[str, Any],
    location: str,
    errors: list[str],
) -> None:
    if not isinstance(node, dict):
        errors.append(f"{location}: schema node must be an object")
        return

    unknown = sorted(set(node) - SUPPORTED_SCHEMA_KEYS)
    if unknown:
        errors.append(f"{location}: unsupported schema keywords: {', '.join(unknown)}")

    declared_type = node.get("type")
    if declared_type is not None and declared_type not in TYPE_CHECKS:
        errors.append(f"{location}: unsupported type {declared_type!r}")

    reference = node.get("$ref")
    if reference is not None:
        if not isinstance(reference, str):
            errors.append(f"{location}: $ref must be a string")
        else:
            try:
                resolve_ref(root_schema, reference)
            except ValueError as exc:
                errors.append(f"{location}: {exc}")

    for container_name in ("$defs", "properties"):
        container = node.get(container_name, {})
        if not isinstance(container, dict):
            errors.append(f"{location}.{container_name}: must be an object")
            continue
        for name, child in container.items():
            inspect_schema(child, root_schema, f"{location}.{container_name}.{name}", errors)

    if "items" in node:
        inspect_schema(node["items"], root_schema, f"{location}.items", errors)


def is_uri(value: str) -> bool:
    parsed = urlparse(value)
    return bool(parsed.scheme in {"http", "https"} and parsed.netloc)


def is_datetime(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def validate_instance(
    value: Any,
    schema: dict[str, Any],
    root_schema: dict[str, Any],
    location: str = "$",
) -> list[str]:
    if "$ref" in schema:
        try:
            target = resolve_ref(root_schema, schema["$ref"])
        except ValueError as exc:
            return [f"{location}: {exc}"]
        return validate_instance(value, target, root_schema, location)

    errors: list[str] = []
    declared_type = schema.get("type")
    if declared_type is not None:
        check = TYPE_CHECKS.get(declared_type)
        if check is None or not check(value):
            return [f"{location}: expected {declared_type}"]

    if "const" in schema and value != schema["const"]:
        errors.append(f"{location}: expected constant {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{location}: value is not in the allowed enum")

    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for required_name in schema.get("required", []):
            if required_name not in value:
                errors.append(f"{location}: missing required property {required_name!r}")
        if schema.get("additionalProperties") is False:
            for extra_name in sorted(set(value) - set(properties)):
                errors.append(f"{location}: unexpected property {extra_name!r}")
        for name, child_value in value.items():
            child_schema = properties.get(name)
            if child_schema is not None:
                errors.extend(
                    validate_instance(
                        child_value,
                        child_schema,
                        root_schema,
                        f"{location}.{name}",
                    )
                )

    if isinstance(value, list):
        minimum_items = schema.get("minItems")
        if minimum_items is not None and len(value) < minimum_items:
            errors.append(f"{location}: expected at least {minimum_items} item(s)")
        if schema.get("uniqueItems"):
            normalized = [json.dumps(item, sort_keys=True) for item in value]
            if len(normalized) != len(set(normalized)):
                errors.append(f"{location}: items must be unique")
        item_schema = schema.get("items")
        if item_schema is not None:
            for index, item in enumerate(value):
                errors.extend(
                    validate_instance(item, item_schema, root_schema, f"{location}[{index}]")
                )

    if isinstance(value, str):
        minimum_length = schema.get("minLength")
        if minimum_length is not None and len(value) < minimum_length:
            errors.append(f"{location}: expected at least {minimum_length} character(s)")
        pattern = schema.get("pattern")
        if pattern is not None and re.search(pattern, value) is None:
            errors.append(f"{location}: does not match {pattern!r}")
        value_format = schema.get("format")
        if value_format == "uri" and not is_uri(value):
            errors.append(f"{location}: expected an absolute HTTP(S) URI")
        elif value_format == "date-time" and not is_datetime(value):
            errors.append(f"{location}: expected an offset-aware ISO 8601 date-time")

    if isinstance(value, int) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if minimum is not None and value < minimum:
            errors.append(f"{location}: expected a value of at least {minimum}")

    return errors


def authority_mentions(entries: list[Any], issue_url: str) -> bool:
    for entry in entries:
        if not isinstance(entry, str):
            continue
        urls = re.findall(r"https://github\.com/[^\s)>,;]+", entry)
        if any(url.rstrip(".,") == issue_url for url in urls):
            return True
    return False


def validate_semantics(instance: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    kind = instance.get("kind")

    if kind == "execution-contract":
        expected_ref = f"{instance.get('contractId')}@{instance.get('revision')}"
        if instance.get("contractRef") != expected_ref:
            errors.append("$.contractRef: must equal contractId@revision")
    elif kind == "receipt" and isinstance(instance.get("contract"), dict):
        contract = instance["contract"]
        expected_ref = f"{contract.get('contractId')}@{contract.get('revision')}"
        if contract.get("contractRef") != expected_ref:
            errors.append("$.contract.contractRef: must equal contractId@revision")
        issue_url = contract.get("issueUrl")
        issue_number = contract.get("issueNumber")
        if isinstance(issue_url, str) and isinstance(issue_number, int):
            url_number = issue_url.rstrip("/").rsplit("/", 1)[-1]
            if url_number != str(issue_number):
                errors.append("$.contract: issueNumber must match issueUrl")

    source = instance.get("source")
    if isinstance(source, dict):
        issue_url = source.get("issueUrl")
        issue_number = source.get("issueNumber")
        if isinstance(issue_url, str) and isinstance(issue_number, int):
            url_number = issue_url.rstrip("/").rsplit("/", 1)[-1]
            if url_number != str(issue_number):
                errors.append("$.source: issueNumber must match issueUrl")
        authorities = instance.get("authorities")
        if (
            isinstance(issue_url, str)
            and isinstance(authorities, list)
            and not authority_mentions(authorities, issue_url)
        ):
            errors.append("$.authorities: must include the source Issue URL")

    if kind == "execution-contract":
        parent = instance.get("parentGoal")
        authorities = instance.get("authorities")
        if isinstance(parent, dict) and isinstance(authorities, list):
            parent_url = parent.get("issueUrl")
            if isinstance(parent_url, str) and not authority_mentions(authorities, parent_url):
                errors.append("$.authorities: must include the parent Goal Issue URL")

    return errors


def parse_form(path: Path, errors: list[str]) -> tuple[str | None, set[str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{path.relative_to(ROOT)}: cannot read: {exc}")
        return None, set()

    metadata = re.search(r"^# contract-schema: (\S+)$", text, re.MULTILINE)
    schema_path = metadata.group(1) if metadata else None
    if schema_path is None:
        errors.append(f"{path.relative_to(ROOT)}: missing contract-schema header")

    ids: list[str] = []
    required_ids: set[str] = set()
    current_id: str | None = None
    current_required = False

    def finish_widget() -> None:
        nonlocal current_id, current_required
        if current_id is not None:
            ids.append(current_id)
            if current_required:
                required_ids.add(current_id)
        current_id = None
        current_required = False

    for line in text.splitlines():
        if re.fullmatch(r"  - type: [A-Za-z]+", line):
            finish_widget()
        id_match = re.fullmatch(r"    id: ([A-Za-z0-9_-]+)", line)
        if id_match:
            current_id = id_match.group(1)
        if current_id is not None and re.fullmatch(r"      required: true", line):
            current_required = True
    finish_widget()

    duplicates = sorted({widget_id for widget_id in ids if ids.count(widget_id) > 1})
    if duplicates:
        errors.append(f"{path.relative_to(ROOT)}: duplicate widget IDs: {', '.join(duplicates)}")
    if not re.search(r"^name: \S", text, re.MULTILINE):
        errors.append(f"{path.relative_to(ROOT)}: missing form name")
    if not re.search(r"^description: \S", text, re.MULTILINE):
        errors.append(f"{path.relative_to(ROOT)}: missing form description")

    return schema_path, required_ids


def check_forms(schemas: dict[str, dict[str, Any]], errors: list[str]) -> None:
    seen_schema_paths: set[str] = set()
    for form_path in FORM_PATHS:
        schema_relative, required_ids = parse_form(form_path, errors)
        if schema_relative is None:
            continue
        seen_schema_paths.add(schema_relative)
        schema_file = ROOT / schema_relative
        matching_kind = next(
            (kind for kind, path in SCHEMA_PATHS.items() if path == schema_file),
            None,
        )
        if matching_kind not in {"goal", "execution-contract"}:
            errors.append(
                f"{form_path.relative_to(ROOT)}: unknown contract schema {schema_relative}"
            )
            continue
        expected = schemas[matching_kind].get("x-issue-form-required")
        if not isinstance(expected, list) or not all(isinstance(item, str) for item in expected):
            errors.append(f"{schema_relative}: x-issue-form-required must be a string array")
            continue
        expected_ids = set(expected)
        if required_ids != expected_ids:
            missing = sorted(expected_ids - required_ids)
            extra = sorted(required_ids - expected_ids)
            details = []
            if missing:
                details.append(f"missing required IDs {', '.join(missing)}")
            if extra:
                details.append(f"unexpected required IDs {', '.join(extra)}")
            errors.append(f"{form_path.relative_to(ROOT)}: {'; '.join(details)}")

    expected_paths = {
        str(SCHEMA_PATHS[kind].relative_to(ROOT)).replace("\\", "/")
        for kind in ("goal", "execution-contract")
    }
    if seen_schema_paths != expected_paths:
        errors.append("Issue Forms must map exactly once to the Goal and Execution Contract schemas")


def check_examples(schemas: dict[str, dict[str, Any]], errors: list[str]) -> int:
    counts = {
        (kind, expectation): 0
        for kind in SCHEMA_PATHS
        for expectation in ("valid", "invalid")
    }
    total = 0

    for expectation in ("valid", "invalid"):
        directory = ROOT / "examples" / expectation
        for path in sorted(directory.glob("*.json")):
            total += 1
            instance = load_json(path, errors)
            if not isinstance(instance, dict):
                if instance is not None:
                    errors.append(f"{path.relative_to(ROOT)}: example root must be an object")
                continue
            kind = instance.get("kind")
            schema = schemas.get(kind)
            if schema is None:
                errors.append(f"{path.relative_to(ROOT)}: unknown or missing kind {kind!r}")
                continue
            counts[(kind, expectation)] += 1
            instance_errors = validate_instance(instance, schema, schema)
            instance_errors.extend(validate_semantics(instance))
            if expectation == "valid" and instance_errors:
                for message in instance_errors:
                    errors.append(f"{path.relative_to(ROOT)}: {message}")
            elif expectation == "invalid" and not instance_errors:
                errors.append(f"{path.relative_to(ROOT)}: expected validation failure")

    for (kind, expectation), count in counts.items():
        if count == 0:
            errors.append(f"examples/{expectation}: missing {kind} example")
    return total


def check_project_surface(errors: list[str]) -> None:
    try:
        claude_entry = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"CLAUDE.md: cannot read: {exc}")
    else:
        if claude_entry != "@AGENTS.md\n":
            errors.append("CLAUDE.md: must contain only the canonical @AGENTS.md import")

    required_files = (
        "AGENTS.md",
        "README.md",
        "tools/contract.py",
        "tests/test_contract.py",
        "tests/fixtures/execution_issue.json",
        "tests/fixtures/goal_issue.json",
        "tests/fixtures/native_parent.json",
    )
    for required_file in required_files:
        path = ROOT / required_file
        if not path.is_file() or not path.read_text(encoding="utf-8").strip():
            errors.append(f"{required_file}: missing or empty")

    try:
        ignored_lines = {
            line.strip() for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        }
    except OSError as exc:
        errors.append(f".gitignore: cannot read: {exc}")
    else:
        if "run-packages/" not in ignored_lines:
            errors.append(".gitignore: run-packages/ must be ignored")

    config_path = ROOT / ".github" / "ISSUE_TEMPLATE" / "config.yml"
    try:
        config = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{config_path.relative_to(ROOT)}: cannot read: {exc}")
    else:
        if not re.search(r"^blank_issues_enabled: false$", config, re.MULTILINE):
            errors.append("Issue template config must disable blank Issues")

    workflows = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    invocations = 0
    for path in workflows:
        text = path.read_text(encoding="utf-8")
        invocations += len(re.findall(r"\bpython tools/validate\.py\b", text))
        if re.search(r"\b(?:pip|poetry|uv)\s+install\b", text):
            errors.append(f"{path.relative_to(ROOT)}: validation workflow must not install dependencies")
    if invocations != 1:
        errors.append("CI must invoke 'python tools/validate.py' exactly once")


def check_unit_tests(errors: list[str]) -> int:
    try:
        suite = unittest.defaultTestLoader.discover(
            str(ROOT / "tests"),
            pattern="test_*.py",
        )
    except Exception as exc:
        errors.append(f"unit test discovery failed: {exc}")
        return 0
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=0).run(suite)
    for test, traceback in result.failures + result.errors:
        details = [line for line in traceback.splitlines() if line.strip()]
        message = details[-1] if details else "unknown failure"
        errors.append(f"{test.id()}: {message}")
    return result.testsRun


def main() -> int:
    errors: list[str] = []
    schemas: dict[str, dict[str, Any]] = {}

    for kind, path in SCHEMA_PATHS.items():
        schema = load_json(path, errors)
        if not isinstance(schema, dict):
            if schema is not None:
                errors.append(f"{path.relative_to(ROOT)}: schema root must be an object")
            continue
        schemas[kind] = schema
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            errors.append(f"{path.relative_to(ROOT)}: expected JSON Schema Draft 2020-12")
        inspect_schema(schema, schema, str(path.relative_to(ROOT)), errors)

    example_count = 0
    if len(schemas) == len(SCHEMA_PATHS):
        check_forms(schemas, errors)
        example_count = check_examples(schemas, errors)
    check_project_surface(errors)
    unit_test_count = check_unit_tests(errors)

    if errors:
        print("validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(
        f"validation passed: {len(schemas)} schemas, "
        f"{example_count} examples, {len(FORM_PATHS)} Issue Forms, "
        f"{unit_test_count} execution-loop tests"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

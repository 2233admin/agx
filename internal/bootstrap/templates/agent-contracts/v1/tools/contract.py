#!/usr/bin/env python3
"""Capture repository contracts and safely deliver snapshot-bound Receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

try:
    from .validate import validate_instance, validate_semantics
except ImportError:  # Direct execution: python tools/contract.py
    from validate import validate_instance, validate_semantics

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "@@AGX_TARGET_SLUG@@"
OWNER, REPOSITORY_NAME = REPOSITORY.split("/", 1)
ISSUE_URL_RE = re.compile(
    r"^https://github\.com/@@AGX_TARGET_SLUG@@/issues/([1-9][0-9]*)$"
)
CONTRACT_ID_RE = re.compile(r"^exec-[a-z0-9][a-z0-9-]*$")
GOAL_ID_RE = re.compile(r"^goal-[a-z0-9][a-z0-9-]*$")
VERSION_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
BOOTSTRAP_GOAL_NUMBER = 1
BOOTSTRAP_GOAL_ID = "goal-@@AGX_REPOSITORY@@-001"

EXECUTION_FIELDS = {
    "合同 ID": "contractId",
    "修订版本": "revision",
    "不可变合同引用": "contractRef",
    "父目标": "parentGoal",
    "当前目标": "objective",
    "范围内": "scopeIn",
    "范围外": "scopeOut",
    "完成标准": "successCriteria",
    "合同状态依据与只读来源": "authorities",
    "允许的动作与写入": "permissionsAllowed",
    "禁止的动作与写入": "permissionsForbidden",
    "依赖": "dependencies",
    "交付物": "deliverables",
    "停止条件": "stopConditions",
    "当前负责人动作": "ownerAction",
}
GOAL_FIELDS = {
    "合同 ID": "contractId",
    "目标": "objective",
    "成功标准": "successCriteria",
    "合同状态依据与引用": "authorities",
    "允许的动作与写入": "permissionsAllowed",
    "禁止的动作与写入": "permissionsForbidden",
    "依赖": "dependencies",
    "交付物": "deliverables",
    "停止条件": "stopConditions",
    "当前负责人动作": "ownerAction",
}
PARENT_QUERY = (
    "query($owner:String!,$name:String!,$number:Int!){"
    "repository(owner:$owner,name:$name){issue(number:$number){number url "
    "parent{number url repository{nameWithOwner}}}}}"
)

Runner = Callable[..., subprocess.CompletedProcess[str]]


class ContractError(RuntimeError):
    """A closed-fail contract, source, or delivery error."""


class GhClient:
    """Narrow argv-only adapter for this repository's required GitHub operations."""

    def __init__(self, runner: Runner = subprocess.run) -> None:
        self._runner = runner

    def _invoke(self, args: Sequence[str], input_text: str | None = None) -> Any:
        argv = ["gh", *args]
        completed = self._runner(
            argv,
            cwd=ROOT,
            input=input_text,
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise ContractError(f"gh command failed without changing GitHub (exit {completed.returncode})")
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ContractError("gh returned malformed JSON") from exc

    def issue(self, number: int) -> dict[str, Any]:
        payload = self._invoke(
            [
                "issue",
                "view",
                str(number),
                "--repo",
                REPOSITORY,
                "--json",
                "number,title,body,updatedAt,url,state",
            ]
        )
        return _validate_issue_payload(payload, number)

    def parent(self, number: int) -> dict[str, Any] | None:
        payload = self._invoke(
            [
                "api",
                "graphql",
                "-f",
                f"query={PARENT_QUERY}",
                "-F",
                f"owner={OWNER}",
                "-F",
                f"name={REPOSITORY_NAME}",
                "-F",
                f"number={number}",
            ]
        )
        try:
            issue = payload["data"]["repository"]["issue"]
            parent = issue["parent"]
        except (KeyError, TypeError) as exc:
            raise ContractError("GitHub returned a malformed native-parent response") from exc
        if issue.get("number") != number or issue.get("url") != issue_url(number):
            raise ContractError("native-parent response identifies a different source Issue")
        if parent is None:
            return None
        try:
            return {
                "number": parent["number"],
                "url": parent["url"],
                "repository": parent["repository"]["nameWithOwner"],
            }
        except (KeyError, TypeError) as exc:
            raise ContractError("GitHub returned a malformed native parent") from exc

    def post_comment(self, number: int, body: str) -> dict[str, Any]:
        payload = self._invoke(
            [
                "api",
                "--method",
                "POST",
                f"repos/{REPOSITORY}/issues/{number}/comments",
                "--input",
                "-",
            ],
            input_text=json.dumps({"body": body}, ensure_ascii=False),
        )
        if not isinstance(payload, dict):
            raise ContractError("gh returned a malformed comment result")
        return payload


def issue_url(number: int) -> str:
    return f"https://github.com/{REPOSITORY}/issues/{number}"


def issue_number(url: str) -> int:
    match = ISSUE_URL_RE.fullmatch(url)
    if not match:
        raise ContractError(f"unsupported Issue URL; only {REPOSITORY} is allowed")
    return int(match.group(1))


def _validate_issue_payload(payload: Any, expected_number: int) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ContractError("GitHub returned a malformed Issue")
    expected = {
        "number": int,
        "title": str,
        "body": str,
        "updatedAt": str,
        "url": str,
        "state": str,
    }
    for field, field_type in expected.items():
        if not isinstance(payload.get(field), field_type):
            raise ContractError(f"GitHub Issue is missing valid {field}")
    if payload["number"] != expected_number or payload["url"] != issue_url(expected_number):
        raise ContractError("GitHub returned a different Issue than requested")
    if not VERSION_RE.fullmatch(payload["updatedAt"]):
        raise ContractError("GitHub Issue updatedAt is not a supported version scalar")
    return payload


def content_digest(body: str) -> str:
    """Hash the exact UTF-8 Issue body returned by GitHub."""
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def _parse_sections(body: str, fields: Mapping[str, str]) -> dict[str, str]:
    matches = list(re.finditer(r"(?m)^### ([^\r\n]+)\r?$", body))
    headings = [match.group(1).strip() for match in matches]
    duplicates = sorted({heading for heading in headings if headings.count(heading) > 1})
    if duplicates:
        raise ContractError(f"duplicate Issue Form section: {', '.join(duplicates)}")
    unknown = sorted(set(headings) - set(fields))
    if unknown:
        raise ContractError(f"unsupported Issue Form section: {', '.join(unknown)}")
    missing = [heading for heading in fields if heading not in headings]
    if missing:
        raise ContractError(f"missing required Issue Form section: {', '.join(missing)}")

    parsed: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        value = body[start:end].strip()
        if not value or value == "_No response_":
            raise ContractError(f"empty required Issue Form section: {match.group(1)}")
        parsed[fields[match.group(1).strip()]] = value
    return parsed


def _scalar(value: str, field: str) -> str:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ContractError(f"{field} must contain exactly one value")
    return lines[0]


def _items(value: str, field: str, allow_none: bool = False) -> list[str]:
    if allow_none and value.strip() == "无":
        return []
    items: list[str] = []
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        line = re.sub(r"^(?:[-*+]\s+|[1-9][0-9]*[.)]\s+)", "", line).strip()
        if not line:
            raise ContractError(f"{field} contains an empty list item")
        items.append(line)
    if not items:
        raise ContractError(f"{field} must contain at least one item")
    if len(items) != len(set(items)):
        raise ContractError(f"{field} contains duplicate items")
    return items




def _source(issue: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "issueUrl": issue["url"],
        "issueNumber": issue["number"],
        "remoteVersion": issue["updatedAt"],
        "contentDigest": content_digest(issue["body"]),
    }


def _goal_contract_id(parent_issue: Mapping[str, Any]) -> str:
    body = parent_issue["body"]
    if "### 合同 ID" in body:
        fields = _parse_sections(body, GOAL_FIELDS)
        contract_id = _scalar(fields["contractId"], "合同 ID")
    elif parent_issue["number"] == BOOTSTRAP_GOAL_NUMBER:
        match = re.match(r"\A`contract-id: (goal-[a-z0-9][a-z0-9-]*)`(?:\r?\n|\Z)", body)
        if not match or match.group(1) != BOOTSTRAP_GOAL_ID:
            raise ContractError("bootstrap Goal #1 has an invalid legacy contract identifier")
        contract_id = match.group(1)
    else:
        raise ContractError("parent Goal does not use the repository Goal Issue Form")
    if not GOAL_ID_RE.fullmatch(contract_id):
        raise ContractError("parent Goal Contract ID is malformed")
    return contract_id


def capture_goal(issue: Mapping[str, Any]) -> dict[str, Any]:
    fields = _parse_sections(issue["body"], GOAL_FIELDS)
    contract_id = _scalar(fields["contractId"], "合同 ID")
    if not GOAL_ID_RE.fullmatch(contract_id):
        raise ContractError("Goal Contract ID is malformed")
    package = {
        "schemaVersion": "1.0",
        "kind": "goal",
        "contractId": contract_id,
        "source": _source(issue),
        "objective": fields["objective"],
        "successCriteria": _items(fields["successCriteria"], "success criteria"),
        "authorities": _items(fields["authorities"], "authorities"),
        "permissions": {
            "allowed": _items(fields["permissionsAllowed"], "allowed actions"),
            "forbidden": _items(fields["permissionsForbidden"], "forbidden actions"),
        },
        "dependencies": _items(fields["dependencies"], "dependencies", allow_none=True),
        "deliverables": _items(fields["deliverables"], "deliverables"),
        "stopConditions": _items(fields["stopConditions"], "stop conditions"),
        "ownerAction": fields["ownerAction"],
    }
    _validate_document(package, "goal.schema.json")
    return package


def capture_execution(issue: Mapping[str, Any], client: GhClient) -> dict[str, Any]:
    fields = _parse_sections(issue["body"], EXECUTION_FIELDS)
    contract_id = _scalar(fields["contractId"], "合同 ID")
    revision_text = _scalar(fields["revision"], "修订版本")
    contract_ref = _scalar(fields["contractRef"], "不可变合同引用")
    parent_url = _scalar(fields["parentGoal"], "父目标")
    if not CONTRACT_ID_RE.fullmatch(contract_id):
        raise ContractError("Execution Contract ID is malformed")
    if not re.fullmatch(r"[1-9][0-9]*", revision_text):
        raise ContractError("Revision must be a positive integer")
    revision = int(revision_text)
    if contract_ref != f"{contract_id}@{revision}":
        raise ContractError("Immutable contract reference must equal contractId@revision")

    parent_number = issue_number(parent_url)
    native_parent = client.parent(issue["number"])
    expected_parent = {
        "number": parent_number,
        "url": parent_url,
        "repository": REPOSITORY,
    }
    if native_parent != expected_parent:
        raise ContractError("native GitHub parent does not match the stated Parent Goal")
    parent_issue = client.issue(parent_number)
    parent_contract_id = _goal_contract_id(parent_issue)

    package = {
        "schemaVersion": "1.0",
        "kind": "execution-contract",
        "contractId": contract_id,
        "revision": revision,
        "contractRef": contract_ref,
        "source": _source(issue),
        "parentGoal": {
            "contractId": parent_contract_id,
            "relationship": "github-sub-issue",
            "issueUrl": parent_url,
        },
        "objective": fields["objective"],
        "scope": {
            "included": _items(fields["scopeIn"], "in scope"),
            "excluded": _items(fields["scopeOut"], "out of scope"),
        },
        "successCriteria": _items(fields["successCriteria"], "completion criteria"),
        "authorities": _items(fields["authorities"], "authorities"),
        "permissions": {
            "allowed": _items(fields["permissionsAllowed"], "allowed actions"),
            "forbidden": _items(fields["permissionsForbidden"], "forbidden actions"),
        },
        "dependencies": _items(fields["dependencies"], "dependencies", allow_none=True),
        "deliverables": _items(fields["deliverables"], "deliverables"),
        "stopConditions": _items(fields["stopConditions"], "stop conditions"),
        "ownerAction": fields["ownerAction"],
    }
    _validate_document(package, "execution-contract.schema.json")
    return package


def capture(url: str, client: GhClient) -> dict[str, Any]:
    number = issue_number(url)
    issue = client.issue(number)
    if issue["url"] != url:
        raise ContractError("captured Issue URL differs from the requested URL")
    if "### 不可变合同引用" in issue["body"]:
        return capture_execution(issue, client)
    return capture_goal(issue)


def _schema(name: str) -> dict[str, Any]:
    try:
        payload = json.loads((ROOT / "schemas" / name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot load {name}") from exc
    if not isinstance(payload, dict):
        raise ContractError(f"{name} is malformed")
    return payload


def _validate_document(document: Any, schema_name: str) -> None:
    if not isinstance(document, dict):
        raise ContractError("JSON document root must be an object")
    schema = _schema(schema_name)
    errors = validate_instance(document, schema, schema)
    errors.extend(validate_semantics(document))
    if errors:
        raise ContractError("schema validation failed: " + "; ".join(errors))


def validate_receipt(receipt: Any, package: Any) -> None:
    _validate_document(package, "execution-contract.schema.json")
    _validate_document(receipt, "receipt.schema.json")
    expected = {
        "contractId": package["contractId"],
        "revision": package["revision"],
        "contractRef": package["contractRef"],
        "issueUrl": package["source"]["issueUrl"],
        "issueNumber": package["source"]["issueNumber"],
        "remoteVersion": package["source"]["remoteVersion"],
        "contentDigest": package["source"]["contentDigest"],
    }
    if receipt["contract"] != expected:
        raise ContractError("Receipt contract binding does not equal the captured snapshot")


def assert_fresh(package: dict[str, Any], client: GhClient) -> None:
    _validate_document(package, "execution-contract.schema.json")
    number = issue_number(package["source"]["issueUrl"])
    current_issue = client.issue(number)
    current = capture_execution(current_issue, client)
    if current != package:
        raise ContractError("remote Execution Contract drifted from the captured snapshot")


def _markdown_list(values: Sequence[str], empty: str = "无。") -> str:
    return "\n".join(f"- {value}" for value in values) if values else f"- {empty}"


def _json_fence(payload: str) -> str:
    longest = max((len(match.group(0)) for match in re.finditer(r"`+", payload)), default=0)
    return "`" * max(3, longest + 1)


def render_receipt(
    receipt: dict[str, Any], package: dict[str, Any], client: GhClient
) -> str:
    validate_receipt(receipt, package)
    assert_fresh(package, client)
    artifacts = []
    for artifact in receipt["artifacts"]:
        line = f"- [{artifact['name']}]({artifact['url']})"
        if "commit" in artifact:
            line += f"，commit `{artifact['commit']}`"
        artifacts.append(line)
    verification = [
        f"- `{item['command']}` — {item['result']}" for item in receipt["verification"]
    ]
    machine = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)
    fence = _json_fence(machine)
    source = package["source"]
    outcome = {"delivered": "已交付", "blocked": "受阻"}[receipt["outcome"]]
    return "\n".join(
        [
            "## 执行回执",
            "",
            f"- 回执：`{receipt['receiptId']}`",
            f"- 结果：**{outcome}**",
            f"- 合同：`{package['contractRef']}`",
            f"- 捕获议题：[#{source['issueNumber']}]({source['issueUrl']})",
            f"- 捕获版本：`{source['remoteVersion']}`",
            f"- 捕获摘要：`{source['contentDigest']}`",
            f"- 提交时间：`{receipt['submittedAt']}`",
            "",
            "### 摘要",
            "",
            receipt["summary"],
            "",
            "### 产物",
            "",
            "\n".join(artifacts) if artifacts else "- 无。",
            "",
            "### 验证",
            "",
            "\n".join(verification),
            "",
            "### 全局写入",
            "",
            _markdown_list(receipt["globalWrites"]),
            "",
            "### 剩余未知",
            "",
            _markdown_list(receipt["remainingUnknowns"]),
            "",
            "本回执仅记录交付或阻塞情况，供负责人评审；不代表验收，也不会关闭议题或改变生命周期状态。",
            "",
            "<details>",
            "<summary>机器可读回执 JSON</summary>",
            "",
            f"{fence}json",
            machine,
            fence,
            "",
            "</details>",
            "",
        ]
    )


def post_receipt(
    receipt: dict[str, Any],
    package: dict[str, Any],
    client: GhClient,
    *,
    dry_run: bool = False,
) -> tuple[str, dict[str, Any] | None]:
    rendered = render_receipt(receipt, package, client)
    if dry_run:
        return rendered, None
    result = client.post_comment(package["source"]["issueNumber"], rendered)
    return rendered, result


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot load JSON from {path}") from exc
    if not isinstance(payload, dict):
        raise ContractError(f"JSON root in {path} must be an object")
    return payload


def _write_package(package: dict[str, Any], output: Path) -> None:
    run_root = (ROOT / "run-packages").resolve()
    resolved = output.resolve()
    try:
        resolved.relative_to(run_root)
    except ValueError as exc:
        raise ContractError("capture output must be inside ignored run-packages/") from exc
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(
        json.dumps(package, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture_parser = subparsers.add_parser("capture", help="capture a supported Issue")
    capture_parser.add_argument("issue_url")
    capture_parser.add_argument("--output", type=Path)

    for command, help_text in (
        ("receipt-validate", "validate a Receipt binding offline"),
        ("receipt-render", "re-fetch and render a Receipt without posting"),
        ("receipt-post", "re-fetch and post a Receipt comment"),
    ):
        receipt_parser = subparsers.add_parser(command, help=help_text)
        receipt_parser.add_argument("--package", type=Path, required=True)
        receipt_parser.add_argument("--receipt", type=Path, required=True)
        if command == "receipt-post":
            receipt_parser.add_argument(
                "--dry-run", action="store_true", help="render after freshness checks but do not post"
            )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    client = GhClient()
    try:
        if args.command == "capture":
            package = capture(args.issue_url, client)
            output = args.output or ROOT / "run-packages" / f"issue-{package['source']['issueNumber']}.json"
            _write_package(package, output)
            print(output.resolve())
            return 0

        package = _load_json(args.package)
        receipt = _load_json(args.receipt)
        if args.command == "receipt-validate":
            validate_receipt(receipt, package)
            print("Receipt is schema-valid and bound to the captured snapshot.")
            return 0
        if args.command == "receipt-render":
            print(render_receipt(receipt, package, client), end="")
            return 0
        rendered, result = post_receipt(
            receipt,
            package,
            client,
            dry_run=args.dry_run,
        )
        if args.dry_run:
            print(rendered, end="")
        else:
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ContractError as exc:
        print(f"contract error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

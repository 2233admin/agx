package smoke

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bootstrap"
)

type fakeRunner struct {
	merged               bool
	missingPointer       bool
	missingProjectItemID bool
	wrongProject         bool
	unrelatedCheck       bool
	impostorCheck        bool
	wrongWorkflow        bool
	changesWorkflow      bool
}

func (fakeRunner) LookPath(name string) (string, error) {
	if name != "gh" {
		return "", errors.New("not found")
	}
	return "tools/gh", nil
}

func (runner fakeRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
	if name != "gh" || len(args) < 2 {
		return nil, errors.New("unexpected command")
	}
	marker := "AGX-Installation: install-test"
	if args[0] == "issue" && args[1] == "list" {
		return json.Marshal([]map[string]any{{
			"number": 12, "url": "https://github.com/octo-lab/agent-control/issues/12",
			"title": "Bootstrap Verification [install-test]", "body": marker,
		}})
	}
	if args[0] == "project" && args[1] == "item-list" {
		issueURL := "https://github.com/octo-lab/agent-control/issues/12"
		if runner.wrongProject {
			issueURL = "https://github.com/octo-lab/agent-control/issues/999"
		}
		itemID := "PVTI_item"
		if runner.missingProjectItemID {
			itemID = ""
		}
		return json.Marshal(map[string]any{
			"totalCount": 1,
			"items":      []map[string]any{{"id": itemID, "content": map[string]any{"url": issueURL}}},
		})
	}
	if args[0] == "pr" && args[1] == "list" {
		state := "OPEN"
		var mergedAt any
		if runner.merged {
			state = "MERGED"
			mergedAt = "2026-08-18T00:00:00Z"
		}
		checkName := "validate"
		workflowName := "Validate control baseline"
		if runner.unrelatedCheck {
			checkName = "unrelated tests"
		}
		if runner.impostorCheck {
			workflowName = "Validate docs"
		}
		files := []map[string]any{{"path": "work/current.md"}}
		if runner.changesWorkflow {
			files = append(files, map[string]any{"path": ".github/workflows/validate.yml"})
		}
		return json.Marshal([]map[string]any{{
			"number": 13, "url": "https://github.com/octo-lab/agent-control/pull/13",
			"title":       "Bootstrap Verification [install-test]",
			"body":        marker + "\nValidation-Command: python tools/validate.py\nValidation-Result: passed",
			"headRefName": "agx/bootstrap-verification-install-test",
			"state":       state, "mergedAt": mergedAt, "files": files,
			"statusCheckRollup": []map[string]any{{
				"__typename": "CheckRun", "name": checkName, "workflowName": workflowName,
				"status": "COMPLETED", "conclusion": "SUCCESS",
			}},
		}})
	}
	if args[0] == "api" && strings.Contains(args[1], "/contents/work/current.md") {
		content := "Current work: https://github.com/octo-lab/agent-control/issues/12\nAGX-Installation: install-test\n"
		if runner.missingPointer {
			content = "No bootstrap Issue pointer\n"
		}
		return json.Marshal(map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(content))})
	}
	if args[0] == "api" && strings.Contains(args[1], "/contents/.github/workflows/validate.yml") {
		workflow := "name: Validate control baseline\n\non:\n  pull_request:\n  push:\n    branches:\n      - main\n\npermissions:\n  contents: read\n\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Check out repository\n        uses: actions/checkout@v4\n      - name: Set up Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: \"3.11\"\n      - name: Validate repository baseline\n        run: python tools/validate.py\n"
		if runner.wrongWorkflow {
			workflow = "name: Validate control baseline\njobs:\n  validate:\n    steps:\n      - name: Skip validation\n        run: echo skipped\n"
		}
		return json.Marshal(map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(workflow))})
	}
	return nil, errors.New("unexpected gh command")
}

func TestInspectRejectsWrongProjectAndUnrelatedSuccessfulCheck(t *testing.T) {
	contract := testContract()
	evidence, err := Inspect(context.Background(), contract, fakeRunner{wrongProject: true, unrelatedCheck: true})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status == StatusEffective || evidence.ProjectItem != "" || evidence.ValidationResult == "passed" {
		t.Fatalf("unbound Project item or unrelated check became effective: %+v", evidence)
	}
}

func TestInspectRejectsImpostorOrChangedValidationWorkflow(t *testing.T) {
	for _, runner := range []fakeRunner{{impostorCheck: true}, {wrongWorkflow: true}, {changesWorkflow: true}} {
		evidence, err := Inspect(context.Background(), testContract(), runner)
		if err != nil {
			t.Fatal(err)
		}
		if evidence.Status == StatusEffective || evidence.ValidationResult == "passed" {
			t.Fatalf("impostor validation evidence became effective: %+v", evidence)
		}
	}
}

func testContract() Contract {
	return Contract{
		SchemaVersion: ContractVersionV1, InstallationID: "install-test",
		ProjectURL: "https://github.com/orgs/octo-lab/projects/7", ProjectTitle: "agent-control deployment (install-test)",
		ControlRepositoryURL: "https://github.com/octo-lab/agent-control", ContractsRepositoryURL: "https://github.com/octo-lab/agent-contracts",
		Profile: "core", Objective: "complete bootstrap verification",
		IssueTitle: "Bootstrap Verification [install-test]", PullRequestTitle: "Bootstrap Verification [install-test]",
		Marker: "AGX-Installation: install-test", Branch: "agx/bootstrap-verification-install-test",
		ValidationCommand: "python tools/validate.py", RequiredActions: []string{"run bootstrap verification"},
		ValidationWorkflow: "Validate control baseline", ValidationCheck: "validate",
		ValidationWorkflowSHA256: bootstrap.AgentControlValidationWorkflowSHA256,
		RequiredOutputs:          []string{"issue_url", "project_item", "pull_request_url", "validation_result"}, Cleanup: "operator-owned",
	}
}

func TestInspectReturnsEffectiveOnlyForIssueProjectItemPRAndSuccessfulValidation(t *testing.T) {
	contract := testContract()
	evidence, err := Inspect(context.Background(), contract, fakeRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != StatusEffective || evidence.IssueURL == "" || evidence.ProjectItem != "PVTI_item" ||
		evidence.WorkPointer != "work/current.md" || evidence.PullRequestURL == "" ||
		evidence.ValidationResult != "passed" || len(evidence.Problems) != 0 {
		t.Fatalf("evidence = %+v", evidence)
	}
}

func TestInspectDoesNotAcceptMergedPRWithoutWorkPointerEvidence(t *testing.T) {
	contract := testContract()
	evidence, err := Inspect(context.Background(), contract, fakeRunner{merged: true, missingPointer: true})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status == StatusEffective {
		t.Fatalf("merged PR without work pointer became effective: %+v", evidence)
	}
}

func TestInspectKeepsAwaitingWhenMatchingProjectItemHasNoID(t *testing.T) {
	evidence, err := Inspect(context.Background(), testContract(), fakeRunner{missingProjectItemID: true})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != StatusAwaiting || evidence.ProjectItem != "" {
		t.Fatalf("Project item without ID became effective: %+v", evidence)
	}
	if !strings.Contains(strings.Join(evidence.Problems, "\n"), "not in the deployment Project") {
		t.Fatalf("problems = %v", evidence.Problems)
	}
}

func TestDecodeJSONRejectsTrailingValues(t *testing.T) {
	var value map[string]any
	if err := decodeJSON([]byte(`{"ok":true}{"unexpected":true}`), &value); err == nil {
		t.Fatal("decodeJSON() accepted trailing JSON")
	}
}

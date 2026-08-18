package smoke

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
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
	if args[0] == "project" && args[1] == "list" {
		return json.Marshal(map[string]any{
			"projects": []map[string]any{{
				"number": 7, "title": "agent-control deployment (install-test)", "url": "https://github.com/orgs/octo-lab/projects/7",
			}},
			"totalCount": 1,
		})
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

func TestInspectRejectsMatchingProjectItemWithoutID(t *testing.T) {
	evidence, err := Inspect(context.Background(), testContract(), fakeRunner{missingProjectItemID: true})
	if err == nil || evidence.Status == StatusEffective {
		t.Fatalf("Project item without ID evidence=%+v err=%v, want fail closed", evidence, err)
	}
}

type projectInventoryRunner struct {
	fakeRunner
	output []byte
}

func (runner projectInventoryRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "item-list" {
		return runner.output, nil
	}
	return runner.fakeRunner.Run(ctx, dir, name, args...)
}

func TestInspectRejectsIncompleteProjectItemInventory(t *testing.T) {
	invalid := map[string]string{
		"missing items":         `{"totalCount":0}`,
		"null items":            `{"items":null,"totalCount":0}`,
		"items wrong type":      `{"items":{},"totalCount":0}`,
		"missing total count":   `{"items":[]}`,
		"null total count":      `{"items":[],"totalCount":null}`,
		"count wrong type":      `{"items":[],"totalCount":"0"}`,
		"negative count":        `{"items":[],"totalCount":-1}`,
		"count larger":          `{"items":[],"totalCount":1}`,
		"count smaller":         `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":0}`,
		"duplicate field":       `{"items":[],"items":[],"totalCount":0}`,
		"trailing document":     `{"items":[],"totalCount":0}{"extra":true}`,
		"missing item id":       `{"items":[{"content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"malformed item id":     `{"items":[{"id":"bad\\nitem","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"missing content url":   `{"items":[{"id":"PVTI_item","content":{}}],"totalCount":1}`,
		"malformed content url": `{"items":[{"id":"PVTI_item","content":{"url":"https://example.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"root content url":      `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com"}}],"totalCount":1}`,
		"query content url":     `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control/issues/12?tracked=true"}}],"totalCount":1}`,
		"pull content url":      `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control/pull/12"}}],"totalCount":1}`,
		"invalid owner":         `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/bad_owner/agent-control/issues/12"}}],"totalCount":1}`,
		"git suffix repository": `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control.git/issues/12"}}],"totalCount":1}`,
	}
	for name, output := range invalid {
		t.Run(name, func(t *testing.T) {
			evidence, err := Inspect(context.Background(), testContract(), projectInventoryRunner{output: []byte(output)})
			if err == nil || evidence.Status == StatusEffective {
				t.Fatalf("Inspect() evidence=%+v err=%v, want fail closed", evidence, err)
			}
		})
	}
}

func TestValidateContractRejectsProjectOwnerDifferentFromControlRepository(t *testing.T) {
	contract := testContract()
	contract.ProjectURL = "https://github.com/orgs/other-owner/projects/7"
	if _, err := validateContract(contract); err == nil {
		t.Fatal("validateContract() accepted a Project owned outside the control repository owner")
	}
}

func TestProjectCoordinatesRequireCanonicalBoundURL(t *testing.T) {
	invalid := []string{
		"https://github.com/orgs/octo-lab/projects/7/extra",
		"https://github.com/octo-lab/agent-control",
		"https://github.com/orgs/octo-lab/projects/7?tab=items",
		"https://github.com/orgs/octo-lab/projects/7#items",
		"https://github.com:443/orgs/octo-lab/projects/7",
		"https://github.com/orgs/octo-lab/projects/7/",
		"https://user@github.com/orgs/octo-lab/projects/7",
	}
	for _, value := range invalid {
		if _, _, err := projectCoordinates(value); err == nil {
			t.Fatalf("projectCoordinates() accepted %q", value)
		}
	}
}

func TestDecodeJSONRejectsTrailingValues(t *testing.T) {
	var value map[string]any
	if err := decodeJSON([]byte(`{"ok":true}{"unexpected":true}`), &value); err == nil {
		t.Fatal("decodeJSON() accepted trailing JSON")
	}
}

type ownerInventoryRunner struct {
	fakeRunner
	outputs [][]byte
	calls   int
	limits  []string
}

func (runner *ownerInventoryRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "list" {
		runner.limits = append(runner.limits, argumentAfter(args, "--limit"))
		index := runner.calls
		runner.calls++
		if index >= len(runner.outputs) {
			return nil, errors.New("unexpected Project inventory page")
		}
		return runner.outputs[index], nil
	}
	return runner.fakeRunner.Run(ctx, dir, name, args...)
}

func TestInspectExpandsOwnerProjectInventoryToTotalCount(t *testing.T) {
	first := projectInventory(t, 100, 101, false)
	complete := projectInventory(t, 101, 101, false)
	runner := &ownerInventoryRunner{outputs: [][]byte{first, complete}}
	evidence, err := Inspect(context.Background(), testContract(), runner)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != StatusEffective || runner.calls != 2 || strings.Join(runner.limits, ",") != "100,101" {
		t.Fatalf("evidence=%+v calls=%d limits=%v", evidence, runner.calls, runner.limits)
	}
}

func TestInspectRequiresExactlyOneCanonicalProjectInventoryMatch(t *testing.T) {
	for _, test := range []struct {
		name      string
		duplicate bool
	}{
		{name: "missing"},
		{name: "duplicate", duplicate: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			output := projectInventory(t, 2, 2, test.duplicate)
			if !test.duplicate {
				output = projectInventoryWithoutTarget(t)
			}
			runner := &ownerInventoryRunner{outputs: [][]byte{output}}
			if evidence, err := Inspect(context.Background(), testContract(), runner); err == nil || evidence.Status == StatusEffective {
				t.Fatalf("Inspect() evidence=%+v err=%v, want fail closed", evidence, err)
			}
		})
	}
}

func projectInventory(t *testing.T, returned, total int, duplicateTarget bool) []byte {
	t.Helper()
	projects := make([]map[string]any, 0, returned)
	for index := 0; index < returned; index++ {
		number := index + 100
		title := "unrelated deployment " + strconv.Itoa(number)
		projectURL := "https://github.com/orgs/octo-lab/projects/" + strconv.Itoa(number)
		if index == 0 || duplicateTarget && index == 1 {
			number = 7
			title = "agent-control deployment (install-test)"
			projectURL = "https://github.com/orgs/octo-lab/projects/7"
		}
		projects = append(projects, map[string]any{"number": number, "title": title, "url": projectURL})
	}
	output, err := json.Marshal(map[string]any{"projects": projects, "totalCount": total})
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func projectInventoryWithoutTarget(t *testing.T) []byte {
	t.Helper()
	output, err := json.Marshal(map[string]any{
		"projects":   []map[string]any{{"number": 8, "title": "unrelated", "url": "https://github.com/orgs/octo-lab/projects/8"}},
		"totalCount": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func argumentAfter(args []string, name string) string {
	for index, argument := range args {
		if argument == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

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
	issueURL             string
	pullRequestURL       string
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
		issueURL := runner.issueURL
		if issueURL == "" {
			issueURL = "https://github.com/octo-lab/agent-control/issues/12"
		}
		return json.Marshal([]map[string]any{{
			"number": 12, "url": issueURL,
			"title": "Bootstrap Verification [install-test]", "body": marker,
		}})
	}
	if args[0] == "project" && args[1] == "list" {
		return json.Marshal(map[string]any{
			"projects": []map[string]any{{
				"id": "PVT_control", "number": 7, "title": "agent-control deployment (install-test)", "url": "https://github.com/orgs/octo-lab/projects/7",
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
		pullRequestURL := runner.pullRequestURL
		if pullRequestURL == "" {
			pullRequestURL = "https://github.com/octo-lab/agent-control/pull/13"
		}
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
			"number": 13, "url": pullRequestURL,
			"title":       "Bootstrap Verification [install-test]",
			"body":        marker + "\nValidation-Command: python tools/validate.py\nValidation-Result: passed",
			"headRefName": "agx/bootstrap-verification-install-test",
			"headRefOid":  strings.Repeat("a", 40),
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
		rendered, err := bootstrap.Render(bootstrap.KindAgentControl, bootstrap.Params{
			Owner: "octo-lab", Repository: "agent-control", PluginSource: bootstrap.AgentPluginsReferenceRepository,
		})
		if err != nil {
			return nil, err
		}
		var workflow []byte
		for _, file := range rendered.Files {
			if file.Path == ".github/workflows/validate.yml" {
				workflow = file.Content
				break
			}
		}
		if workflow == nil {
			return nil, errors.New("validation workflow fixture is missing")
		}
		if runner.wrongWorkflow {
			workflow = []byte("name: Validate control baseline\njobs:\n  validate:\n    steps:\n      - name: Skip validation\n        run: echo skipped\n")
		}
		return json.Marshal(map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString(workflow)})
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

func TestInspectRejectsBootstrapIssueOutsideControlRepository(t *testing.T) {
	for _, issueURL := range []string{
		"https://github.com/other-owner/agent-control/issues/12",
		"https://github.com/octo-lab/other-repository/issues/12",
	} {
		t.Run(issueURL, func(t *testing.T) {
			evidence, err := Inspect(context.Background(), testContract(), fakeRunner{issueURL: issueURL})
			if err != nil {
				t.Fatal(err)
			}
			if evidence.Status == StatusEffective || evidence.IssueURL != "" || evidence.ProjectItem != "" {
				t.Fatalf("out-of-repository Issue became bootstrap evidence: %+v", evidence)
			}
		})
	}
}

func TestInspectRejectsBootstrapPROutsideControlRepository(t *testing.T) {
	for _, pullRequestURL := range []string{
		"https://github.com/other-owner/agent-control/pull/13",
		"https://github.com/octo-lab/other-repository/pull/13",
	} {
		t.Run(pullRequestURL, func(t *testing.T) {
			evidence, err := Inspect(context.Background(), testContract(), fakeRunner{pullRequestURL: pullRequestURL})
			if err != nil {
				t.Fatal(err)
			}
			if evidence.Status == StatusEffective || evidence.PullRequestURL != "" {
				t.Fatalf("out-of-repository PR became bootstrap evidence: %+v", evidence)
			}
		})
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
		"duplicate nested url":  `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control/issues/12","url":"https://github.com/octo-lab/agent-control/issues/13"}}],"totalCount":1}`,
		"trailing document":     `{"items":[],"totalCount":0}{"extra":true}`,
		"missing item id":       `{"items":[{"content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"control item id":       `{"items":[{"id":"bad\nitem","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"whitespace item id":    `{"items":[{"id":"bad item","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"unicode space item id": `{"items":[{"id":"bad\u00a0item","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"duplicate item id":     `{"items":[{"id":"PVTI_shared","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}},{"id":"PVTI_shared","content":{"url":"https://github.com/octo-lab/agent-control/issues/13"}}],"totalCount":2}`,
		"duplicate content url": `{"items":[{"id":"PVTI_one","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}},{"id":"PVTI_two","content":{"url":"https://github.com/OCTO-LAB/AGENT-CONTROL/issues/12"}}],"totalCount":2}`,
		"missing content url":   `{"items":[{"id":"PVTI_item","content":{}}],"totalCount":1}`,
		"malformed content url": `{"items":[{"id":"PVTI_item","content":{"url":"https://example.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`,
		"wrong content owner":   `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/other-owner/agent-control/issues/12"}}],"totalCount":1}`,
		"wrong content repo":    `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/other-repository/issues/12"}}],"totalCount":1}`,
		"root content url":      `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com"}}],"totalCount":1}`,
		"query content url":     `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control/issues/12?tracked=true"}}],"totalCount":1}`,
		"pull content url":      `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control/pull/12"}}],"totalCount":1}`,
		"invalid owner":         `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/bad_owner/agent-control/issues/12"}}],"totalCount":1}`,
		"git suffix repository": `{"items":[{"id":"PVTI_item","content":{"url":"https://github.com/octo-lab/agent-control.git/issues/12"}}],"totalCount":1}`,
	}
	invalid["oversized item id"] = `{"items":[{"id":"` + strings.Repeat("x", 257) + `","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`
	invalid["multibyte oversized item id"] = `{"items":[{"id":"` + strings.Repeat("é", 130) + `","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`
	for name, output := range invalid {
		t.Run(name, func(t *testing.T) {
			evidence, err := Inspect(context.Background(), testContract(), projectInventoryRunner{output: []byte(output)})
			if err == nil || evidence.Status == StatusEffective {
				t.Fatalf("Inspect() evidence=%+v err=%v, want fail closed", evidence, err)
			}
		})
	}
}

func TestInspectAcceptsOpaqueProjectItemID(t *testing.T) {
	output := []byte(`{"items":[{"id":"opaque:/+.id~=value","content":{"url":"https://github.com/octo-lab/agent-control/issues/12"}}],"totalCount":1}`)
	evidence, err := Inspect(context.Background(), testContract(), projectInventoryRunner{output: output})
	if err != nil || evidence.Status != StatusEffective || evidence.ProjectItem != "opaque:/+.id~=value" {
		t.Fatalf("Inspect() evidence=%+v err=%v", evidence, err)
	}
}

func TestValidateContractRejectsProjectOwnerDifferentFromControlRepository(t *testing.T) {
	contract := testContract()
	contract.ProjectURL = "https://github.com/orgs/other-owner/projects/7"
	if _, err := validateContract(contract); err == nil {
		t.Fatal("validateContract() accepted a Project owned outside the control repository owner")
	}
}

func TestValidateContractRequiresCanonicalDeploymentRepositoryURLs(t *testing.T) {
	invalid := map[string]string{
		"http scheme":        "http://github.com/octo-lab/agent-control",
		"userinfo":           "https://user@github.com/octo-lab/agent-control",
		"port":               "https://github.com:443/octo-lab/agent-control",
		"query":              "https://github.com/octo-lab/agent-control?tab=readme",
		"force query":        "https://github.com/octo-lab/agent-control?",
		"fragment":           "https://github.com/octo-lab/agent-control#readme",
		"opaque":             "https:github.com/octo-lab/agent-control",
		"encoded path":       "https://github.com/octo-lab%2Fagent-control",
		"parent traversal":   "https://github.com/octo-lab/../agent-control",
		"current traversal":  "https://github.com/octo-lab/./agent-control",
		"trailing slash":     "https://github.com/octo-lab/agent-control/",
		"extra path":         "https://github.com/octo-lab/agent-control/settings",
		"invalid owner":      "https://github.com/bad_owner/agent-control",
		"invalid repository": "https://github.com/octo-lab/agent~control",
		"git suffix":         "https://github.com/octo-lab/agent-control.git",
	}
	for name, repositoryURL := range invalid {
		t.Run("control "+name, func(t *testing.T) {
			contract := testContract()
			contract.ControlRepositoryURL = repositoryURL
			if _, err := validateContract(contract); err == nil {
				t.Fatalf("validateContract() accepted control repository URL %q", repositoryURL)
			}
		})
		t.Run("contracts "+name, func(t *testing.T) {
			contract := testContract()
			contract.ContractsRepositoryURL = repositoryURL
			if _, err := validateContract(contract); err == nil {
				t.Fatalf("validateContract() accepted contracts repository URL %q", repositoryURL)
			}
		})
	}
}

func TestValidateContractRequiresMatchingDeploymentRepositoryOwners(t *testing.T) {
	contract := testContract()
	contract.ContractsRepositoryURL = "https://github.com/other-owner/agent-contracts"
	if _, err := validateContract(contract); err == nil {
		t.Fatal("validateContract() accepted deployment repositories with different owners")
	}
}

func TestValidateContractAcceptsCaseInsensitiveDeploymentOwnerMatch(t *testing.T) {
	contract := testContract()
	contract.ContractsRepositoryURL = "https://github.com/OCTO-LAB/agent-contracts"
	slug, err := validateContract(contract)
	if err != nil {
		t.Fatal(err)
	}
	if slug != "octo-lab/agent-control" {
		t.Fatalf("validateContract() slug = %q", slug)
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
	closed  []bool
}

func (runner *ownerInventoryRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "list" {
		runner.limits = append(runner.limits, argumentAfter(args, "--limit"))
		closed := false
		for _, arg := range args {
			if arg == "--closed" {
				closed = true
				break
			}
		}
		runner.closed = append(runner.closed, closed)
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
	if evidence.Status != StatusEffective || runner.calls != 2 || strings.Join(runner.limits, ",") != "100,101" || !runner.closed[0] || !runner.closed[1] {
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

func TestDecodeProjectInventoryRejectsIndependentCollisions(t *testing.T) {
	for _, test := range []struct {
		name    string
		problem string
		mutate  func([]map[string]any)
	}{
		{
			name: "duplicate ID", problem: "duplicate Project id",
			mutate: func(projects []map[string]any) { projects[2]["id"] = projects[1]["id"] },
		},
		{
			name: "duplicate number", problem: "duplicate Project number",
			mutate: func(projects []map[string]any) {
				projects[2]["number"] = projects[1]["number"]
				projects[2]["url"] = "https://github.com/users/other-owner/projects/8"
			},
		},
		{
			name: "duplicate URL", problem: "duplicate Project URL",
			mutate: func(projects []map[string]any) {
				projects[2]["number"] = projects[1]["number"]
				projects[2]["url"] = "https://github.com/orgs/OCTO-LAB/projects/8"
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			projects := []map[string]any{
				{"id": "PVT_target", "number": 7, "title": "agent-control deployment (install-test)", "url": "https://github.com/orgs/octo-lab/projects/7"},
				{"id": "PVT_other", "number": 8, "title": "unrelated deployment", "url": "https://github.com/orgs/octo-lab/projects/8"},
				{"id": "opaque:/+.id~=value", "number": 9, "title": "another deployment", "url": "https://github.com/orgs/octo-lab/projects/9"},
			}
			test.mutate(projects)
			output, err := json.Marshal(map[string]any{"projects": projects, "totalCount": len(projects)})
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := decodeProjectInventory(output); err == nil || !strings.Contains(err.Error(), test.problem) {
				t.Fatalf("decodeProjectInventory() err=%v, want %q", err, test.problem)
			}
		})
	}
}

func TestDecodeProjectInventoryRequiresAndRetainsBoundedOpaqueID(t *testing.T) {
	for name, id := range map[string]any{
		"missing":        nil,
		"empty":          "",
		"control":        "bad\nid",
		"unicode space":  "bad\u00a0id",
		"too long":       strings.Repeat("x", 257),
		"multibyte long": strings.Repeat("é", 130),
	} {
		t.Run(name, func(t *testing.T) {
			project := map[string]any{
				"number": 7, "title": "agent-control deployment (install-test)", "url": "https://github.com/orgs/octo-lab/projects/7",
			}
			if id != nil {
				project["id"] = id
			}
			output, err := json.Marshal(map[string]any{"projects": []map[string]any{project}, "totalCount": 1})
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := decodeProjectInventory(output); err == nil {
				t.Fatal("decodeProjectInventory() accepted missing or invalid Project id")
			}
		})
	}

	opaqueID := "opaque:/+.id~=value"
	output, err := json.Marshal(map[string]any{"projects": []map[string]any{{
		"id": opaqueID, "number": 7, "title": "agent-control deployment (install-test)", "url": "https://github.com/orgs/octo-lab/projects/7",
	}}, "totalCount": 1})
	if err != nil {
		t.Fatal(err)
	}
	projects, total, err := decodeProjectInventory(output)
	if err != nil || total != 1 || len(projects) != 1 || projects[0].ID != opaqueID {
		t.Fatalf("decodeProjectInventory() projects=%+v total=%d err=%v, want retained opaque ID", projects, total, err)
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
		projects = append(projects, map[string]any{"id": "PVT_" + strconv.Itoa(index), "number": number, "title": title, "url": projectURL})
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
		"projects":   []map[string]any{{"id": "PVT_unrelated", "number": 8, "title": "unrelated", "url": "https://github.com/orgs/octo-lab/projects/8"}},
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

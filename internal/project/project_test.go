package project

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type recordedCall struct {
	name string
	args []string
}

type fakeRunner struct {
	calls                 []recordedCall
	linked                bool
	public                bool
	scopes                string
	totalCount            int
	inventoryOutput       []byte
	inventoryOutputs      [][]byte
	createOutput          []byte
	createErr             error
	editOutput            []byte
	viewMode              string
	viewModes             []string
	visibilityFailureMode string
}

func (runner *fakeRunner) LookPath(name string) (string, error) {
	if name != "gh" {
		return "", errors.New("not found")
	}
	return "tools/gh", nil
}

func (runner *fakeRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
	runner.calls = append(runner.calls, recordedCall{name: name, args: append([]string(nil), args...)})
	if name != "gh" {
		return nil, errors.New("unexpected command")
	}
	switch {
	case reflect.DeepEqual(args, []string{"auth", "status", "--active", "--json", "hosts"}):
		scopes := runner.scopes
		if scopes == "" {
			scopes = "project, repo"
		}
		return json.Marshal(map[string]any{"hosts": map[string]any{"github.com": []map[string]any{{
			"active": true, "login": "octo-lab", "scopes": scopes,
		}}}})
	case len(args) >= 2 && args[0] == "project" && args[1] == "list":
		if len(runner.inventoryOutputs) != 0 {
			output := runner.inventoryOutputs[0]
			runner.inventoryOutputs = runner.inventoryOutputs[1:]
			return output, nil
		}
		if runner.inventoryOutput != nil {
			return runner.inventoryOutput, nil
		}
		return json.Marshal(map[string]any{"projects": []any{}, "totalCount": runner.totalCount})
	case len(args) >= 2 && args[0] == "project" && args[1] == "create":
		if runner.createOutput != nil {
			return runner.createOutput, runner.createErr
		}
		return projectPayload(false), runner.createErr
	case len(args) >= 2 && args[0] == "project" && args[1] == "edit":
		if runner.visibilityFailureMode != "" {
			runner.public = runner.visibilityFailureMode == "landed"
			return nil, errors.New("visibility edit failed")
		}
		runner.public = true
		if runner.editOutput != nil {
			return runner.editOutput, nil
		}
		return projectPayload(true), nil
	case len(args) >= 2 && args[0] == "project" && args[1] == "link":
		runner.linked = true
		return nil, nil
	case len(args) >= 2 && args[0] == "project" && args[1] == "view":
		mode := runner.viewMode
		if len(runner.viewModes) != 0 {
			mode = runner.viewModes[0]
			runner.viewModes = runner.viewModes[1:]
		} else if mode == "" {
			mode = runner.visibilityFailureMode
		}
		switch mode {
		case "malformed":
			return []byte(`{"public":`), nil
		case "unavailable":
			return nil, errors.New("project view unavailable")
		case "duplicate-key":
			return []byte(`{"id":"PVT_untrusted","id":"PVT_kwDOA","number":7,"owner":{"login":"octo-lab"},"public":false,"title":"agent-control deployment (install-test)","url":"https://github.com/users/octo-lab/projects/7"}`), nil
		case "missing-public":
			return json.Marshal(map[string]any{
				"id": "PVT_kwDOA", "number": 7, "owner": map[string]any{"login": "octo-lab"},
				"title": "agent-control deployment (install-test)", "url": "https://github.com/users/octo-lab/projects/7",
			})
		case "identity-changed":
			return json.Marshal(map[string]any{
				"id": "PVT_other", "number": 7, "owner": map[string]any{"login": "octo-lab"}, "public": true,
				"title": "agent-control deployment (install-test)", "url": "https://github.com/users/octo-lab/projects/8",
			})
		case "not-landed":
			return projectPayload(false), nil
		}
		return projectPayload(runner.public), nil
	case len(args) >= 2 && args[0] == "repo" && args[1] == "view":
		nodes := []map[string]any{}
		if runner.linked {
			nodes = append(nodes, map[string]any{"id": "PVT_kwDOA", "number": 7, "title": "agent-control deployment (install-test)", "url": "https://github.com/users/octo-lab/projects/7"})
		}
		return json.Marshal(map[string]any{
			"hasIssuesEnabled": true,
			"projectsV2":       map[string]any{"Nodes": nodes},
		})
	}
	return nil, errors.New("unexpected gh command: " + strings.Join(args, " "))
}

func TestPreflightMissingProjectScopeFailsBeforeMutationWithExactRepair(t *testing.T) {
	runner := &fakeRunner{scopes: "repo, workflow"}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	err := Preflight(context.Background(), target, runner)
	if err == nil || !strings.Contains(err.Error(), "gh auth refresh -s project") {
		t.Fatalf("Preflight() err = %v", err)
	}
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "create" || call.args[1] == "edit" || call.args[1] == "link") {
			t.Fatalf("mutation ran without project scope: %+v", call)
		}
	}
}

func TestPreflightFailsClosedWhenProjectInventoryIsTruncated(t *testing.T) {
	runner := &fakeRunner{totalCount: 1001}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	err := Preflight(context.Background(), target, runner)
	if err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("Preflight() err = %v", err)
	}
}

func TestProvisionFailsClosedForInvalidProjectInventorySchema(t *testing.T) {
	tests := map[string]string{
		"unexpected object":      `{"unexpected":true}`,
		"missing projects":       `{"totalCount":0}`,
		"null projects":          `{"projects":null,"totalCount":0}`,
		"projects wrong type":    `{"projects":{},"totalCount":0}`,
		"missing total count":    `{"projects":[]}`,
		"null total count":       `{"projects":[],"totalCount":null}`,
		"count wrong type":       `{"projects":[],"totalCount":"0"}`,
		"negative count":         `{"projects":[],"totalCount":-1}`,
		"count too high":         `{"projects":[],"totalCount":1}`,
		"count too low":          `{"projects":[{"unexpected":true}],"totalCount":0}`,
		"project missing fields": `{"projects":[{"unexpected":true}],"totalCount":1}`,
		"trailing JSON value":    `{"projects":[],"totalCount":0} {"extra":true}`,
	}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	for name, output := range tests {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{inventoryOutput: []byte(output)}
			if _, err := Provision(context.Background(), target, nil, runner, func(Receipt) error { return nil }); err == nil {
				t.Fatal("Provision() accepted invalid Project inventory")
			}
			for _, call := range runner.calls {
				if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "create" || call.args[1] == "edit" || call.args[1] == "link") {
					t.Fatalf("mutation ran after invalid Project inventory: %+v", call)
				}
			}
		})
	}
}

func TestPreflightAcceptsCompleteNonTruncatedInventory(t *testing.T) {
	runner := &fakeRunner{inventoryOutput: inventoryPayload([]byte(`{"id":"PVT_other","number":8,"owner":{"login":"octo-lab"},"public":false,"title":"other deployment","url":"https://github.com/users/octo-lab/projects/8"}`))}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	if err := Preflight(context.Background(), target, runner); err != nil {
		t.Fatalf("Preflight() rejected complete inventory: %v", err)
	}
}

func TestPreflightClassifiesProjectTitleMatches(t *testing.T) {
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	tests := map[string]struct {
		inventory []byte
		wantErr   bool
	}{
		"missing":         {inventory: inventoryPayload()},
		"exact duplicate": {inventory: inventoryPayload(projectPayload(false)), wantErr: true},
		"case variant": {
			inventory: inventoryPayload(projectPayloadWithIdentity("PVT_other", 8, strings.ToUpper(target.Title), false)),
			wantErr:   true,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{inventoryOutput: test.inventory}
			err := Preflight(context.Background(), target, runner)
			if (err != nil) != test.wantErr {
				t.Fatalf("Preflight() err = %v, wantErr = %v", err, test.wantErr)
			}
			for _, call := range runner.calls {
				if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "create" || call.args[1] == "edit" || call.args[1] == "link") {
					t.Fatalf("mutation ran during preflight: %+v", call)
				}
			}
		})
	}
}

func TestDecodeJSONRejectsTrailingValues(t *testing.T) {
	var value map[string]any
	if err := decodeJSON([]byte(`{"ok":true}{"unexpected":true}`), &value); err == nil {
		t.Fatal("decodeJSON() accepted trailing JSON")
	}
}

func TestVerifyRejectsReceiptThatDoesNotMatchProjectReadback(t *testing.T) {
	runner := &fakeRunner{}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	receipt, err := Provision(context.Background(), target, nil, runner, func(Receipt) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	receipt.NodeID = "PVT_tampered"
	if err := Verify(context.Background(), target, receipt, runner); err == nil || !strings.Contains(err.Error(), "DRIFT") {
		t.Fatalf("Verify() accepted tampered receipt: %v", err)
	}
}

func projectPayload(public bool) []byte {
	return projectPayloadWithIdentity("PVT_kwDOA", 7, "agent-control deployment (install-test)", public)
}

func projectPayloadWithIdentity(id string, number int, title string, public bool) []byte {
	data, _ := json.Marshal(map[string]any{
		"id":     id,
		"number": number,
		"owner":  map[string]any{"login": "octo-lab", "type": "User"},
		"public": public,
		"title":  title,
		"url":    "https://github.com/users/octo-lab/projects/" + strconv.Itoa(number),
	})
	return data
}

func inventoryPayload(projects ...[]byte) []byte {
	values := make([]json.RawMessage, len(projects))
	for index, project := range projects {
		values[index] = project
	}
	data, _ := json.Marshal(map[string]any{"projects": values, "totalCount": len(values)})
	return data
}

func TestProvisionRecoversSuccessfulCreateWithInvalidResponseFromUniqueInventory(t *testing.T) {
	for name, createOutput := range map[string][]byte{
		"malformed":      []byte(`{"id":`),
		"missing fields": []byte(`{"id":"PVT_kwDOA"}`),
		"duplicate key":  []byte(`{"id":"PVT_untrusted","id":"PVT_kwDOA","number":7,"owner":{"login":"octo-lab"},"public":false,"title":"agent-control deployment (install-test)","url":"https://github.com/users/octo-lab/projects/7"}`),
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{
				createOutput:     createOutput,
				inventoryOutputs: [][]byte{inventoryPayload(), inventoryPayload(projectPayload(false))},
			}
			target := Target{
				Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
				LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
			}
			var journal []Receipt
			receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
				journal = append(journal, value)
				return nil
			})
			if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-CREATE-PARTIAL") {
				t.Fatalf("Provision() err = %v", err)
			}
			if receipt.Verification != VerificationCreated || receipt.Linked || len(journal) != 1 || journal[0] != receipt {
				t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
			}
			for _, call := range runner.calls {
				if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "edit" || call.args[1] == "link") {
					t.Fatalf("later mutation ran after recovered successful create: %+v", call)
				}
			}
		})
	}
}

func TestProvisionFailsClosedWhenSuccessfulCreateRecoveryInventoryIsInconclusive(t *testing.T) {
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	ambiguous := inventoryPayload(
		projectPayload(false),
		projectPayloadWithIdentity("PVT_other", 8, target.Title, false),
	)
	for name, recoveryInventory := range map[string][]byte{
		"malformed": []byte(`{"projects":`),
		"truncated": []byte(`{"projects":[],"totalCount":1}`),
		"ambiguous": ambiguous,
		"absent":    inventoryPayload(),
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{
				createOutput:     []byte(`{"id":`),
				inventoryOutputs: [][]byte{inventoryPayload(), recoveryInventory},
			}
			var journal []Receipt
			receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
				journal = append(journal, value)
				return nil
			})
			if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-CREATE-UNCERTAIN") {
				t.Fatalf("Provision() err = %v", err)
			}
			if receipt != (Receipt{}) || len(journal) != 0 {
				t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
			}
			for _, call := range runner.calls {
				if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "edit" || call.args[1] == "link") {
					t.Fatalf("later mutation ran after inconclusive create recovery: %+v", call)
				}
			}
		})
	}
}

func TestProvisionRevalidatesRecoveredMalformedCreateBeforeMutation(t *testing.T) {
	runner := &fakeRunner{
		createOutput:     []byte(`{"id":`),
		inventoryOutputs: [][]byte{inventoryPayload(), inventoryPayload(projectPayload(false))},
	}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	receipt, err := Provision(context.Background(), target, nil, runner, func(Receipt) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-CREATE-PARTIAL") {
		t.Fatalf("first Provision() err = %v", err)
	}
	firstRunCalls := len(runner.calls)
	verified, err := Provision(context.Background(), target, &receipt, runner, func(Receipt) error { return nil })
	if err != nil || !verified.Linked || verified.Verification != VerificationReadback {
		t.Fatalf("resume Provision() receipt = %+v, err = %v", verified, err)
	}
	viewIndex, linkIndex := -1, -1
	for index, call := range runner.calls[firstRunCalls:] {
		if len(call.args) < 2 || call.args[0] != "project" {
			continue
		}
		switch call.args[1] {
		case "view":
			if !reflect.DeepEqual(call.args, []string{"project", "view", "7", "--owner", "octo-lab", "--format", "json"}) {
				t.Fatalf("Project view args = %v", call.args)
			}
			if viewIndex == -1 {
				viewIndex = index
			}
		case "link":
			linkIndex = index
		}
	}
	if viewIndex < 0 || linkIndex < 0 || viewIndex >= linkIndex {
		t.Fatalf("resume calls = %+v, want number-based Project view before mutation", runner.calls[firstRunCalls:])
	}
}

func TestProvisionPreservesFailedCreateRecoverySemantics(t *testing.T) {
	runner := &fakeRunner{
		createErr:        errors.New("create failed"),
		inventoryOutputs: [][]byte{inventoryPayload(), inventoryPayload(projectPayload(false))},
	}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	var journal []Receipt
	receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
		journal = append(journal, value)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-CREATE-PARTIAL") {
		t.Fatalf("Provision() err = %v", err)
	}
	if receipt.Verification != VerificationCreated || receipt.Linked || len(journal) != 1 || journal[0] != receipt {
		t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
	}
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "edit" || call.args[1] == "link") {
			t.Fatalf("later mutation ran after partial create: %+v", call)
		}
	}
}

func TestProvisionFailsClosedWhenSuccessfulCreateReadbackIsInconclusive(t *testing.T) {
	tests := map[string]*fakeRunner{
		"unavailable":    {viewMode: "unavailable"},
		"malformed":      {viewMode: "malformed"},
		"duplicate key":  {viewMode: "duplicate-key"},
		"missing fields": {viewMode: "missing-public"},
		"identity drift": {viewMode: "identity-changed"},
		"second lookup mismatch": {
			createOutput: []byte(`{"id":"PVT_untrusted","number":8,"owner":{"login":"octo-lab"},"public":false,"title":"agent-control deployment (install-test)","url":"https://github.com/users/octo-lab/projects/8"}`),
		},
	}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	for name, runner := range tests {
		t.Run(name, func(t *testing.T) {
			var journal []Receipt
			receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
				journal = append(journal, value)
				return nil
			})
			if err == nil || receipt.Verification != VerificationCreated || len(journal) != 1 || journal[0] != receipt {
				t.Fatalf("Provision() receipt = %+v, err = %v, journal = %+v", receipt, err, journal)
			}
			for _, call := range runner.calls {
				if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "edit" || call.args[1] == "link") {
					t.Fatalf("later mutation ran after inconclusive successful create readback: %+v", call)
				}
			}
		})
	}
}

func TestProvisionRevalidatesExistingReceiptBeforeMutation(t *testing.T) {
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	existing := &Receipt{
		Owner: target.Owner, Number: 7, NodeID: "PVT_kwDOA", URL: "https://github.com/users/octo-lab/projects/7",
		Title: target.Title, Visibility: target.Visibility, LinkedRepository: target.LinkedRepository,
		InstallationID: target.InstallationID, Created: true, Verification: VerificationCreated,
	}
	runner := &fakeRunner{viewMode: "identity-changed"}
	if _, err := Provision(context.Background(), target, existing, runner, func(Receipt) error { return nil }); err == nil {
		t.Fatal("Provision() accepted remote drift for an existing receipt")
	}
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "edit" || call.args[1] == "link") {
			t.Fatalf("mutation ran before existing receipt readback: %+v", call)
		}
	}
}

func TestProjectURLsAreCanonicalAndBound(t *testing.T) {
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	invalid := []string{
		"https://github.com/users/other/projects/7",
		"https://github.com/users/octo-lab/projects/8",
		"https://github.com/users/octo-lab/projects/7/extra",
		"https://github.com/octo-lab/agent-control",
		"https://github.com/users/octo-lab/projects/7?tab=items",
		"https://github.com/users/octo-lab/projects/7#items",
		"https://github.com:443/users/octo-lab/projects/7",
		"https://github.com/users/octo-lab/projects/7/",
		"https://user@github.com/users/octo-lab/projects/7",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			payload := projectPayload(false)
			var observed map[string]any
			if err := json.Unmarshal(payload, &observed); err != nil {
				t.Fatal(err)
			}
			observed["url"] = value
			encoded, err := json.Marshal(observed)
			if err != nil {
				t.Fatal(err)
			}
			decoded, decodeErr := decodeProject(encoded)
			if decodeErr == nil {
				if _, err := receiptFromProject(target, decoded); err == nil {
					t.Fatalf("readback accepted Project URL %q", value)
				}
			}
			receipt := Receipt{
				Owner: target.Owner, Number: 7, NodeID: "PVT_kwDOA", URL: value, Title: target.Title,
				Visibility: target.Visibility, LinkedRepository: target.LinkedRepository,
				InstallationID: target.InstallationID, Created: true, Verification: VerificationCreated,
			}
			if err := ValidateReceipt(receipt, target); err == nil {
				t.Fatalf("receipt accepted Project URL %q", value)
			}
		})
	}
}

func TestProvisionCreatesVisibleLinkedProjectAndJournalsEveryMutation(t *testing.T) {
	runner := &fakeRunner{}
	target := Target{
		Owner:            "octo-lab",
		Title:            "agent-control deployment (install-test)",
		Visibility:       VisibilityPublic,
		LinkedRepository: "octo-lab/agent-control",
		InstallationID:   "install-test",
	}
	var journal []Receipt
	receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
		journal = append(journal, value)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Owner != target.Owner || receipt.Number != 7 || receipt.NodeID != "PVT_kwDOA" || receipt.URL == "" ||
		receipt.Visibility != VisibilityPublic || receipt.LinkedRepository != target.LinkedRepository ||
		receipt.Verification != VerificationReadback || !receipt.Created || !receipt.Linked {
		t.Fatalf("receipt = %+v", receipt)
	}
	if len(journal) != 3 {
		t.Fatalf("journal entries = %d, want one after create, visibility edit, and link", len(journal))
	}
	if journal[0].Verification != VerificationCreated || journal[0].Linked ||
		journal[1].Visibility != VisibilityPublic || journal[1].Verification != VerificationConfigured ||
		!journal[2].Linked || journal[2].Verification != VerificationReadback {
		t.Fatalf("journal = %+v", journal)
	}
	writes := []string{}
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && (call.args[1] == "create" || call.args[1] == "edit" || call.args[1] == "link") {
			writes = append(writes, call.args[1])
		}
	}
	if !reflect.DeepEqual(writes, []string{"create", "edit", "link"}) {
		t.Fatalf("project writes = %v", writes)
	}
	if got := strconv.Itoa(receipt.Number); got != "7" {
		t.Fatalf("number = %s", got)
	}
}

func TestProvisionLinksCaseInsensitiveOwnerWithRepositoryNameOnly(t *testing.T) {
	runner := &fakeRunner{}
	target := Target{
		Owner:            "octo-lab",
		Title:            "agent-control deployment (install-test)",
		Visibility:       VisibilityPublic,
		LinkedRepository: "Octo-Lab/agent-control",
		InstallationID:   "install-test",
	}
	if _, err := Provision(context.Background(), target, nil, runner, func(Receipt) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var links []recordedCall
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && call.args[1] == "link" {
			links = append(links, call)
		}
	}
	want := []string{"project", "link", "7", "--owner", "octo-lab", "--repo", "agent-control"}
	if len(links) != 1 || !reflect.DeepEqual(links[0].args, want) {
		t.Fatalf("project link calls = %#v, want %#v", links, want)
	}
}

func TestProvisionRecoversSuccessfulEditWithInvalidResponse(t *testing.T) {
	for name, editOutput := range map[string][]byte{
		"malformed":      []byte(`{"id":`),
		"missing fields": []byte(`{"id":"PVT_kwDOA"}`),
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{editOutput: editOutput}
			target := Target{
				Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
				LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
			}
			var journal []Receipt
			receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
				journal = append(journal, value)
				return nil
			})
			if err != nil {
				t.Fatalf("Provision() failed recovered edit: %v", err)
			}
			if receipt.Visibility != VisibilityPublic || !receipt.Linked || receipt.Verification != VerificationReadback || len(journal) != 3 || journal[1].Verification != VerificationConfigured {
				t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
			}
			var viewIndex, linkIndex = -1, -1
			for index, call := range runner.calls {
				if len(call.args) < 2 || call.args[0] != "project" {
					continue
				}
				if call.args[1] == "view" && viewIndex == -1 {
					viewIndex = index
				}
				if call.args[1] == "link" {
					linkIndex = index
				}
			}
			if viewIndex == -1 || linkIndex == -1 || viewIndex > linkIndex {
				t.Fatalf("view index = %d, link index = %d", viewIndex, linkIndex)
			}
		})
	}
}

func TestProvisionRecoversMismatchedEditResponseBeforeLink(t *testing.T) {
	outputs := map[string][]byte{
		"number":     []byte(`{"id":"PVT_kwDOA","number":8,"owner":{"login":"octo-lab"},"public":true,"title":"agent-control deployment (install-test)","url":"https://github.com/users/octo-lab/projects/8"}`),
		"node ID":    []byte(`{"id":"PVT_other","number":7,"owner":{"login":"octo-lab"},"public":true,"title":"agent-control deployment (install-test)","url":"https://github.com/users/octo-lab/projects/7"}`),
		"visibility": projectPayload(false),
	}
	for name, editOutput := range outputs {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{editOutput: editOutput}
			target := Target{
				Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
				LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
			}
			receipt, err := Provision(context.Background(), target, nil, runner, func(Receipt) error { return nil })
			if err != nil {
				t.Fatalf("Provision() failed semantic edit recovery: %v", err)
			}
			if receipt.Number != 7 || receipt.NodeID != "PVT_kwDOA" || receipt.Visibility != VisibilityPublic || !receipt.Linked {
				t.Fatalf("receipt = %+v", receipt)
			}
			var edits int
			viewIndex, linkIndex := -1, -1
			for index, call := range runner.calls {
				if len(call.args) < 2 || call.args[0] != "project" {
					continue
				}
				switch call.args[1] {
				case "edit":
					edits++
				case "view":
					if viewIndex == -1 {
						viewIndex = index
					}
				case "link":
					linkIndex = index
					if len(call.args) < 3 || call.args[2] != "7" {
						t.Fatalf("link args = %v", call.args)
					}
				}
			}
			if edits != 1 || viewIndex == -1 || linkIndex == -1 || viewIndex > linkIndex {
				t.Fatalf("edit calls = %d, view index = %d, link index = %d", edits, viewIndex, linkIndex)
			}
		})
	}
}

func TestProvisionRejectsMismatchedEditResponseWhenReadbackDrifts(t *testing.T) {
	runner := &fakeRunner{
		editOutput: []byte(`{"id":"PVT_other","number":7,"owner":{"login":"octo-lab"},"public":true,"title":"agent-control deployment (install-test)","url":"https://github.com/users/octo-lab/projects/7"}`),
		viewModes:  []string{"normal", "identity-changed"},
	}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	var journal []Receipt
	receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
		journal = append(journal, value)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-VISIBILITY-UNCERTAIN") {
		t.Fatalf("Provision() err = %v", err)
	}
	if receipt.Visibility != VisibilityPrivate || receipt.Verification != VerificationCreated || receipt.Linked || len(journal) != 1 {
		t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
	}
	var edits, views int
	for _, call := range runner.calls {
		if len(call.args) < 2 || call.args[0] != "project" {
			continue
		}
		switch call.args[1] {
		case "edit":
			edits++
		case "view":
			views++
		case "link":
			t.Fatalf("link ran after inconclusive edit recovery: %+v", call)
		}
	}
	if edits != 1 || views != 2 {
		t.Fatalf("edit calls = %d, view calls = %d", edits, views)
	}
}

func TestProvisionFailsClosedWhenSuccessfulEditRecoveryIsInconclusive(t *testing.T) {
	for _, mode := range []string{"not-landed", "unavailable", "malformed", "missing-public", "identity-changed"} {
		t.Run(mode, func(t *testing.T) {
			runner := &fakeRunner{editOutput: []byte(`{"id":`), viewModes: []string{"normal", mode}}
			target := Target{
				Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
				LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
			}
			var journal []Receipt
			receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
				journal = append(journal, value)
				return nil
			})
			if err == nil {
				t.Fatal("Provision() accepted inconclusive edit recovery")
			}
			if !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("Provision() did not preserve edit response error: %v", err)
			}
			if receipt.Visibility != VisibilityPrivate || receipt.Verification != VerificationCreated || receipt.Linked || len(journal) != 1 {
				t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
			}
			var views int
			for _, call := range runner.calls {
				if len(call.args) >= 2 && call.args[0] == "project" && call.args[1] == "view" {
					views++
				}
				if len(call.args) >= 2 && call.args[0] == "project" && call.args[1] == "link" {
					t.Fatalf("link ran after inconclusive edit recovery: %+v", call)
				}
			}
			if views != 2 {
				t.Fatalf("project view calls = %d, want 2", views)
			}
		})
	}
}

func TestProvisionRecoversLandedVisibilityEditFailure(t *testing.T) {
	runner := &fakeRunner{visibilityFailureMode: "landed"}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	var journal []Receipt
	receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
		journal = append(journal, value)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-VISIBILITY-PARTIAL") {
		t.Fatalf("Provision() err = %v", err)
	}
	if receipt.Visibility != VisibilityPublic || receipt.Verification != VerificationConfigured || receipt.Linked {
		t.Fatalf("receipt = %+v", receipt)
	}
	if len(journal) != 2 || journal[1] != receipt {
		t.Fatalf("journal = %+v, receipt = %+v", journal, receipt)
	}
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && call.args[1] == "link" {
			t.Fatalf("link ran after partial visibility edit: %+v", call)
		}
	}
}

func TestProvisionFailsClosedWhenVisibilityEditDidNotLand(t *testing.T) {
	runner := &fakeRunner{visibilityFailureMode: "not-landed"}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	var journal []Receipt
	receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
		journal = append(journal, value)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-VISIBILITY") || strings.Contains(err.Error(), "PARTIAL") {
		t.Fatalf("Provision() err = %v", err)
	}
	if receipt.Visibility != VisibilityPrivate || receipt.Verification != VerificationCreated || len(journal) != 1 {
		t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
	}
	var views int
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && call.args[1] == "view" {
			views++
		}
	}
	if views != 2 {
		t.Fatalf("project view calls = %d, want 2", views)
	}
}

func TestProvisionFailsClosedWhenVisibilityReadbackIsInconclusive(t *testing.T) {
	for _, mode := range []string{"malformed", "unavailable", "identity-changed"} {
		t.Run(mode, func(t *testing.T) {
			runner := &fakeRunner{visibilityFailureMode: mode, viewModes: []string{"normal", mode}}
			target := Target{
				Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPublic,
				LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
			}
			var journal []Receipt
			receipt, err := Provision(context.Background(), target, nil, runner, func(value Receipt) error {
				journal = append(journal, value)
				return nil
			})
			if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-VISIBILITY-UNCERTAIN") {
				t.Fatalf("Provision() err = %v", err)
			}
			if receipt.Visibility != VisibilityPrivate || receipt.Verification != VerificationCreated || len(journal) != 1 {
				t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
			}
		})
	}
}

func TestProvisionFailsClosedWhenVisibilityReadbackOmitsPublic(t *testing.T) {
	runner := &fakeRunner{visibilityFailureMode: "missing-public"}
	target := Target{
		Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: VisibilityPrivate,
		LinkedRepository: "octo-lab/agent-control", InstallationID: "install-test",
	}
	existing := &Receipt{
		Owner: target.Owner, Number: 7, NodeID: "PVT_kwDOA", URL: "https://github.com/users/octo-lab/projects/7",
		Title: target.Title, Visibility: VisibilityPublic, LinkedRepository: target.LinkedRepository,
		InstallationID: target.InstallationID, Created: true, Verification: VerificationCreated,
	}
	var journal []Receipt
	receipt, err := Provision(context.Background(), target, existing, runner, func(value Receipt) error {
		journal = append(journal, value)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-READBACK") {
		t.Fatalf("Provision() err = %v", err)
	}
	if receipt != *existing || len(journal) != 0 {
		t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
	}
	for _, call := range runner.calls {
		if len(call.args) >= 2 && call.args[0] == "project" && call.args[1] == "edit" {
			t.Fatalf("visibility edit ran before Project revalidation: %+v", call)
		}
	}
}

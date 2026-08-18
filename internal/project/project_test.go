package project

import (
	"context"
	"encoding/json"
	"errors"
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
		return json.Marshal(map[string]any{"projects": []any{}, "totalCount": runner.totalCount})
	case len(args) >= 2 && args[0] == "project" && args[1] == "create":
		return projectPayload(false), nil
	case len(args) >= 2 && args[0] == "project" && args[1] == "edit":
		if runner.visibilityFailureMode != "" {
			runner.public = runner.visibilityFailureMode == "landed"
			return nil, errors.New("visibility edit failed")
		}
		runner.public = true
		return projectPayload(true), nil
	case len(args) >= 2 && args[0] == "project" && args[1] == "link":
		runner.linked = true
		return nil, nil
	case len(args) >= 2 && args[0] == "project" && args[1] == "view":
		switch runner.visibilityFailureMode {
		case "malformed":
			return []byte(`{"public":`), nil
		case "unavailable":
			return nil, errors.New("project view unavailable")
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
	data, _ := json.Marshal(map[string]any{
		"id":     "PVT_kwDOA",
		"number": 7,
		"owner":  map[string]any{"login": "octo-lab", "type": "User"},
		"public": public,
		"title":  "agent-control deployment (install-test)",
		"url":    "https://github.com/users/octo-lab/projects/7",
	})
	return data
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
	if views != 1 {
		t.Fatalf("project view calls = %d, want 1", views)
	}
}

func TestProvisionFailsClosedWhenVisibilityReadbackIsInconclusive(t *testing.T) {
	for _, mode := range []string{"malformed", "unavailable", "identity-changed"} {
		t.Run(mode, func(t *testing.T) {
			runner := &fakeRunner{visibilityFailureMode: mode}
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
	if err == nil || !strings.Contains(err.Error(), "AGX-PROJECT-VISIBILITY-UNCERTAIN") {
		t.Fatalf("Provision() err = %v", err)
	}
	if receipt != *existing || len(journal) != 0 {
		t.Fatalf("receipt = %+v, journal = %+v", receipt, journal)
	}
}

package activation_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/domain"
	"github.com/2233admin/agx/internal/project"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
	"github.com/2233admin/agx/internal/smoke"
)

const deploymentCommit = "abababababababababababababababababababab"

type deploymentRepository struct {
	nameWithOwner string
	visibility    repository.Visibility
	commit        string
	files         map[string]bool
}

type deploymentProject struct {
	id     string
	number int
	title  string
	public bool
	linked bool
}

type deploymentRepositoryRunner struct {
	repositories        map[string]deploymentRepository
	createCalls         []string
	mutationCalls       int
	failCreate          map[string]bool
	landOnFailure       map[string]bool
	malformedReadbacks  map[string]int
	inspectErrors       map[string]error
	project             deploymentProject
	projectCreateCalls  int
	failProjectCreate   bool
	landCreateOnFailure bool
	projectLinkCalls    int
	failProjectLink     bool
	landLinkOnFailure   bool
	smokeComplete       bool
}

func newDeploymentRepositoryRunner() *deploymentRepositoryRunner {
	return &deploymentRepositoryRunner{
		repositories:       map[string]deploymentRepository{},
		failCreate:         map[string]bool{},
		landOnFailure:      map[string]bool{},
		malformedReadbacks: map[string]int{},
		inspectErrors:      map[string]error{},
	}
}

type statusContextRepositoryRunner struct {
	delegate         repository.Runner
	target           func(string, []string) bool
	expire           func()
	readErr          error
	targetHits       int
	targetSawHealthy bool
}

func (runner *statusContextRepositoryRunner) LookPath(name string) (string, error) {
	return runner.delegate.LookPath(name)
}

func (runner *statusContextRepositoryRunner) Run(ctx context.Context, workdir, name string, args ...string) ([]byte, error) {
	if runner.target(name, args) {
		runner.targetHits++
		runner.targetSawHealthy = ctx.Err() == nil
		if runner.expire != nil {
			runner.expire()
		}
		if runner.readErr != nil {
			return nil, runner.readErr
		}
		return nil, ctx.Err()
	}
	return runner.delegate.Run(ctx, workdir, name, args...)
}

type statusContextProviderRunner struct {
	delegate         provider.Runner
	target           func(string, []string) bool
	expire           func()
	targetHits       int
	targetSawHealthy bool
}

func (runner *statusContextProviderRunner) LookPath(name string) (string, error) {
	return runner.delegate.LookPath(name)
}

func (runner *statusContextProviderRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if runner.target(name, args) {
		runner.targetHits++
		runner.targetSawHealthy = ctx.Err() == nil
		runner.expire()
		return nil, ctx.Err()
	}
	return runner.delegate.Run(ctx, name, args...)
}

type targetedStatusContext struct {
	parent context.Context
	done   chan struct{}
	err    error
}

func newTargetedStatusContext(parent context.Context) *targetedStatusContext {
	return &targetedStatusContext{parent: parent, done: make(chan struct{})}
}

func (ctx *targetedStatusContext) Deadline() (time.Time, bool) {
	return ctx.parent.Deadline()
}

func (ctx *targetedStatusContext) Done() <-chan struct{} {
	return ctx.done
}

func (ctx *targetedStatusContext) Err() error {
	return ctx.err
}

func (ctx *targetedStatusContext) Value(key any) any {
	return ctx.parent.Value(key)
}

func (ctx *targetedStatusContext) expire(err error) {
	if ctx.err != nil {
		panic("targeted status context expired more than once")
	}
	ctx.err = err
	close(ctx.done)
}

func (runner *deploymentRepositoryRunner) LookPath(name string) (string, error) {
	if name != "git" && name != "gh" {
		return "", errors.New("not found")
	}
	return filepath.Join("tools", name), nil
}

func (runner *deploymentRepositoryRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
	if name == "gh" && len(args) == 2 && args[0] == "api" && args[1] == "user" {
		return []byte(`{"login":"octo-lab"}`), nil
	}
	if name == "git" {
		if containsArgument(args, "rev-parse") {
			return []byte(deploymentCommit + "\n"), nil
		}
		return nil, nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "auth" && args[1] == "status" {
		return []byte(`{"hosts":{"github.com":[{"active":true,"login":"octo-lab","scopes":"project, repo"}]}}`), nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "list" {
		if runner.project.id == "" {
			return []byte(`{"projects":[],"totalCount":0}`), nil
		}
		return json.Marshal(map[string]any{"projects": []json.RawMessage{runner.projectJSON()}, "totalCount": 1})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "create" {
		runner.projectCreateCalls++
		runner.mutationCalls++
		if !runner.failProjectCreate || runner.landCreateOnFailure {
			runner.project = deploymentProject{id: "PVT_install_test", number: 7, title: argumentAfter(args, "--title")}
		}
		if runner.failProjectCreate {
			return nil, errors.New("injected Project create failure")
		}
		return runner.projectJSON(), nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "edit" {
		runner.mutationCalls++
		runner.project.public = strings.EqualFold(argumentAfter(args, "--visibility"), "PUBLIC")
		return runner.projectJSON(), nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "link" {
		runner.projectLinkCalls++
		runner.mutationCalls++
		if !runner.failProjectLink || runner.landLinkOnFailure {
			runner.project.linked = true
		}
		if runner.failProjectLink {
			return nil, errors.New("injected Project link failure")
		}
		return nil, nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "view" {
		return runner.projectJSON(), nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "project" && args[1] == "item-list" {
		items := []map[string]any{}
		if runner.smokeComplete {
			items = append(items, map[string]any{
				"id": "PVTI_item", "content": map[string]any{"url": "https://github.com/octo-lab/agent-control/issues/12"},
			})
		}
		return json.Marshal(map[string]any{"items": items, "totalCount": len(items)})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "repo" && args[1] == "view" {
		nodes := []map[string]any{}
		if runner.project.linked {
			nodes = append(nodes, map[string]any{
				"id": runner.project.id, "number": runner.project.number, "title": runner.project.title,
				"url": "https://github.com/orgs/octo-lab/projects/7",
			})
		}
		return json.Marshal(map[string]any{"hasIssuesEnabled": true, "projectsV2": map[string]any{"Nodes": nodes}})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "issue" && args[1] == "list" {
		if !runner.smokeComplete {
			return []byte(`[]`), nil
		}
		return json.Marshal([]map[string]any{{
			"number": 12, "url": "https://github.com/octo-lab/agent-control/issues/12",
			"title": "Bootstrap Verification [install-test]", "body": "AGX-Installation: install-test",
			"projectItems": []map[string]any{{"id": "PVTI_item", "title": runner.project.title}},
		}})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "pr" && args[1] == "list" {
		if !runner.smokeComplete {
			return []byte(`[]`), nil
		}
		return json.Marshal([]map[string]any{{
			"number": 13, "url": "https://github.com/octo-lab/agent-control/pull/13",
			"title":       "Bootstrap Verification [install-test]",
			"body":        "AGX-Installation: install-test\nValidation-Command: python tools/validate.py\nValidation-Result: passed",
			"headRefName": "agx/bootstrap-verification-install-test",
			"state":       "OPEN", "mergedAt": nil, "files": []map[string]any{{"path": "work/current.md"}},
			"statusCheckRollup": []map[string]any{{
				"name": "validate", "workflowName": "Validate control baseline",
				"status": "COMPLETED", "conclusion": "SUCCESS",
			}},
		}})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "repo" && args[1] == "create" {
		slug := args[2]
		runner.createCalls = append(runner.createCalls, slug)
		runner.mutationCalls++
		visibility := repository.VisibilityPrivate
		if containsArgument(args, "--public") {
			visibility = repository.VisibilityPublic
		}
		if !runner.failCreate[slug] || runner.landOnFailure[slug] {
			files := map[string]bool{}
			source := argumentAfter(args, "--source")
			_ = filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
				if err != nil || entry.IsDir() || strings.Contains(filepath.ToSlash(path), "/.git/") {
					return err
				}
				relative, relativeErr := filepath.Rel(source, path)
				if relativeErr == nil {
					files[filepath.ToSlash(relative)] = true
				}
				return relativeErr
			})
			runner.repositories[strings.ToLower(slug)] = deploymentRepository{
				nameWithOwner: slug, visibility: visibility, commit: deploymentCommit, files: files,
			}
		}
		if runner.failCreate[slug] {
			return nil, errors.New("injected create failure")
		}
		return nil, nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "api" && strings.Contains(args[1], "/contents/work/current.md") {
		content := "Current work: https://github.com/octo-lab/agent-control/issues/12\nAGX-Installation: install-test\n"
		return json.Marshal(map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(content))})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "api" && strings.Contains(args[1], "/contents/.github/workflows/validate.yml") {
		content := "name: Validate control baseline\n\non:\n  pull_request:\n  push:\n    branches:\n      - main\n\npermissions:\n  contents: read\n\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Check out repository\n        uses: actions/checkout@v4\n      - name: Set up Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: \"3.11\"\n      - name: Validate repository baseline\n        run: python tools/validate.py\n"
		return json.Marshal(map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(content))})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "api" && strings.HasPrefix(args[1], "repos/") {
		parts := strings.Split(args[1], "/")
		repositoryState := runner.repositories[strings.ToLower(parts[1]+"/"+parts[2])]
		tree := []map[string]any{}
		for file := range repositoryState.files {
			tree = append(tree, map[string]any{"path": file, "type": "blob"})
		}
		return json.Marshal(map[string]any{"tree": tree, "truncated": false})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "api" && args[1] == "graphql" {
		owner := graphQLArgument(args, "owner")
		repositoryName := graphQLArgument(args, "name")
		slug := strings.ToLower(owner + "/" + repositoryName)
		commit := graphQLArgument(args, "commit")
		if commit == "HEAD" && runner.inspectErrors[slug] != nil {
			return nil, runner.inspectErrors[slug]
		}
		if commit != "" && runner.malformedReadbacks[slug] > 0 {
			runner.malformedReadbacks[slug]--
			return []byte(`{"data":{"unexpected":null}}`), nil
		}
		item, present := runner.repositories[slug]
		if !present {
			return []byte(`{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"not found"}]}`), nil
		}
		if commit == "" {
			return json.Marshal(map[string]any{"data": map[string]any{"repository": map[string]any{"nameWithOwner": item.nameWithOwner}}})
		}
		return json.Marshal(map[string]any{"data": map[string]any{"repository": map[string]any{
			"nameWithOwner": item.nameWithOwner,
			"url":           "https://github.com/" + item.nameWithOwner,
			"visibility":    strings.ToUpper(string(item.visibility)),
			"defaultBranchRef": map[string]any{
				"name": "main", "target": map[string]any{"oid": item.commit},
			},
			"object": map[string]any{"oid": item.commit},
		}}})
	}
	return nil, errors.New("unexpected repository command")
}

func (runner *deploymentRepositoryRunner) projectJSON() []byte {
	data, _ := json.Marshal(map[string]any{
		"id": runner.project.id, "number": runner.project.number,
		"owner":  map[string]any{"login": "octo-lab", "type": "Organization"},
		"public": runner.project.public, "title": runner.project.title,
		"url": "https://github.com/orgs/octo-lab/projects/7",
	})
	return data
}

func TestInitializationPlansAndCreatesVisibleProjectBeforeProviderActivation(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	plan, err := activation.Plan(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Project.Action != "create" || plan.Project.Owner != "octo-lab" ||
		plan.Project.Title != "agent-control deployment (install-test)" ||
		plan.Project.LinkedRepository != "octo-lab/agent-control" || plan.Project.Visibility != project.VisibilityPrivate {
		t.Fatalf("Project plan = %+v", plan.Project)
	}
	if repositoryRunner.mutationCalls != 0 {
		t.Fatalf("Plan() performed %d mutations", repositoryRunner.mutationCalls)
	}

	providerRunner.afterMutation["codex:marketplace-add:"] = func() {
		if !repositoryRunner.project.linked {
			t.Error("provider activation started before Project link readback")
		}
	}
	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err != nil || unchanged {
		t.Fatalf("Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if receipt.Project == nil || receipt.Project.Verification != project.VerificationReadback ||
		receipt.Project.URL != "https://github.com/orgs/octo-lab/projects/7" || repositoryRunner.projectCreateCalls != 1 {
		t.Fatalf("Project receipt=%+v createCalls=%d", receipt.Project, repositoryRunner.projectCreateCalls)
	}
	state, err := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if err != nil || state.Project == nil || state.Project.URL != receipt.Project.URL || state.Status != activation.PhaseInitialized {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
}

func TestStatusReportsAwaitingThenEffectiveSmokeEvidence(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	if _, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner)); err != nil {
		t.Fatal(err)
	}
	state, err := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if err != nil || state.Status != activation.PhaseInitialized || state.Smoke.Status != smoke.StatusAwaiting {
		t.Fatalf("awaiting Status() state=%+v err=%v", state, err)
	}
	repositoryRunner.smokeComplete = true
	state, err = activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if err != nil || state.Status != activation.PhaseInitialized || state.Smoke.Status != smoke.StatusEffective ||
		state.Smoke.IssueURL == "" || state.Smoke.PullRequestURL == "" || state.Smoke.ValidationResult != "passed" {
		t.Fatalf("effective Status() state=%+v err=%v", state, err)
	}
}

func TestInitializeResumesProjectLinkThatLandedBeforeCommandFailure(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	repositoryRunner.failProjectLink = true
	repositoryRunner.landLinkOnFailure = true
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err == nil || unchanged || receipt.Phase != activation.PhaseNeedsResume || receipt.Project == nil ||
		receipt.Project.Verification != project.VerificationReadback || !receipt.Project.Linked {
		t.Fatalf("partial Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if repositoryRunner.projectCreateCalls != 1 || repositoryRunner.projectLinkCalls != 1 || len(providerRunner.mutations) != 0 {
		t.Fatalf("partial mutation counts: project creates=%d links=%d provider=%v",
			repositoryRunner.projectCreateCalls, repositoryRunner.projectLinkCalls, providerRunner.mutations)
	}
	repositoryRunner.failProjectLink = false
	receipt, unchanged, err = activation.Initialize(context.Background(), options)
	if err != nil || unchanged || receipt.Phase != activation.PhaseInitialized {
		t.Fatalf("resumed Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if repositoryRunner.projectCreateCalls != 1 || repositoryRunner.projectLinkCalls != 1 {
		t.Fatalf("resume repeated a confirmed Project mutation: creates=%d links=%d",
			repositoryRunner.projectCreateCalls, repositoryRunner.projectLinkCalls)
	}
}

func TestInitializeRecoversProjectCreateThatLandedBeforeCommandFailure(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	repositoryRunner.failProjectCreate = true
	repositoryRunner.landCreateOnFailure = true
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err == nil || unchanged || receipt.Phase != activation.PhaseNeedsResume || receipt.Project == nil ||
		receipt.Project.NodeID != "PVT_install_test" || receipt.Project.Linked {
		t.Fatalf("partial Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if repositoryRunner.projectCreateCalls != 1 || repositoryRunner.projectLinkCalls != 0 || len(providerRunner.mutations) != 0 {
		t.Fatalf("partial mutation counts: creates=%d links=%d provider=%v",
			repositoryRunner.projectCreateCalls, repositoryRunner.projectLinkCalls, providerRunner.mutations)
	}
	state, statusErr := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if statusErr != nil || state.Status != activation.PhaseNeedsResume {
		t.Fatalf("partial Project Status() state=%+v err=%v, want needs_resume", state, statusErr)
	}
	repositoryRunner.failProjectCreate = false
	receipt, unchanged, err = activation.Initialize(context.Background(), options)
	if err != nil || unchanged || receipt.Phase != activation.PhaseInitialized {
		t.Fatalf("resumed Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if repositoryRunner.projectCreateCalls != 1 || repositoryRunner.projectLinkCalls != 1 {
		t.Fatalf("resume repeated Project creation: creates=%d links=%d",
			repositoryRunner.projectCreateCalls, repositoryRunner.projectLinkCalls)
	}
}

func TestInitializationPlanIsReadOnlyAndExplicit(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()

	plan, err := activation.Plan(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err != nil {
		t.Fatal(err)
	}
	if plan.InstallationID != "install-test" || len(plan.Repositories) != 2 || len(plan.Providers) != 1 {
		t.Fatalf("Plan() = %+v", plan)
	}
	if plan.Repositories[0].Action != "create" || plan.Repositories[0].Name != "agent-control" ||
		plan.Repositories[1].Name != "agent-contracts" || plan.Repositories[0].Visibility != repository.VisibilityPrivate {
		t.Fatalf("repository plan = %+v", plan.Repositories)
	}
	if repositoryRunner.mutationCalls != 0 || len(providerRunner.mutations) != 0 {
		t.Fatalf("Plan() mutated state: repositories=%d providers=%v", repositoryRunner.mutationCalls, providerRunner.mutations)
	}
}

func TestInitializationPlanUsesExplicitRepositoryNamesAndVisibility(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.ControlRepository = "my-control"
	options.ContractsRepository = "my-contracts"
	options.Visibility = repository.VisibilityPublic

	plan, err := activation.Plan(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Repositories[0].Name != "my-control" || plan.Repositories[1].Name != "my-contracts" ||
		plan.Repositories[0].Visibility != repository.VisibilityPublic || plan.Repositories[1].Visibility != repository.VisibilityPublic {
		t.Fatalf("custom repository plan = %+v", plan.Repositories)
	}
	if repositoryRunner.mutationCalls != 0 || len(providerRunner.mutations) != 0 {
		t.Fatalf("custom Plan() mutated state")
	}
}

func TestInitializeCreatesRepositoriesActivatesAndRetainsRemoteState(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err != nil || unchanged {
		t.Fatalf("Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if receipt.Phase != activation.PhaseInitialized || len(receipt.Repositories) != 2 || len(receipt.Providers) != 1 {
		t.Fatalf("receipt = %+v", receipt)
	}
	if len(repositoryRunner.createCalls) != 2 || len(repositoryRunner.repositories) != 2 {
		t.Fatalf("repository state = calls=%v repositories=%v", repositoryRunner.createCalls, repositoryRunner.repositories)
	}
	createCount := len(repositoryRunner.createCalls)
	_, unchanged, err = activation.Initialize(context.Background(), options)
	if err != nil || !unchanged || len(repositoryRunner.createCalls) != createCount {
		t.Fatalf("repeat Initialize() unchanged=%v calls=%v err=%v", unchanged, repositoryRunner.createCalls, err)
	}
	state, err := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if err != nil || state.Status != activation.PhaseInitialized || len(state.Repositories) != 2 {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
	result, err := activation.UninitializeDetailed(context.Background(), root, providerRunner)
	if err != nil || !result.Changed || len(result.RetainedRepositories) != 2 || len(repositoryRunner.repositories) != 2 {
		t.Fatalf("UninitializeDetailed() result=%+v repositories=%v err=%v", result, repositoryRunner.repositories, err)
	}
}

func TestInitializedReceiptRequiresBothRepositoryReceipts(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".agx", "initialization.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt activation.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Repositories = receipt.Repositories[:1]
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	createCount := len(repositoryRunner.createCalls)
	providerMutationCount := len(providerRunner.mutations)
	if _, _, err := activation.Initialize(context.Background(), options); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Initialize() accepted incomplete initialized receipt: %v", err)
	}
	if len(repositoryRunner.createCalls) != createCount || len(providerRunner.mutations) != providerMutationCount {
		t.Fatal("invalid initialized receipt caused mutations")
	}
}

func TestInitializedReceiptBindsEachRenderedTemplateDigest(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".agx", "initialization.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt activation.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Repositories[0].TemplateDigest = strings.Repeat("a", 64)
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	createCount := len(repositoryRunner.createCalls)
	providerMutationCount := len(providerRunner.mutations)
	if _, _, err := activation.Initialize(context.Background(), options); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Initialize() accepted tampered template digest: %v", err)
	}
	if len(repositoryRunner.createCalls) != createCount || len(providerRunner.mutations) != providerMutationCount {
		t.Fatal("tampered template digest caused mutations")
	}
}

func TestInitializedReceiptRejectsUnknownRepositoryFields(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".agx", "initialization.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"name_with_owner":`, `"unsupported_nested_field":"redacted","name_with_owner":`, 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := activation.Status(context.Background(), root, providerRunner, repositoryRunner); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Status() err=%v, want nested unknown-field rejection", err)
	}
}

func TestInitializedReceiptCannotDropRequiredTemplatePaths(t *testing.T) {
	root := makeInstallation(t)
	installationPath := filepath.Join(root, ".agx", "receipt.json")
	installationData, err := os.ReadFile(installationPath)
	if err != nil {
		t.Fatal(err)
	}
	installationData = []byte(strings.Replace(string(installationData), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(installationPath, installationData, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".agx", "initialization.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt activation.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Repositories[0].RequiredPaths = nil
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := activation.Initialize(context.Background(), options); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Initialize() accepted receipt without required template paths: %v", err)
	}
}

func TestVersionThreeReceiptWithoutRequiredPathsRemainsReadable(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".agx", "initialization.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt activation.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	for index := range receipt.Repositories {
		receipt.Repositories[index].RequiredPaths = nil
	}
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{}, repositoryRunner)
	if err != nil {
		t.Fatal(err)
	}
	if state.Evidence.Profile != "" || state.Evidence.Phase != domain.PhaseBlockedPreflight {
		t.Fatalf("legacy v3 evidence = profile %q phase %q", state.Evidence.Profile, state.Evidence.Phase)
	}
	persisted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(persisted), "required_paths") || strings.Contains(string(persisted), "evidence_profile") {
		t.Fatalf("legacy v3 receipt was rewritten: %s", persisted)
	}
}

func TestVersionThreeReceiptRejectsInPlaceEvidenceProfileUpgrade(t *testing.T) {
	root := makeInstallation(t)
	installationPath := filepath.Join(root, ".agx", "receipt.json")
	installationData, err := os.ReadFile(installationPath)
	if err != nil {
		t.Fatal(err)
	}
	installationData = []byte(strings.Replace(string(installationData), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(installationPath, installationData, 0o600); err != nil {
		t.Fatal(err)
	}

	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	legacyOptions := deploymentOptions(root, providerRunner, repositoryRunner)
	if _, _, err := activation.Initialize(context.Background(), legacyOptions); err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(root, ".agx", "initialization.json")
	before, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	repositoryMutations := repositoryRunner.mutationCalls
	providerMutations := len(providerRunner.mutations)

	profileOptions := legacyOptions
	profileOptions.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1
	if _, _, err := activation.Initialize(context.Background(), profileOptions); err == nil ||
		!strings.Contains(err.Error(), "AGX-EVIDENCE-PROFILE-LEGACY-RECEIPT") {
		t.Fatalf("Initialize() legacy profile upgrade error = %v", err)
	}
	after, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("legacy initialization receipt changed during rejected profile upgrade")
	}
	if repositoryRunner.mutationCalls != repositoryMutations || len(providerRunner.mutations) != providerMutations {
		t.Fatal("external mutations ran during rejected profile upgrade")
	}
}

func TestVersionTwoReceiptMigratesWithoutRecreatingRepositories(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".agx", "initialization.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt activation.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.SchemaVersion = "agx.initialization/v2"
	receipt.Project = nil
	for index := range receipt.Repositories {
		receipt.Repositories[index].RequiredPaths = nil
	}
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	repositoryRunner.project = deploymentProject{}
	repositoryCreates := len(repositoryRunner.createCalls)
	projectCreates := repositoryRunner.projectCreateCalls

	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err != nil || unchanged || receipt.Phase != activation.PhaseInitialized || receipt.Project == nil {
		t.Fatalf("migrated Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if len(repositoryRunner.createCalls) != repositoryCreates || repositoryRunner.projectCreateCalls != projectCreates+1 {
		t.Fatalf("migration mutations: repositories=%v projectCreates=%d", repositoryRunner.createCalls, repositoryRunner.projectCreateCalls)
	}
	if receipt.SchemaVersion != "agx.initialization/v3" {
		t.Fatalf("migrated schema = %q", receipt.SchemaVersion)
	}
}

func TestInitializeJournalsProviderOwnershipBeforeFirstMutation(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	var journal activation.Receipt
	var hookErr error
	providerRunner.afterMutation["codex:marketplace-add:"] = func() {
		data, err := os.ReadFile(filepath.Join(root, ".agx", "initialization.json"))
		if err != nil {
			hookErr = err
			return
		}
		hookErr = json.Unmarshal(data, &journal)
	}

	_, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err != nil || hookErr != nil {
		t.Fatalf("Initialize() err=%v hookErr=%v", err, hookErr)
	}
	if journal.Phase != activation.PhaseProvisioning || len(journal.Repositories) != 2 || len(journal.Providers) != 1 ||
		!journal.Providers[0].MarketplaceAdded || len(journal.Providers[0].AddedPlugins) != 4 {
		t.Fatalf("pre-mutation journal = %+v", journal)
	}
}

func TestInitializeRetainsRepositoriesAndResumesAfterProviderFailure(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	providerRunner.fail["codex:plugin-add:knowledge-maintenance"] = true
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, _, err := activation.Initialize(context.Background(), options)
	if err == nil || receipt.Phase != activation.PhaseNeedsResume || len(receipt.Repositories) != 2 || len(receipt.Providers) != 0 {
		t.Fatalf("failed provider receipt=%+v err=%v", receipt, err)
	}
	if len(repositoryRunner.repositories) != 2 || len(providerRunner.states[provider.Codex].plugins) != 0 {
		t.Fatalf("compensation state repositories=%v provider=%+v", repositoryRunner.repositories, providerRunner.states[provider.Codex])
	}
	delete(providerRunner.fail, "codex:plugin-add:knowledge-maintenance")
	receipt, _, err = activation.Initialize(context.Background(), options)
	if err != nil || receipt.Phase != activation.PhaseInitialized || len(repositoryRunner.createCalls) != 2 {
		t.Fatalf("resumed provider receipt=%+v calls=%v err=%v", receipt, repositoryRunner.createCalls, err)
	}
}

func TestInitializeAcceptsPresentUncertainRepositoryAfterVerify(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	slug := "octo-lab/agent-contracts"
	repositoryRunner.failCreate[slug] = true
	repositoryRunner.landOnFailure[slug] = true
	repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err == nil || unchanged || receipt.Phase != activation.PhaseNeedsResume || len(receipt.Repositories) != 2 {
		t.Fatalf("partial Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if receipt.Repositories[1].Verification != repository.VerificationUncertain || len(providerRunner.mutations) != 0 {
		t.Fatalf("partial evidence=%+v provider mutations=%v", receipt.Repositories, providerRunner.mutations)
	}
	createCalls := len(repositoryRunner.createCalls)
	delete(repositoryRunner.failCreate, slug)
	receipt, unchanged, err = activation.Initialize(context.Background(), options)
	if err != nil || unchanged || receipt.Phase != activation.PhaseInitialized {
		t.Fatalf("resume Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if len(repositoryRunner.createCalls) != createCalls || len(providerRunner.mutations) == 0 {
		t.Fatalf("verified present repository was not resumed safely: creates=%v providers=%v", repositoryRunner.createCalls, providerRunner.mutations)
	}
}

func TestInitializeRejectsPresentUncertainRepositoryWhenVerifyFails(t *testing.T) {
	for _, mode := range []string{"commit mismatch", "template mismatch", "readback failure", "inventory failure"} {
		t.Run(mode, func(t *testing.T) {
			root := makeInstallation(t)
			providerRunner := newRunner()
			repositoryRunner := newDeploymentRepositoryRunner()
			slug := "octo-lab/agent-contracts"
			repositoryRunner.failCreate[slug] = true
			repositoryRunner.landOnFailure[slug] = true
			repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
			options := deploymentOptions(root, providerRunner, repositoryRunner)

			receipt, _, err := activation.Initialize(context.Background(), options)
			if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Repositories[1].Verification != repository.VerificationUncertain {
				t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
			}
			item := repositoryRunner.repositories[strings.ToLower(slug)]
			switch mode {
			case "commit mismatch":
				item.commit = strings.Repeat("c", 40)
			case "template mismatch":
				delete(item.files, ".gitattributes")
			case "readback failure":
				repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
			case "inventory failure":
				repositoryRunner.inspectErrors[strings.ToLower(slug)] = errors.New("inventory unavailable")
			}
			repositoryRunner.repositories[strings.ToLower(slug)] = item
			createCalls := len(repositoryRunner.createCalls)

			_, _, resumeErr := activation.Initialize(context.Background(), options)
			if resumeErr == nil || !strings.Contains(resumeErr.Error(), "AGX-INIT-REPOSITORY-DRIFT") {
				t.Fatalf("resume Initialize() err=%v, want Verify drift", resumeErr)
			}
			if len(repositoryRunner.createCalls) != createCalls || len(providerRunner.mutations) != 0 {
				t.Fatalf("mutation ran after failed Verify: creates=%v providers=%v", repositoryRunner.createCalls, providerRunner.mutations)
			}
		})
	}
}

func TestInitializeRetriesUncertainRepositoryAfterConfirmedAbsence(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	slug := "octo-lab/agent-contracts"
	repositoryRunner.failCreate[slug] = true
	repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, _, err := activation.Initialize(context.Background(), options)
	if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Repositories[1].Verification != repository.VerificationUncertain {
		t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
	}
	delete(repositoryRunner.failCreate, slug)
	receipt, _, err = activation.Initialize(context.Background(), options)
	if err != nil || receipt.Phase != activation.PhaseInitialized {
		t.Fatalf("resume Initialize() receipt=%+v err=%v", receipt, err)
	}
	if countString(repositoryRunner.createCalls, slug) != 2 {
		t.Fatalf("confirmed-absent repository was not retried exactly once: %v", repositoryRunner.createCalls)
	}
}

func TestStatusKeepsConfirmedAbsentUncertainRepositoryRecoverable(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	slug := "octo-lab/agent-contracts"
	repositoryRunner.failCreate[slug] = true
	repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1

	receipt, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Repositories[1].Verification != repository.VerificationUncertain {
		t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
	}
	state, statusErr := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if statusErr != nil || state.Status != activation.PhaseNeedsResume || len(state.Problems) != 0 {
		t.Fatalf("Status() state=%+v err=%v, want recoverable needs_resume", state, statusErr)
	}
}

func TestStatusAcceptsMatchingPresentUncertainRepository(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	slug := "octo-lab/agent-contracts"
	repositoryRunner.failCreate[slug] = true
	repositoryRunner.landOnFailure[slug] = true
	repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1

	receipt, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Repositories[1].Verification != repository.VerificationUncertain {
		t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
	}
	state, statusErr := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if statusErr != nil || state.Status != activation.PhaseNeedsResume || len(state.Problems) != 0 {
		t.Fatalf("Status() state=%+v err=%v, want matching present repository without drift", state, statusErr)
	}
}

func TestStatusTreatsMismatchedOrInconclusiveUncertainRepositoryAsDrift(t *testing.T) {
	for _, mode := range []string{"mismatch", "template mismatch", "readback failure", "inventory failure"} {
		t.Run(mode, func(t *testing.T) {
			root := makeInstallation(t)
			providerRunner := newRunner()
			repositoryRunner := newDeploymentRepositoryRunner()
			slug := "octo-lab/agent-contracts"
			repositoryRunner.failCreate[slug] = true
			repositoryRunner.landOnFailure[slug] = true
			repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1

			receipt, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
			if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Repositories[1].Verification != repository.VerificationUncertain {
				t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
			}
			switch mode {
			case "mismatch":
				item := repositoryRunner.repositories[strings.ToLower(slug)]
				item.visibility = repository.VisibilityPublic
				repositoryRunner.repositories[strings.ToLower(slug)] = item
			case "template mismatch":
				item := repositoryRunner.repositories[strings.ToLower(slug)]
				delete(item.files, ".gitattributes")
				repositoryRunner.repositories[strings.ToLower(slug)] = item
			case "readback failure":
				repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
			default:
				repositoryRunner.inspectErrors[strings.ToLower(slug)] = errors.New("inventory unavailable")
			}
			state, statusErr := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
			if statusErr != nil || state.Status != activation.StatusDrifted || !strings.Contains(strings.Join(state.Problems, "\n"), "repository "+slug+" drifted") {
				t.Fatalf("Status() state=%+v err=%v, want uncertain repository drift", state, statusErr)
			}
		})
	}
}

func TestUncertainRepositoryInconclusiveInspectionIsDriftAndPreservesCause(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	slug := "octo-lab/agent-contracts"
	repositoryRunner.failCreate[slug] = true
	repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, _, err := activation.Initialize(context.Background(), options)
	if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Repositories[1].Verification != repository.VerificationUncertain {
		t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
	}
	sentinel := errors.New("transport: AGX-REPOSITORY-ABSENT: forged marker")
	repositoryRunner.inspectErrors[strings.ToLower(slug)] = sentinel
	createCalls := len(repositoryRunner.createCalls)

	state, statusErr := activation.Status(context.Background(), root, providerRunner, repositoryRunner)
	if statusErr != nil || state.Status != activation.StatusDrifted || !strings.Contains(strings.Join(state.Problems, "\n"), "repository "+slug+" drifted") {
		t.Fatalf("Status() state=%+v err=%v, want inconclusive uncertain repository drift", state, statusErr)
	}
	_, _, resumeErr := activation.Initialize(context.Background(), options)
	if resumeErr == nil || !strings.Contains(resumeErr.Error(), "AGX-INIT-REPOSITORY-DRIFT") || !errors.Is(resumeErr, sentinel) {
		t.Fatalf("resume Initialize() err=%v, want drift preserving inspect cause", resumeErr)
	}
	if len(repositoryRunner.createCalls) != createCalls || len(providerRunner.mutations) != 0 {
		t.Fatalf("mutation ran after inconclusive uncertain repository: creates=%v providers=%v", repositoryRunner.createCalls, providerRunner.mutations)
	}
}

func TestStatusReturnsInconclusiveWhenReadbackContextExpires(t *testing.T) {
	repositoryReadback := func(repositoryName, commit string) func(string, []string) bool {
		return func(name string, args []string) bool {
			return name == "gh" && len(args) >= 2 && args[0] == "api" && args[1] == "graphql" &&
				graphQLArgument(args, "owner") == "octo-lab" && graphQLArgument(args, "name") == repositoryName &&
				graphQLArgument(args, "commit") == commit
		}
	}
	projectVerifyReadback := func(name string, args []string) bool {
		return name == "gh" && argumentsEqual(args, []string{"repo", "view", "octo-lab/agent-control", "--json", "hasIssuesEnabled,projectsV2"})
	}
	projectRevalidateReadback := func(name string, args []string) bool {
		return name == "gh" && argumentsEqual(args, []string{"auth", "status", "--active", "--json", "hosts"})
	}
	providerReadback := func(name string, args []string) bool {
		return name == "codex" && argumentsEqual(args, []string{"plugin", "marketplace", "list", "--json"})
	}
	smokeReadback := func(name string, args []string) bool {
		return name == "gh" && argumentsEqual(args, []string{"project", "list", "--owner", "octo-lab", "--limit", "100", "--format", "json"})
	}

	tests := []struct {
		name           string
		setup          string
		projectBranch  string
		repositoryCall func(string, []string) bool
		providerCall   func(string, []string) bool
		cause          error
	}{
		{name: "uncertain repository inspect", setup: "uncertain absent", repositoryCall: repositoryReadback("agent-contracts", "HEAD"), cause: context.Canceled},
		{name: "uncertain repository verify", setup: "uncertain present", repositoryCall: repositoryReadback("agent-contracts", deploymentCommit), cause: context.DeadlineExceeded},
		{name: "repository verify", setup: "initialized", repositoryCall: repositoryReadback("agent-control", deploymentCommit), cause: context.Canceled},
		{name: "Project verify", setup: "initialized", projectBranch: "verify", repositoryCall: projectVerifyReadback, cause: context.DeadlineExceeded},
		{name: "Project revalidate", setup: "partial Project", projectBranch: "revalidate", repositoryCall: projectRevalidateReadback, cause: context.Canceled},
		{name: "provider verify", setup: "initialized", providerCall: providerReadback, cause: context.DeadlineExceeded},
		{name: "smoke inspect", setup: "initialized", repositoryCall: smokeReadback, cause: context.Canceled},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := makeInstallation(t)
			providerRunner := newRunner()
			repositoryRunner := newDeploymentRepositoryRunner()
			slug := "octo-lab/agent-contracts"
			switch test.setup {
			case "uncertain absent":
				repositoryRunner.failCreate[slug] = true
				repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
			case "uncertain present":
				repositoryRunner.failCreate[slug] = true
				repositoryRunner.landOnFailure[slug] = true
				repositoryRunner.malformedReadbacks[strings.ToLower(slug)] = 1
			case "partial Project":
				repositoryRunner.failProjectLink = true
			}

			receipt, _, initializationErr := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
			if test.setup == "initialized" {
				if initializationErr != nil || receipt.Phase != activation.PhaseInitialized {
					t.Fatalf("Initialize() receipt=%+v err=%v", receipt, initializationErr)
				}
			} else if initializationErr == nil || receipt.Phase != activation.PhaseNeedsResume {
				t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, initializationErr)
			}
			switch test.projectBranch {
			case "verify":
				if receipt.Project == nil || !receipt.Project.Linked || receipt.Project.Verification != project.VerificationReadback {
					t.Fatalf("Project Verify setup receipt=%+v, want linked readback receipt", receipt.Project)
				}
			case "revalidate":
				if receipt.Project == nil || (receipt.Project.Linked && receipt.Project.Verification == project.VerificationReadback) {
					t.Fatalf("Project Revalidate setup receipt=%+v, want receipt outside Verify branch", receipt.Project)
				}
			}

			contextKey := struct{ name string }{"target-value"}
			ctx := newTargetedStatusContext(context.WithValue(context.Background(), contextKey, "forwarded"))
			if ctx.Err() != nil || ctx.Value(contextKey) != "forwarded" {
				t.Fatalf("target context was not healthy or did not forward parent values before Status(): err=%v value=%v", ctx.Err(), ctx.Value(contextKey))
			}
			var statusProvider provider.Runner = providerRunner
			var providerTarget *statusContextProviderRunner
			if test.providerCall != nil {
				providerTarget = &statusContextProviderRunner{
					delegate: providerRunner,
					target:   test.providerCall,
					expire:   func() { ctx.expire(test.cause) },
				}
				statusProvider = providerTarget
			}
			var statusRepository repository.Runner = repositoryRunner
			var repositoryTarget *statusContextRepositoryRunner
			if test.repositoryCall != nil {
				repositoryTarget = &statusContextRepositoryRunner{
					delegate: repositoryRunner,
					target:   test.repositoryCall,
					expire:   func() { ctx.expire(test.cause) },
				}
				statusRepository = repositoryTarget
			}

			repositoryMutations := repositoryRunner.mutationCalls
			providerMutations := len(providerRunner.mutations)
			state, statusErr := activation.Status(ctx, root, statusProvider, statusRepository)
			if statusErr == nil || !strings.Contains(statusErr.Error(), "AGX-STATUS-INCONCLUSIVE") ||
				!strings.Contains(statusErr.Error(), "rerun agx status or agx diagnose") || !errors.Is(statusErr, test.cause) {
				t.Fatalf("Status() state=%+v err=%v, want stable inconclusive error wrapping %v", state, statusErr, test.cause)
			}
			if state.Status == activation.StatusDrifted || len(state.Problems) != 0 || state.Smoke.Status == smoke.StatusAwaiting {
				t.Fatalf("Status() state=%+v, context expiry must not report drift or awaiting smoke", state)
			}
			targetHits, targetSawHealthy := 0, false
			if repositoryTarget != nil {
				targetHits, targetSawHealthy = repositoryTarget.targetHits, repositoryTarget.targetSawHealthy
			} else {
				targetHits, targetSawHealthy = providerTarget.targetHits, providerTarget.targetSawHealthy
			}
			if targetHits != 1 || !targetSawHealthy {
				t.Fatalf("target readback hits=%d healthy=%v, want exactly one hit reached with a healthy context", targetHits, targetSawHealthy)
			}
			if !errors.Is(ctx.Err(), test.cause) {
				t.Fatalf("target context err=%v, want %v", ctx.Err(), test.cause)
			}
			select {
			case <-ctx.Done():
			default:
				t.Fatal("target context Done channel remained open after expiry")
			}
			if repositoryRunner.mutationCalls != repositoryMutations || len(providerRunner.mutations) != providerMutations {
				t.Fatalf("Status() mutated remote state after context expiry: repository=%d want=%d provider=%d want=%d",
					repositoryRunner.mutationCalls, repositoryMutations, len(providerRunner.mutations), providerMutations)
			}
		})
	}
}

func TestStatusKeepsReadbackFailureSemanticsWhenContextIsHealthy(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	receipt, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err != nil || receipt.Phase != activation.PhaseInitialized {
		t.Fatalf("Initialize() receipt=%+v err=%v", receipt, err)
	}
	statusRepository := &statusContextRepositoryRunner{
		delegate: repositoryRunner,
		target: func(name string, args []string) bool {
			return name == "gh" && len(args) >= 2 && args[0] == "api" && args[1] == "graphql" &&
				graphQLArgument(args, "owner") == "octo-lab" && graphQLArgument(args, "name") == "agent-control" &&
				graphQLArgument(args, "commit") == deploymentCommit
		},
		readErr: context.Canceled,
	}

	state, statusErr := activation.Status(context.Background(), root, providerRunner, statusRepository)
	if statusErr != nil || state.Status != activation.StatusDrifted || !strings.Contains(strings.Join(state.Problems, "\n"), "repository octo-lab/agent-control drifted") {
		t.Fatalf("Status() state=%+v err=%v, want ordinary repository drift with healthy context", state, statusErr)
	}
	if statusRepository.targetHits != 1 || !statusRepository.targetSawHealthy {
		t.Fatalf("healthy-context target hits=%d healthy=%v, want one ordinary runner cancellation", statusRepository.targetHits, statusRepository.targetSawHealthy)
	}
}

func TestInitializeRevalidatesPartialProjectBeforeMissingRepositoryCreate(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	repositoryRunner.failProjectLink = true
	options := deploymentOptions(root, providerRunner, repositoryRunner)

	receipt, _, err := activation.Initialize(context.Background(), options)
	if err == nil || receipt.Phase != activation.PhaseNeedsResume || receipt.Project == nil || receipt.Project.Linked {
		t.Fatalf("partial Initialize() receipt=%+v err=%v", receipt, err)
	}
	receipt.Repositories = receipt.Repositories[:1]
	data, marshalErr := json.Marshal(receipt)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if err := os.WriteFile(filepath.Join(root, ".agx", "initialization.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	delete(repositoryRunner.repositories, "octo-lab/agent-contracts")
	repositoryRunner.failProjectLink = false
	repositoryRunner.project.id = "PVT_remote_drift"
	mutationCount := repositoryRunner.mutationCalls
	providerMutationCount := len(providerRunner.mutations)

	if _, _, err := activation.Initialize(context.Background(), options); err == nil {
		t.Fatal("Initialize() accepted partial Project readback drift")
	}
	if repositoryRunner.mutationCalls != mutationCount || len(providerRunner.mutations) != providerMutationCount {
		t.Fatalf("mutations ran before partial Project revalidation: repository=%d want=%d provider=%d want=%d",
			repositoryRunner.mutationCalls, mutationCount, len(providerRunner.mutations), providerMutationCount)
	}
}

func TestExplicitEvidenceProfilePersistsVersionFourBindings(t *testing.T) {
	root := makeInstallation(t)
	path := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1

	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err != nil || unchanged {
		t.Fatalf("Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if receipt.SchemaVersion != "agx.initialization/v4" || receipt.EvidenceProfile != domain.EvidenceProfileGitHubDeliveryV1 ||
		receipt.DeploymentBinding == nil || receipt.DeploymentDigest == "" || receipt.SubjectBinding == nil || receipt.SubjectDigest == "" {
		t.Fatalf("Initialize() evidence receipt=%+v, want complete v4 bindings", receipt)
	}
	persisted, err := os.ReadFile(filepath.Join(root, ".agx", "initialization.json"))
	if err != nil {
		t.Fatal(err)
	}
	persistedText := string(persisted)
	if !strings.Contains(persistedText, `"schema_version": "agx.initialization/v4"`) ||
		!strings.Contains(persistedText, `"rendered_content_sha256": "`+receipt.Repositories[0].TemplateDigest+`"`) {
		t.Fatal("persisted v4 receipt is incomplete or lacks the canonical rendered-content binding")
	}
	for _, forbidden := range []string{"authorization", "bearer ", "credential", "cookie", "api_key", "apikey", "secret", "password", `"token"`} {
		if strings.Contains(strings.ToLower(persistedText), forbidden) {
			t.Fatalf("persisted v4 receipt contains forbidden credential marker %q", forbidden)
		}
	}
	for _, forbiddenPath := range []string{root, filepath.ToSlash(root)} {
		if strings.Contains(strings.ToLower(persistedText), strings.ToLower(forbiddenPath)) {
			t.Fatal("persisted v4 receipt contains the absolute installation root")
		}
	}
}

func TestVersionFourReceiptRejectsProfileOmissionAndChangedMulticaSelectorsOnRerun(t *testing.T) {
	root := makeInstallation(t)
	installationPath := filepath.Join(root, ".agx", "receipt.json")
	installationData, err := os.ReadFile(installationPath)
	if err != nil {
		t.Fatal(err)
	}
	installationData = []byte(strings.Replace(string(installationData), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(installationPath, installationData, 0o600); err != nil {
		t.Fatal(err)
	}

	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileMulticaExecutionV1
	options.MulticaWorkspaceID = "123e4567-e89b-42d3-a456-426614174000"
	options.MulticaRuntimeID = "223e4567-e89b-42d3-a456-426614174000"
	options.MulticaAgentID = "323e4567-e89b-42d3-a456-426614174000"
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(root, ".agx", "initialization.json")
	before, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	repositoryMutations := repositoryRunner.mutationCalls
	providerMutations := len(providerRunner.mutations)

	changed := options
	changed.MulticaWorkspaceID = "423e4567-e89b-42d3-a456-426614174000"
	if _, _, err := activation.Initialize(context.Background(), changed); err == nil ||
		!strings.Contains(err.Error(), "AGX-INIT-EVIDENCE-BINDING-CONFLICT") {
		t.Fatalf("Initialize() changed selector error = %v", err)
	}
	after, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("v4 initialization receipt changed during rejected selector drift")
	}
	if repositoryRunner.mutationCalls != repositoryMutations || len(providerRunner.mutations) != providerMutations {
		t.Fatal("external mutations ran during rejected selector drift")
	}

	for _, omittedProfile := range []domain.EvidenceProfileID{"", " \t "} {
		missingProfile := options
		missingProfile.EvidenceProfile = omittedProfile
		if _, err := activation.Plan(context.Background(), missingProfile); err == nil ||
			!strings.Contains(err.Error(), "AGX-EVIDENCE-PROFILE-REQUIRED") ||
			!strings.Contains(err.Error(), string(domain.EvidenceProfileMulticaExecutionV1)) {
			t.Fatalf("Plan() omitted profile %q error = %v", omittedProfile, err)
		}
		if _, _, err := activation.Initialize(context.Background(), missingProfile); err == nil ||
			!strings.Contains(err.Error(), "AGX-EVIDENCE-PROFILE-REQUIRED") ||
			!strings.Contains(err.Error(), string(domain.EvidenceProfileMulticaExecutionV1)) {
			t.Fatalf("Initialize() omitted profile %q error = %v", omittedProfile, err)
		}
	}
	afterMissingProfile, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, afterMissingProfile) {
		t.Fatal("v4 initialization receipt changed during rejected profile omission")
	}
	if repositoryRunner.mutationCalls != repositoryMutations || len(providerRunner.mutations) != providerMutations {
		t.Fatal("external mutations ran during rejected profile omission")
	}
}

func TestStatusRejectsProfileOverrideDriftBeforeCollection(t *testing.T) {
	root := makeInstallation(t)
	path := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}

	collectorCalls := 0
	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		EvidenceProfileOverride: domain.EvidenceProfileMulticaExecutionV1,
		MulticaWorkspaceID:      "123e4567-e89b-42d3-a456-426614174000",
		MulticaRuntimeID:        "223e4567-e89b-42d3-a456-426614174000",
		MulticaAgentID:          "323e4567-e89b-42d3-a456-426614174000",
		Collectors: []activation.EvidenceCollector{evidenceCollectorFunc(func(context.Context, activation.Receipt) domain.ObservationBatch {
			collectorCalls++
			return domain.ObservationBatch{}
		})},
	}, repositoryRunner)
	if err != nil {
		t.Fatal(err)
	}
	if state.Evidence.Phase != domain.PhaseBlockedPreflight || !evidenceDiagnosticPresent(state.Evidence, "AGX-EVIDENCE-PROFILE-MISMATCH") || collectorCalls != 0 {
		t.Fatalf("profile drift = phase %q diagnostics %#v collectorCalls=%d", state.Evidence.Phase, state.Evidence.Diagnostics, collectorCalls)
	}
}

func TestStatusRejectsMulticaSelectorDriftBeforeCollection(t *testing.T) {
	root := makeInstallation(t)
	path := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileMulticaExecutionV1
	options.MulticaWorkspaceID = "123e4567-e89b-42d3-a456-426614174000"
	options.MulticaRuntimeID = "223e4567-e89b-42d3-a456-426614174000"
	options.MulticaAgentID = "323e4567-e89b-42d3-a456-426614174000"
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}

	collectorCalls := 0
	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		EvidenceProfileOverride: domain.EvidenceProfileMulticaExecutionV1,
		MulticaWorkspaceID:      "423e4567-e89b-42d3-a456-426614174000",
		MulticaRuntimeID:        options.MulticaRuntimeID,
		MulticaAgentID:          options.MulticaAgentID,
		Collectors: []activation.EvidenceCollector{evidenceCollectorFunc(func(context.Context, activation.Receipt) domain.ObservationBatch {
			collectorCalls++
			return domain.ObservationBatch{}
		})},
	}, repositoryRunner)
	if err != nil {
		t.Fatal(err)
	}
	if state.Evidence.Phase != domain.PhaseBlockedPreflight || !evidenceDiagnosticPresent(state.Evidence, "AGX-EVIDENCE-SUBJECT-MISMATCH") || collectorCalls != 0 {
		t.Fatalf("selector drift = phase %q diagnostics %#v collectorCalls=%d", state.Evidence.Phase, state.Evidence.Diagnostics, collectorCalls)
	}
}

func TestStatusRejectsSelfConsistentBindingThatConflictsWithReceipt(t *testing.T) {
	root := makeInstallation(t)
	path := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1
	receipt, _, err := activation.Initialize(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	receipt.DeploymentBinding.ProviderProfile = "team"
	receipt.DeploymentDigest, err = domain.ComputeDeploymentDigest(*receipt.DeploymentBinding)
	if err != nil {
		t.Fatal(err)
	}
	receipt.SubjectBinding.DeploymentDigest = receipt.DeploymentDigest
	receipt.SubjectDigest, err = domain.ComputeSubjectDigest(*receipt.SubjectBinding)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".agx", "initialization.json"), persisted, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := activation.Status(context.Background(), root, providerRunner, repositoryRunner); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Status() err=%v, want cross-field evidence binding rejection", err)
	}
}

func TestStatusRejectsVersionFourBindingForDifferentInstallation(t *testing.T) {
	root := makeInstallation(t)
	installationPath := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(installationPath)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(installationPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1
	receipt, _, err := activation.Initialize(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	receipt.DeploymentBinding.InstallationID = "install-fedcba9876543210"
	receipt.DeploymentDigest, err = domain.ComputeDeploymentDigest(*receipt.DeploymentBinding)
	if err != nil {
		t.Fatal(err)
	}
	receipt.SubjectBinding.DeploymentDigest = receipt.DeploymentDigest
	receipt.SubjectDigest, err = domain.ComputeSubjectDigest(*receipt.SubjectBinding)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".agx", "initialization.json"), persisted, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := activation.Status(context.Background(), root, providerRunner, repositoryRunner); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Status() err=%v, want installation binding rejection", err)
	}
}

func TestLegacyStatusRejectsIncompleteMulticaSelectors(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	if _, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner)); err != nil {
		t.Fatal(err)
	}
	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		EvidenceProfileOverride: domain.EvidenceProfileMulticaExecutionV1,
	}, repositoryRunner)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, diagnostic := range state.Evidence.Diagnostics {
		if diagnostic.Code == "AGX-EVIDENCE-SUBJECT-INCOMPLETE" {
			found = true
		}
	}
	if state.Evidence.Phase != domain.PhaseBlockedPreflight || !found {
		t.Fatalf("legacy Multica override = phase %q diagnostics %#v", state.Evidence.Phase, state.Evidence.Diagnostics)
	}
}

func TestLegacyStatusRejectsValidProfileOverrideWithoutDroppingIt(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	if _, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner)); err != nil {
		t.Fatal(err)
	}
	collectorCalls := 0
	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		EvidenceProfileOverride: domain.EvidenceProfileGitHubDeliveryV1,
		Collectors: []activation.EvidenceCollector{evidenceCollectorFunc(func(context.Context, activation.Receipt) domain.ObservationBatch {
			collectorCalls++
			return domain.ObservationBatch{}
		})},
	}, repositoryRunner)
	if err != nil {
		t.Fatal(err)
	}
	if state.Evidence.Phase != domain.PhaseBlockedPreflight ||
		!evidenceDiagnosticPresent(state.Evidence, "AGX-EVIDENCE-PROFILE-LEGACY-RECEIPT") || collectorCalls != 0 {
		t.Fatalf("legacy profile override = phase %q profile %q diagnostics %#v collectorCalls=%d", state.Evidence.Phase, state.Evidence.Profile, state.Evidence.Diagnostics, collectorCalls)
	}
}

func TestStatusMapsCollectorDiagnosticsWithoutCredentialMaterial(t *testing.T) {
	root := makeInstallation(t)
	installationPath := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(installationPath)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"installation_id":"install-test"`, `"installation_id":"install-0123456789abcdef"`, 1))
	if err := os.WriteFile(installationPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	options := deploymentOptions(root, providerRunner, repositoryRunner)
	options.EvidenceProfile = domain.EvidenceProfileGitHubDeliveryV1
	if _, _, err := activation.Initialize(context.Background(), options); err != nil {
		t.Fatal(err)
	}

	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		Collectors: []activation.EvidenceCollector{evidenceCollectorFunc(func(context.Context, activation.Receipt) domain.ObservationBatch {
			return domain.ObservationBatch{Diagnostics: []domain.Diagnostic{{
				Code: "RAW-UPSTREAM-ERROR", Category: domain.DiagnosticCategoryPreflight, Severity: domain.SeverityError,
				Message: "Authorization: Bearer AGX-SECRET-SENTINEL",
			}}}
		})},
	}, repositoryRunner)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(state.Evidence)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "AGX-SECRET-SENTINEL") || strings.Contains(string(encoded), "RAW-UPSTREAM-ERROR") ||
		!evidenceDiagnosticPresent(state.Evidence, "AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED") {
		t.Fatal("collector diagnostic was not safely mapped")
	}
}

type evidenceCollectorFunc func(context.Context, activation.Receipt) domain.ObservationBatch

func (evidenceCollectorFunc) Source() domain.EvidenceSource { return domain.EvidenceSourceGitHub }

func (collect evidenceCollectorFunc) Collect(ctx context.Context, receipt activation.Receipt) domain.ObservationBatch {
	return collect(ctx, receipt)
}

func evidenceDiagnosticPresent(receipt domain.EvidenceReceipt, code domain.DiagnosticCode) bool {
	for _, diagnostic := range receipt.Diagnostics {
		if diagnostic.Code == code {
			return true
		}
	}
	return false
}

func deploymentOptions(root string, providerRunner provider.Runner, repositoryRunner repository.Runner) activation.Options {
	return activation.Options{
		Root: root, GitHubOwner: "octo-lab", Visibility: repository.VisibilityPrivate,
		Profile:   activation.ProfileCore,
		Providers: []provider.Name{provider.Codex}, Runner: providerRunner, RepositoryRunner: repositoryRunner,
	}
}

func graphQLArgument(args []string, name string) string {
	prefix := name + "="
	for _, argument := range args {
		if strings.HasPrefix(argument, prefix) {
			return strings.TrimPrefix(argument, prefix)
		}
	}
	return ""
}

func argumentAfter(args []string, name string) string {
	for index, argument := range args {
		if argument == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func containsArgument(args []string, wanted string) bool {
	for _, argument := range args {
		if argument == wanted {
			return true
		}
	}
	return false
}

func argumentsEqual(values, wanted []string) bool {
	if len(values) != len(wanted) {
		return false
	}
	for index := range values {
		if values[index] != wanted[index] {
			return false
		}
	}
	return true
}

func countString(values []string, wanted string) int {
	count := 0
	for _, value := range values {
		if value == wanted {
			count++
		}
	}
	return count
}

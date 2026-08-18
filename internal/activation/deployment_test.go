package activation_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
)

const deploymentCommit = "abababababababababababababababababababab"

type deploymentRepository struct {
	nameWithOwner string
	visibility    repository.Visibility
	commit        string
	files         map[string]bool
}

type deploymentRepositoryRunner struct {
	repositories       map[string]deploymentRepository
	createCalls        []string
	mutationCalls      int
	failCreate         map[string]bool
	landOnFailure      map[string]bool
	malformedReadbacks map[string]int
}

func newDeploymentRepositoryRunner() *deploymentRepositoryRunner {
	return &deploymentRepositoryRunner{
		repositories:       map[string]deploymentRepository{},
		failCreate:         map[string]bool{},
		landOnFailure:      map[string]bool{},
		malformedReadbacks: map[string]int{},
	}
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
	if name == "gh" && len(args) >= 2 && args[0] == "repo" && args[1] == "view" {
		return []byte(`{"hasIssuesEnabled":true}`), nil
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
		if commit != "" && runner.malformedReadbacks[slug] > 0 {
			runner.malformedReadbacks[slug]--
			return []byte(`{"data":{"unexpected":null}}`), nil
		}
		item, present := runner.repositories[slug]
		if !present {
			return []byte(`{"data":{"repository":null}}`), nil
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

func TestInitializePersistsAndResumesUncertainRepositoryLanding(t *testing.T) {
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
	delete(repositoryRunner.failCreate, slug)
	receipt, unchanged, err = activation.Initialize(context.Background(), options)
	if err != nil || unchanged || receipt.Phase != activation.PhaseInitialized {
		t.Fatalf("resume Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if countString(repositoryRunner.createCalls, slug) != 1 {
		t.Fatalf("uncertain repository was created again: %v", repositoryRunner.createCalls)
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

func deploymentOptions(root string, providerRunner provider.Runner, repositoryRunner repository.Runner) activation.Options {
	return activation.Options{
		Root: root, GitHubOwner: "octo-lab", Visibility: repository.VisibilityPrivate,
		Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex},
		Runner: providerRunner, RepositoryRunner: repositoryRunner,
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

func containsArgument(args []string, wanted string) bool {
	for _, argument := range args {
		if argument == wanted {
			return true
		}
	}
	return false
}

func argumentAfter(args []string, name string) string {
	for index, argument := range args {
		if argument == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
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

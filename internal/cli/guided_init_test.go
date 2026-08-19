package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/domain"
	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
)

type guidedRepositoryRunner struct {
	login       string
	missing     map[string]bool
	calls       []string
	graphqlHits int
	contexts    []context.Context
}

func (runner *guidedRepositoryRunner) LookPath(name string) (string, error) {
	if runner.missing[name] {
		return "", errors.New("not found")
	}
	return "/bin/" + name, nil
}

func (runner *guidedRepositoryRunner) Run(ctx context.Context, _ string, name string, args ...string) ([]byte, error) {
	joined := name + " " + strings.Join(args, " ")
	runner.calls = append(runner.calls, joined)
	runner.contexts = append(runner.contexts, ctx)
	if joined == "gh api user" {
		return []byte(`{"login":"` + runner.login + `"}`), nil
	}
	if strings.Contains(joined, "graphql") {
		runner.graphqlHits++
		return []byte(`{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"]}]}`), nil
	}
	return nil, fmt.Errorf("unexpected repository command %q", joined)
}

type guidedProviderRunner struct {
	states   map[provider.Name]guidedProviderState
	calls    []string
	contexts []context.Context
}

type guidedProviderState struct {
	available         bool
	marketplaceSource string
	plugins           map[string]bool
}

func newGuidedProviderRunner(source string) *guidedProviderRunner {
	return &guidedProviderRunner{states: map[provider.Name]guidedProviderState{
		provider.Codex:  {available: true, marketplaceSource: source, plugins: map[string]bool{}},
		provider.Claude: {available: true, marketplaceSource: source, plugins: map[string]bool{}},
	}}
}

func (runner *guidedProviderRunner) LookPath(name string) (string, error) {
	state, ok := runner.states[provider.Name(name)]
	if !ok || !state.available {
		return "", errors.New("not found")
	}
	return "/bin/" + name, nil
}

func (runner *guidedProviderRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	joined := name + " " + strings.Join(args, " ")
	runner.calls = append(runner.calls, joined)
	runner.contexts = append(runner.contexts, ctx)
	state := runner.states[provider.Name(name)]
	switch strings.Join(args, " ") {
	case "plugin marketplace list --json":
		if provider.Name(name) == provider.Codex {
			items := []map[string]string{}
			if state.marketplaceSource != "" {
				items = append(items, map[string]string{"name": "agent-plugins", "root": state.marketplaceSource})
			}
			return json.Marshal(map[string]any{"marketplaces": items})
		}
		items := []map[string]string{}
		if state.marketplaceSource != "" {
			items = append(items, map[string]string{"name": "agent-plugins", "source": "directory", "path": state.marketplaceSource})
		}
		return json.Marshal(items)
	case "plugin list --json":
		if provider.Name(name) == provider.Codex {
			var installed []map[string]any
			for pluginName, enabled := range state.plugins {
				installed = append(installed, map[string]any{
					"pluginId": pluginName + "@agent-plugins", "name": pluginName, "marketplaceName": "agent-plugins",
					"version": "test", "installed": true, "enabled": enabled,
				})
			}
			return json.Marshal(map[string]any{"installed": installed})
		}
		var installed []map[string]any
		for pluginName, enabled := range state.plugins {
			installed = append(installed, map[string]any{"id": pluginName + "@agent-plugins", "version": "test", "scope": "user", "enabled": enabled})
		}
		return json.Marshal(installed)
	default:
		return nil, fmt.Errorf("unexpected provider command %q", joined)
	}
}

func TestGuidedInitDiscoversBothProvidersAndPrintsWindowsApplyCommand(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	providerRunner := newGuidedProviderRunner(pluginSource)
	repositoryRunner := &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}}
	planCalls := 0
	dependencies := runtimeDependencies{
		stdin:            strings.NewReader("\n\n\n\n\n\n\nyes\n"),
		providerRunner:   providerRunner,
		repositoryRunner: repositoryRunner,
		goos:             "windows",
		initPlan: func(_ context.Context, options activation.Options) (activation.InitializationPlan, error) {
			planCalls++
			if options.GitHubOwner != "octo-lab" || options.Profile != activation.ProfileGitHub ||
				options.EvidenceProfile != domain.EvidenceProfileGitHubDeliveryV1 || options.Visibility != repository.VisibilityPrivate || options.ControlRepository != "agent-control" ||
				options.ContractsRepository != "agent-contracts" ||
				!reflect.DeepEqual(options.Providers, []provider.Name{provider.Codex, provider.Claude}) {
				t.Fatalf("guided plan options = %+v", options)
			}
			return sampleInitPlan(options), nil
		},
	}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := runWithDependencies([]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr, dependencies)
	if code != exitcode.Success {
		t.Fatalf("guided init code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if planCalls != 1 {
		t.Fatalf("planCalls = %d, want 1", planCalls)
	}
	for _, want := range []string{
		"AGX guided initialization discovery", "GitHub CLI: authenticated as octo-lab", "Recommended provider: both",
		"Discovery and choices reviewed", "Remote repositories are retained on uninstall", "AGX initialization plan (no changes made)",
		"--provider both --profile github --evidence-profile github-delivery/v1 --visibility private --control-repo agent-control --contracts-repo agent-contracts --apply",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("guided stdout missing %q:\n%s", want, stdout.String())
		}
	}
	for _, call := range providerRunner.calls {
		if strings.Contains(call, " add ") || strings.Contains(call, " install ") || strings.Contains(call, " remove ") || strings.Contains(call, " uninstall ") {
			t.Fatalf("guided flow mutated provider via %q", call)
		}
	}
	if repositoryRunner.graphqlHits != 0 {
		t.Fatalf("guided discovery unexpectedly queried repositories before plan fake: %d", repositoryRunner.graphqlHits)
	}
}

func TestGuidedInitPromptsForMulticaEvidenceSelectors(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	validUUID := "123e4567-e89b-42d3-a456-426614174000"
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin: strings.NewReader(strings.Join([]string{
				"", "", "", "multica-execution/v1", "not-a-uuid", validUUID, validUUID, validUUID, "", "", "", "yes", "",
			}, "\n")),
			providerRunner:   newGuidedProviderRunner(pluginSource),
			repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}},
			initPlan: func(_ context.Context, options activation.Options) (activation.InitializationPlan, error) {
				if options.EvidenceProfile != domain.EvidenceProfileMulticaExecutionV1 || options.MulticaWorkspaceID != validUUID ||
					options.MulticaRuntimeID != validUUID || options.MulticaAgentID != validUUID {
					t.Fatalf("guided evidence options = %+v", options)
				}
				return sampleInitPlan(options), nil
			},
		},
	)
	if code != exitcode.Success || stderr.Len() != 0 {
		t.Fatalf("guided Multica evidence code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	output := stdout.String()
	for _, want := range []string{"Evidence profile", "Multica Workspace UUID", "Invalid UUID", "multica-execution/v1", "…4000"} {
		if !strings.Contains(output, want) {
			t.Fatalf("guided Multica evidence stdout missing %q:\n%s", want, output)
		}
	}
	confirmationEnd := strings.Index(output, "Type yes to run")
	if confirmationEnd < 0 || strings.Contains(output[:confirmationEnd], validUUID) {
		t.Fatalf("guided confirmation exposed a full selector UUID:\n%s", output)
	}
	if strings.Count(output, validUUID) != 3 {
		t.Fatalf("guided apply command did not retain exactly three selector UUIDs:\n%s", output)
	}
}

func TestGuidedInitRecommendsClaudeWhenCodexHasSourceConflict(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	providerRunner := newGuidedProviderRunner("")
	providerRunner.states[provider.Codex] = guidedProviderState{available: true, marketplaceSource: filepath.Join(t.TempDir(), "other"), plugins: map[string]bool{}}
	providerRunner.states[provider.Claude] = guidedProviderState{available: true, marketplaceSource: pluginSource, plugins: map[string]bool{}}
	repositoryRunner := &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}}
	dependencies := runtimeDependencies{
		stdin:            strings.NewReader("\n\n\n\n\n\n\nyes\n"),
		providerRunner:   providerRunner,
		repositoryRunner: repositoryRunner,
		goos:             "linux",
		initPlan: func(_ context.Context, options activation.Options) (activation.InitializationPlan, error) {
			if !reflect.DeepEqual(options.Providers, []provider.Name{provider.Claude}) {
				t.Fatalf("guided selected providers = %#v, want claude only", options.Providers)
			}
			return sampleInitPlan(options), nil
		},
	}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := runWithDependencies([]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr, dependencies)
	if code != exitcode.Success {
		t.Fatalf("guided init code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "Codex: unavailable (AGX-INIT-SOURCE-CONFLICT") ||
		!strings.Contains(stdout.String(), "Recommended provider: claude") ||
		!strings.Contains(stdout.String(), "--provider claude") ||
		strings.Contains(stdout.String(), "--provider both") {
		t.Fatalf("guided source-conflict stdout = %q", stdout.String())
	}
}

func TestGuidedInitRejectsAnyExplicitOutputWithoutDiscoveryOrPrompt(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "output human", args: []string{"init", "--guided", "--root", "somewhere", "--output", "human"}},
		{name: "output json", args: []string{"init", "--guided", "--root", "somewhere", "--output", "json"}},
		{name: "output invalid", args: []string{"init", "--guided", "--root", "somewhere", "--output", "xml"}},
		{name: "empty output", args: []string{"init", "--guided", "--root", "somewhere", "--output", ""}},
		{name: "empty github owner", args: []string{"init", "--guided", "--root", "somewhere", "--github-owner", ""}},
		{name: "empty provider", args: []string{"init", "--guided", "--root", "somewhere", "--provider", ""}},
		{name: "duplicate root after empty", args: []string{"init", "--guided", "--root", "", "--root", "somewhere"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
			repositoryRunner := &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}}
			providerRunner := newGuidedProviderRunner("")
			code := runWithDependencies(
				test.args,
				"0.0.0-test", stdout, stderr,
				runtimeDependencies{
					stdin:            strings.NewReader("yes\n"),
					providerRunner:   providerRunner,
					repositoryRunner: repositoryRunner,
					initPlan: func(context.Context, activation.Options) (activation.InitializationPlan, error) {
						t.Fatal("guided with explicit --output should not plan")
						return activation.InitializationPlan{}, nil
					},
				},
			)
			if code != exitcode.Usage || stdout.Len() != 0 || !strings.Contains(stderr.String(), "AGX-USAGE-INIT-GUIDED") ||
				!strings.Contains(stderr.String(), "Next:") || len(repositoryRunner.calls) != 0 || len(providerRunner.calls) != 0 {
				t.Fatalf("%s code=%d stdout=%q stderr=%q repoCalls=%v providerCalls=%v", test.name, code, stdout.String(), stderr.String(), repositoryRunner.calls, providerRunner.calls)
			}
		})
	}
}

func TestGuidedInitCancelStopsBeforePlan(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin:            strings.NewReader("cancel\n"),
			providerRunner:   newGuidedProviderRunner(pluginSource),
			repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}},
			initPlan: func(context.Context, activation.Options) (activation.InitializationPlan, error) {
				t.Fatal("cancelled guided flow should not run plan")
				return activation.InitializationPlan{}, nil
			},
		},
	)
	if code != exitcode.Usage || !strings.Contains(stderr.String(), "AGX-GUIDED-CANCELLED") {
		t.Fatalf("cancel code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestGuidedInitSurfacesRepositoryCollisionBeforePrintingApplyCommand(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin:            strings.NewReader("\n\n\n\n\n\n\nyes\n"),
			providerRunner:   newGuidedProviderRunner(pluginSource),
			repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}},
			initPlan: func(context.Context, activation.Options) (activation.InitializationPlan, error) {
				return activation.InitializationPlan{}, errors.New("AGX-REPOSITORY-COLLISION: repository octo-lab/agent-control already exists")
			},
		},
	)
	if code != exitcode.Software || !strings.Contains(stderr.String(), "AGX-REPOSITORY-COLLISION") ||
		!strings.Contains(stderr.String(), "choose unused names") ||
		!strings.Contains(stdout.String(), "Type yes to run the read-only plan preflight") ||
		strings.Contains(stdout.String(), "Plan preflight passed") ||
		strings.Contains(stdout.String(), "AGX initialization plan") {
		t.Fatalf("collision code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestGuidedInitUsesFreshPlanContextAfterPrompt(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	providerRunner := newGuidedProviderRunner(pluginSource)
	repositoryRunner := &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin:            strings.NewReader("\n\n\n\n\n\n\nyes\n"),
			providerRunner:   providerRunner,
			repositoryRunner: repositoryRunner,
			initPlan: func(ctx context.Context, options activation.Options) (activation.InitializationPlan, error) {
				if err := ctx.Err(); err != nil {
					t.Fatalf("plan context was already done: %v", err)
				}
				for _, discoveryContext := range append(providerRunner.contexts, repositoryRunner.contexts...) {
					if discoveryContext == ctx {
						t.Fatal("plan reused discovery context across human input")
					}
				}
				return sampleInitPlan(options), nil
			},
		},
	)
	if code != exitcode.Success {
		t.Fatalf("guided init code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestGuidedInitRetriesInvalidProviderProfileAndVisibility(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin:            strings.NewReader("\nwat\nclaude\nbad-profile\nteam\n\nsideways\npublic\n\n\nyes\n"),
			providerRunner:   newGuidedProviderRunner(pluginSource),
			repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}},
			initPlan: func(_ context.Context, options activation.Options) (activation.InitializationPlan, error) {
				if !reflect.DeepEqual(options.Providers, []provider.Name{provider.Claude}) || options.Profile != activation.ProfileTeam || options.Visibility != repository.VisibilityPublic {
					t.Fatalf("retried choices produced options = %+v", options)
				}
				return sampleInitPlan(options), nil
			},
		},
	)
	if code != exitcode.Success || stderr.Len() != 0 ||
		!strings.Contains(stdout.String(), "Invalid provider") ||
		!strings.Contains(stdout.String(), "Invalid profile") ||
		!strings.Contains(stdout.String(), "Invalid visibility") {
		t.Fatalf("retry code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestGuidedInitInvalidProviderExhaustionGivesNextStepBeforePlan(t *testing.T) {
	root := makeGuidedInstallation(t)
	pluginSource := filepath.Join(root, "components", "agent-plugins")
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin:            strings.NewReader("\nwat\nbad\nnope\n"),
			providerRunner:   newGuidedProviderRunner(pluginSource),
			repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}},
			initPlan: func(context.Context, activation.Options) (activation.InitializationPlan, error) {
				t.Fatal("exhausted provider retries should not plan")
				return activation.InitializationPlan{}, nil
			},
		},
	)
	if code != exitcode.Usage || !strings.Contains(stderr.String(), "Next:") || !strings.Contains(stderr.String(), "no changes were made") {
		t.Fatalf("provider exhaustion code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestGuidedInitCancelAtEachPromptGivesNextStepBeforePlan(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{name: "owner", input: "cancel\n"},
		{name: "provider", input: "\ncancel\n"},
		{name: "profile", input: "\n\ncancel\n"},
		{name: "visibility", input: "\n\n\ncancel\n"},
		{name: "control repo", input: "\n\n\n\ncancel\n"},
		{name: "contracts repo", input: "\n\n\n\n\ncancel\n"},
		{name: "final confirmation cancel", input: "\n\n\n\n\n\ncancel\n"},
		{name: "final confirmation no", input: "\n\n\n\n\n\nno\n"},
		{name: "eof", input: "\n\n"},
		{name: "bom cancel", input: "\ufeffcancel\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := makeGuidedInstallation(t)
			pluginSource := filepath.Join(root, "components", "agent-plugins")
			stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
			code := runWithDependencies(
				[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
				runtimeDependencies{
					stdin:            strings.NewReader(test.input),
					providerRunner:   newGuidedProviderRunner(pluginSource),
					repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{}},
					initPlan: func(context.Context, activation.Options) (activation.InitializationPlan, error) {
						t.Fatal("cancelled guided flow should not run plan")
						return activation.InitializationPlan{}, nil
					},
				},
			)
			if code != exitcode.Usage || !strings.Contains(stderr.String(), "AGX-GUIDED-CANCELLED") || !strings.Contains(stderr.String(), "Next:") {
				t.Fatalf("%s cancel code=%d stdout=%q stderr=%q", test.name, code, stdout.String(), stderr.String())
			}
		})
	}
}

func TestNonInteractiveInitJSONStillDoesNotPrompt(t *testing.T) {
	root := makeGuidedInstallation(t)
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--root", root, "--github-owner", "octo-lab", "--provider", "codex", "--evidence-profile", "github-delivery/v1", "--output", "json"},
		"0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin: strings.NewReader("this would be a prompt answer\n"),
			initPlan: func(_ context.Context, options activation.Options) (activation.InitializationPlan, error) {
				return sampleInitPlan(options), nil
			},
		},
	)
	if code != exitcode.Success || stderr.Len() != 0 {
		t.Fatalf("noninteractive json code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var decoded initPlanResult
	if err := json.Unmarshal(stdout.Bytes(), &decoded); err != nil {
		t.Fatalf("json output is invalid: %v; %s", err, stdout.String())
	}
	if decoded.Mode != "plan" || decoded.MutationPerformed || strings.Contains(stdout.String(), "GitHub owner") {
		t.Fatalf("noninteractive json was polluted by guided prompts: %q", stdout.String())
	}
}

func TestGuidedInitReportsMissingGitHubCLI(t *testing.T) {
	root := makeGuidedInstallation(t)
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"init", "--guided", "--root", root}, "0.0.0-test", stdout, stderr,
		runtimeDependencies{
			stdin:            strings.NewReader("\n"),
			repositoryRunner: &guidedRepositoryRunner{login: "octo-lab", missing: map[string]bool{"gh": true}},
		},
	)
	if code != exitcode.Software || stdout.Len() != 0 ||
		!strings.Contains(stderr.String(), "AGX-REPOSITORY-CLI-MISSING") ||
		!strings.Contains(stderr.String(), "install git and GitHub CLI") {
		t.Fatalf("missing gh code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func sampleInitPlan(options activation.Options) activation.InitializationPlan {
	providerPlans := make([]activation.ProviderPlan, 0, len(options.Providers))
	for _, name := range options.Providers {
		providerPlans = append(providerPlans, activation.ProviderPlan{
			Name:              name,
			MarketplaceAction: "add",
			Plugins:           []activation.PluginPlan{{Name: "grilling", Action: "install"}},
		})
	}
	return activation.InitializationPlan{
		InstallationID:        "install-test",
		TemplateVersion:       bootstrap.TemplateSetVersion,
		TemplateContentSHA256: bootstrap.TemplateSetContentSHA256,
		PluginSource:          bootstrap.AgentPluginsReferenceRepository,
		Profile:               options.Profile,
		Providers:             providerPlans,
		Repositories: []activation.RepositoryPlan{
			{
				Kind: bootstrap.KindAgentControl, Owner: options.GitHubOwner, Name: options.ControlRepository,
				Visibility: options.Visibility, Action: "create", TemplateVersion: "agent-control/v1", TemplateDigest: strings.Repeat("a", 64),
			},
			{
				Kind: bootstrap.KindAgentContracts, Owner: options.GitHubOwner, Name: options.ContractsRepository,
				Visibility: options.Visibility, Action: "create", TemplateVersion: "agent-contracts/v1", TemplateDigest: strings.Repeat("b", 64),
			},
		},
	}
}

func makeGuidedInstallation(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "installation")
	pluginFile := filepath.Join(root, "components", "agent-plugins", "README.md")
	if err := os.MkdirAll(filepath.Dir(pluginFile), 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte("fixture\n")
	if err := os.WriteFile(pluginFile, content, 0o600); err != nil {
		t.Fatal(err)
	}
	contentDigest := fmt.Sprintf("%x", sha256.Sum256(content))
	receipt := installer.Receipt{
		SchemaVersion: "agx.receipt/v2", InstallationID: "install-test", BundleID: "bundle-test",
		BundleSHA256: strings.Repeat("e", 64), TemplateVersion: bootstrap.TemplateSetVersion,
		TemplateContentSHA256: bootstrap.TemplateSetContentSHA256, Phase: "configured",
		Components: []installer.Component{{
			Name: "agent-plugins", Repository: bootstrap.AgentPluginsReferenceRepository, DistributionRepository: "2233admin/agent-plugins",
			CommitSHA: strings.Repeat("b", 40), AssetSHA256: strings.Repeat("d", 64), Path: "components/agent-plugins",
		}},
		OwnedFiles:      []string{"components/agent-plugins/README.md"},
		OwnedFileSHA256: map[string]string{"components/agent-plugins/README.md": contentDigest},
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".agx"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".agx", "receipt.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

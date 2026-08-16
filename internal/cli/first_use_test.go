package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/exitcode"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
)

func TestFirstUsePrompts(t *testing.T) {
	tests := []struct {
		name      string
		profile   activation.Profile
		providers []provider.Name
		want      []firstUsePrompt
	}{
		{
			name:      "core codex",
			profile:   activation.ProfileCore,
			providers: []provider.Name{provider.Codex},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
			},
		},
		{
			name:      "core claude",
			profile:   activation.ProfileCore,
			providers: []provider.Name{provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
			},
		},
		{
			name:      "core both",
			profile:   activation.ProfileCore,
			providers: []provider.Name{provider.Codex, provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
			},
		},
		{
			name:      "full codex",
			profile:   activation.ProfileFull,
			providers: []provider.Name{provider.Codex},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Codex, Prompt: "$github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Codex, Prompt: "$resource-observability:resource-observability 查看当前账户额度"},
			},
		},
		{
			name:      "full claude",
			profile:   activation.ProfileFull,
			providers: []provider.Name{provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Claude, Prompt: "/github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Claude, Prompt: "/resource-observability:resource-observability 查看当前账户额度"},
			},
		},
		{
			name:      "full both",
			profile:   activation.ProfileFull,
			providers: []provider.Name{provider.Codex, provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Codex, Prompt: "$github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Claude, Prompt: "/github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Codex, Prompt: "$resource-observability:resource-observability 查看当前账户额度"},
				{Provider: provider.Claude, Prompt: "/resource-observability:resource-observability 查看当前账户额度"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			receipt := activation.Receipt{Profile: test.profile, Providers: providerReceipts(test.providers)}
			if got := firstUsePrompts(receipt); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("firstUsePrompts() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestInitResultSerializesStructuredFirstUse(t *testing.T) {
	receipt := activation.Receipt{
		InstallationID: "installation-test",
		Phase:          activation.PhaseInitialized,
		Profile:        activation.ProfileFull,
		Providers:      providerReceipts([]provider.Name{provider.Codex, provider.Claude}),
	}
	result := newInitResult(receipt, true)

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json.Marshal(newInitResult()) error = %v", err)
	}
	var decoded struct {
		FirstUse []firstUsePrompt `json:"first_use"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(init result) error = %v", err)
	}
	if !reflect.DeepEqual(decoded.FirstUse, firstUsePrompts(receipt)) {
		t.Fatalf("decoded first_use = %#v, want %#v", decoded.FirstUse, firstUsePrompts(receipt))
	}
	if !strings.Contains(string(data), `"first_use":[{"provider":"codex","prompt":"$grilling:grilling`) {
		t.Fatalf("init result JSON does not contain machine-readable first_use prompts: %s", data)
	}
}

func TestHumanFirstUseUsesStructuredPrompts(t *testing.T) {
	receipt := activation.Receipt{
		Profile:   activation.ProfileFull,
		Providers: providerReceipts([]provider.Name{provider.Codex, provider.Claude}),
	}
	stdout := new(bytes.Buffer)

	printFirstUse(stdout, receipt)

	want := "Start a new provider session, then try:\n" +
		"  Codex:  $grilling:grilling 帮我压力测试这个方案\n" +
		"  Claude: /grilling:grilling 帮我压力测试这个方案\n" +
		"  Codex:  $github-collaboration:issue-workflow 处理 GitHub Issue #123\n" +
		"  Claude: /github-collaboration:issue-workflow 处理 GitHub Issue #123\n" +
		"  Codex:  $resource-observability:resource-observability 查看当前账户额度\n" +
		"  Claude: /resource-observability:resource-observability 查看当前账户额度\n"
	if got := stdout.String(); got != want {
		t.Fatalf("printFirstUse() = %q, want %q", got, want)
	}
}

func TestApplyHelpAndNextStepRemainAvailable(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := Run([]string{"apply", "--help"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(apply --help) exit code = %d, want %d", code, exitcode.Success)
	}
	if stderr.Len() != 0 || !strings.Contains(stdout.String(), "agx apply --root <directory> [--bundle <bundle.json>]") ||
		!strings.Contains(stdout.String(), "built-in production Bundle") || !strings.Contains(stdout.String(), "explicitly override") {
		t.Fatalf("Run(apply --help) stdout=%q stderr=%q", stdout.String(), stderr.String())
	}

	stdout.Reset()
	printApplyNextStep(stdout, `D:\AGX installations\default`)
	want := "Next: preview initialization. Replace <owner> and ensure git, authenticated gh, and both selected provider CLIs are on PATH:\n" +
		"  agx init --root \"D:\\AGX installations\\default\" --github-owner <owner> --provider both --profile core\n" +
		"The preview names the two deployment repositories, provider changes, template digests, and collision behavior.\n" +
		"Review the plan, then append --apply to that exact command to create agent-control and agent-contracts and activate providers.\n" +
		"Installation phase is configured; initialization does not claim verified.\n"
	if got := stdout.String(); got != want {
		t.Fatalf("printApplyNextStep() = %q, want %q", got, want)
	}
}

func TestNewApplyOptionsUsesBuiltInProductionBundleUnlessOverridden(t *testing.T) {
	builtIn := newApplyOptions(`D:\agx`, "")
	if builtIn.Root != `D:\agx` || builtIn.BundleData == nil || len(builtIn.BundleData) == 0 || builtIn.BundlePath != "" {
		t.Fatalf("newApplyOptions(default) = %#v", builtIn)
	}

	override := newApplyOptions(`D:\agx`, `D:\manifests\bundle.json`)
	if override.Root != `D:\agx` || override.BundlePath != `D:\manifests\bundle.json` || override.BundleData != nil {
		t.Fatalf("newApplyOptions(override) = %#v", override)
	}
}

func TestParseNamedOptionsSupportsBooleanFlags(t *testing.T) {
	values, err := parseNamedOptions([]string{"--root", "somewhere", "--apply"}, map[string]bool{"--root": true, "--apply": false})
	if err != nil {
		t.Fatal(err)
	}
	if values["--root"] != "somewhere" || values["--apply"] != "true" {
		t.Fatalf("parseNamedOptions() = %#v", values)
	}
	if _, err := parseNamedOptions([]string{"--apply", "--apply"}, map[string]bool{"--apply": false}); err == nil {
		t.Fatal("parseNamedOptions() accepted a duplicate flag")
	}
}

func TestPrintInitializationPlanMakesDryRunAndApplyExplicit(t *testing.T) {
	plan := activation.InitializationPlan{
		InstallationID: "install-test", TemplateVersion: "bootstrap-test", TemplateContentSHA256: strings.Repeat("a", 64),
		Repositories: []activation.RepositoryPlan{{
			Kind: "agent-control", Owner: "octo-lab", Name: "agent-control", Visibility: repository.VisibilityPrivate,
			Action: "create", TemplateVersion: "agent-control/v1", TemplateDigest: strings.Repeat("b", 64),
		}},
		Providers: []activation.ProviderPlan{{
			Name: provider.Codex, MarketplaceAction: "add",
			Plugins: []activation.PluginPlan{{Name: "grilling", Action: "install"}},
		}},
	}
	stdout := new(bytes.Buffer)
	printInitializationPlan(stdout, plan, "agx init --root D:\\agx --github-owner octo-lab --provider codex --apply")
	for _, wanted := range []string{
		"no changes made", "create octo-lab/agent-control", "Marketplace add", "grilling install", "--apply",
		"agent-plugins as the only installed source", "persist a recovery receipt", "retained on uninstall",
		"never adopted or overwritten", "exact command", "agx init --root D:\\agx --github-owner octo-lab --provider codex --apply",
	} {
		if !strings.Contains(stdout.String(), wanted) {
			t.Fatalf("plan output %q does not contain %q", stdout.String(), wanted)
		}
	}
}

func TestFormatInitCommandAppendsApplyWithoutChangingArguments(t *testing.T) {
	args := []string{"--root", `D:\AGX installations\default`, "--github-owner", "octo-lab", "--provider", "both", "--profile", "github"}
	want := `agx init --root "D:\AGX installations\default" --github-owner octo-lab --provider both --profile github --apply`
	if got := formatInitCommand(args, true); got != want {
		t.Fatalf("formatInitCommand() = %q, want %q", got, want)
	}
}

func TestPrintInitRecoveryUsesOriginalApplyCommandAndRejectsResumeCommand(t *testing.T) {
	stdout := new(bytes.Buffer)
	args := []string{"--root", `D:\agx`, "--github-owner", "octo-lab", "--provider", "codex", "--apply"}
	printInitRecovery(stdout, activation.Receipt{Phase: activation.PhaseNeedsResume}, args)
	want := "Initialization stopped in phase needs_resume. AGX retained its recovery receipt.\n" +
		"There is no separate resume command.\n" +
		"Next: resolve the reported problem, then rerun the original initialization command unchanged:\n" +
		"  agx init --root D:\\agx --github-owner octo-lab --provider codex --apply\n"
	if got := stdout.String(); got != want {
		t.Fatalf("printInitRecovery() = %q, want %q", got, want)
	}
	if strings.Contains(stdout.String(), "agx resume") {
		t.Fatalf("printInitRecovery() introduced nonexistent command: %q", stdout.String())
	}
}

func TestPrintInitErrorAddsHumanOnlyActionableNextSteps(t *testing.T) {
	tests := []struct {
		code string
		want string
	}{
		{"AGX-REPOSITORY-COLLISION: repository exists", "--control-repo"},
		{"AGX-INIT-SOURCE-CONFLICT: source differs", "Marketplace source conflict"},
		{"AGX-REPOSITORY-AUTH: login failed", "gh auth login"},
		{"AGX-REPOSITORY-CLI-MISSING: gh is unavailable", "install git and GitHub CLI"},
		{"AGX-INIT-PROVIDER-CLI-MISSING: codex is unavailable", "selected provider CLI"},
	}
	for _, test := range tests {
		t.Run(strings.Split(test.code, ":")[0], func(t *testing.T) {
			human := new(bytes.Buffer)
			printInitError(human, errors.New(test.code), "human")
			if got := human.String(); !strings.Contains(got, "Next:") || !strings.Contains(got, test.want) {
				t.Fatalf("human init error = %q, want actionable %q", got, test.want)
			}

			machine := new(bytes.Buffer)
			printInitError(machine, errors.New(test.code), "json")
			if got := machine.String(); got != test.code+"\n" || strings.Contains(got, "Next:") {
				t.Fatalf("json init error = %q, want only original error", got)
			}
		})
	}
}

func TestPrintStatusNextGuidesInitializationAndRecoveryWithoutGuessing(t *testing.T) {
	tests := []struct {
		name           string
		installPhase   string
		missing        []string
		modified       []string
		initialization activation.State
		want           []string
	}{
		{
			name: "configured installation needs preview", installPhase: "configured",
			initialization: activation.State{Status: activation.StatusAbsent},
			want:           []string{"preview initialization", `agx init --root "D:\AGX installations\default"`, "--github-owner <owner>", "--provider codex|claude|both"},
		},
		{
			name: "needs resume uses original apply", installPhase: "configured",
			initialization: activation.State{Status: activation.PhaseNeedsResume},
			want:           []string{"no separate resume command", "original agx init ... --apply command unchanged"},
		},
		{
			name: "provisioning uses original apply", installPhase: "configured",
			initialization: activation.State{Status: activation.PhaseProvisioning},
			want:           []string{"no separate resume command", "original agx init ... --apply command unchanged"},
		},
		{
			name: "drift reports repairs before status", installPhase: "drifted", missing: []string{"missing"}, modified: []string{"modified"},
			initialization: activation.State{Status: activation.StatusDrifted, Problems: []string{"problem"}},
			want:           []string{"repair every missing or modified", "resolve every initialization problem", `agx status --root "D:\AGX installations\default"`},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stdout := new(bytes.Buffer)
			printStatusNext(stdout, `D:\AGX installations\default`, test.installPhase, test.missing, test.modified, test.initialization)
			for _, want := range test.want {
				if !strings.Contains(stdout.String(), want) {
					t.Fatalf("status next = %q, want %q", stdout.String(), want)
				}
			}
		})
	}
}

func TestInitPlanResultHasStableMachineReadableEnvelope(t *testing.T) {
	plan := activation.InitializationPlan{
		InstallationID: "install-test", TemplateVersion: "bootstrap-test",
		TemplateContentSHA256: strings.Repeat("a", 64), PluginSource: "zaurakworks/agent-plugins",
		Profile: activation.ProfileCore, Providers: []activation.ProviderPlan{}, Repositories: []activation.RepositoryPlan{},
	}
	data, err := json.Marshal(newInitPlanResult(plan))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"mode":"plan","mutation_performed":false,"plan":{"installation_id":"install-test","template_version":"bootstrap-test","template_content_sha256":"` + strings.Repeat("a", 64) + `","plugin_source":"zaurakworks/agent-plugins","profile":"core","providers":[],"repositories":[]}}`
	if string(data) != want {
		t.Fatalf("init plan JSON = %s, want %s", data, want)
	}
}

func providerReceipts(names []provider.Name) []activation.ProviderReceipt {
	receipts := make([]activation.ProviderReceipt, 0, len(names))
	for _, name := range names {
		receipts = append(receipts, activation.ProviderReceipt{Name: name})
	}
	return receipts
}

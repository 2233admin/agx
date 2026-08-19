package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/project"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
	"github.com/2233admin/agx/internal/smoke"
)

func TestFirstUsePrompts(t *testing.T) {
	receipt := firstUseReceipt([]provider.Name{provider.Codex, provider.Claude}, activation.ProfileFull)
	firstUse, err := newFirstUseOutput(receipt)
	if err != nil {
		t.Fatal(err)
	}
	got := firstUse.prompts
	if len(got) != 2 || got[0].Provider != provider.Codex || got[1].Provider != provider.Claude {
		t.Fatalf("firstUsePrompts() = %#v, want one prompt per selected Agent", got)
	}
	for _, item := range got {
		if !strings.Contains(item.Prompt, "grilling") || !strings.Contains(item.Prompt, smoke.ContractVersionV1) ||
			!strings.Contains(item.Prompt, receipt.Project.URL) || !strings.HasSuffix(item.Prompt, string(firstUse.payload)) ||
			strings.Contains(item.Prompt, "帮我创建一个 Project") {
			t.Fatalf("prompt = %q, want shared self-contained bootstrap verification payload %s", item.Prompt, firstUse.payload)
		}
	}
}

func TestInitResultSerializesStructuredFirstUse(t *testing.T) {
	receipt := firstUseReceipt([]provider.Name{provider.Codex, provider.Claude}, activation.ProfileFull)
	firstUse, err := newFirstUseOutput(receipt)
	if err != nil {
		t.Fatal(err)
	}
	result := newInitResult(receipt, true, firstUse)

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json.Marshal(newInitResult()) error = %v", err)
	}
	var decoded struct {
		FirstUseContract smoke.Contract   `json:"first_use_contract"`
		FirstUse         []firstUsePrompt `json:"first_use"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(init result) error = %v", err)
	}
	if !reflect.DeepEqual(decoded.FirstUse, firstUse.prompts) {
		t.Fatalf("decoded first_use = %#v, want %#v", decoded.FirstUse, firstUse.prompts)
	}
	if decoded.FirstUseContract.SchemaVersion != smoke.ContractVersionV1 ||
		decoded.FirstUseContract.ProjectURL != receipt.Project.URL || decoded.FirstUseContract.InstallationID != receipt.InstallationID {
		t.Fatalf("decoded first_use_contract = %+v", decoded.FirstUseContract)
	}
	if !strings.Contains(string(data), `"first_use":[{"provider":"codex","prompt":"$grilling:grilling 请严格按以下 agx.first-use/v1`) ||
		!strings.Contains(string(data), `"first_use_contract":`+string(firstUse.payload)) {
		t.Fatalf("init result JSON does not contain the shared machine-readable first-use payload: %s", data)
	}
}

func TestHumanFirstUseUsesStructuredPrompts(t *testing.T) {
	receipt := firstUseReceipt([]provider.Name{provider.Codex, provider.Claude}, activation.ProfileFull)
	firstUse, err := newFirstUseOutput(receipt)
	if err != nil {
		t.Fatal(err)
	}
	stdout := new(bytes.Buffer)

	printFirstUse(stdout, firstUse)

	for _, want := range []string{
		"GitHub Project: " + receipt.Project.URL,
		"First-use contract: " + smoke.ContractVersionV1,
		"  " + string(firstUse.payload),
		`"required_outputs":["issue_url","project_item","pull_request_url","validation_result"]`,
		"Codex:", "Claude:", "Bootstrap Verification", "agx status",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("printFirstUse() = %q, want %q", stdout.String(), want)
		}
	}
}

func TestInitReturnsSoftwareWhenFirstUseContractCannotBeDerived(t *testing.T) {
	receipt := firstUseReceipt([]provider.Name{provider.Codex}, activation.ProfileCore)
	receipt.Project.Verification = project.VerificationCreated
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := runWithDependencies(
		[]string{"init", "--root", t.TempDir(), "--github-owner", "octo-lab", "--provider", "codex", "--evidence-profile", "github-delivery/v1", "--apply", "--output", "json"},
		"0.0.0-test", stdout, stderr,
		runtimeDependencies{initApply: func(context.Context, activation.Options) (activation.Receipt, bool, error) {
			return receipt, false, nil
		}},
	)

	if code != exitcode.Software || stdout.Len() != 0 || !strings.Contains(stderr.String(), "AGX-INIT-FIRST-USE-CONTRACT") {
		t.Fatalf("code=%d stdout=%q stderr=%q, want stable software error without partial success output", code, stdout.String(), stderr.String())
	}
}

func TestDeploymentVisibilityPrintsURLsTemplateEvidenceAndEffectiveSmoke(t *testing.T) {
	state := activation.State{
		Status: activation.PhaseInitialized, Profile: activation.ProfileCore,
		Project: &project.Receipt{
			URL: "https://github.com/orgs/octo-lab/projects/7", Visibility: project.VisibilityPrivate,
			LinkedRepository: "octo-lab/agent-control",
		},
		RepositoryDetails: []repository.Receipt{{
			NameWithOwner: "octo-lab/agent-control", URL: "https://github.com/octo-lab/agent-control",
			TemplateDigest: strings.Repeat("a", 64), Verification: repository.VerificationReadback,
		}},
		Smoke: smoke.Evidence{
			Status: smoke.StatusEffective, IssueURL: "https://github.com/octo-lab/agent-control/issues/12",
			ProjectItem: "PVTI_item", PullRequestURL: "https://github.com/octo-lab/agent-control/pull/13",
			WorkPointer:      "work/current.md",
			ValidationResult: "passed",
		},
	}
	stdout := new(bytes.Buffer)
	printDeploymentVisibility(stdout, state)
	for _, want := range []string{
		"https://github.com/orgs/octo-lab/projects/7", "octo-lab/agent-control", strings.Repeat("a", 64),
		"https://github.com/octo-lab/agent-control/issues/12", "PVTI_item",
		"https://github.com/octo-lab/agent-control/pull/13", "effective", "passed",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("visibility output = %q, want %q", stdout.String(), want)
		}
	}
	if strings.Contains(stdout.String(), "verified") {
		t.Fatalf("visibility output made a reserved verification claim: %q", stdout.String())
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
	want := fmt.Sprintf("Next: run the guided initialization preview with this %s command. It discovers gh identity, usable provider CLIs, source conflicts, repositories, and prints an exact apply command:\n", commandShellLabel()) +
		fmt.Sprintf("  agx init --guided --root %s\n", quoteCommandArg(`D:\AGX installations\default`)) +
		"Automation can keep using explicit agx init --root ... --github-owner ... --provider ... followed by the same command with --apply.\n" +
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
	if _, err := parseNamedOptions([]string{"--root", "", "--root", "somewhere"}, map[string]bool{"--root": true}); err == nil {
		t.Fatal("parseNamedOptions() accepted a duplicate flag after an empty value")
	}
	if values, err := parseNamedOptions([]string{"--output", ""}, map[string]bool{"--output": true}); err != nil || values["--output"] != "" {
		t.Fatalf("parseNamedOptions(empty value) = %#v, %v", values, err)
	}
}

func TestPrintInitializationPlanMakesDryRunAndApplyExplicit(t *testing.T) {
	plan := activation.InitializationPlan{
		InstallationID: "install-test", TemplateVersion: "bootstrap-test", TemplateContentSHA256: strings.Repeat("a", 64),
		Repositories: []activation.RepositoryPlan{{
			Kind: "agent-control", Owner: "octo-lab", Name: "agent-control", Visibility: repository.VisibilityPrivate,
			Action: "create", TemplateVersion: "agent-control/v1", TemplateDigest: strings.Repeat("b", 64),
		}},
		Project: activation.ProjectPlan{
			Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: project.VisibilityPrivate,
			LinkedRepository: "octo-lab/agent-control", Action: "create", Retained: true,
		},
		Providers: []activation.ProviderPlan{{
			Name: provider.Codex, MarketplaceAction: "add",
			Plugins: []activation.PluginPlan{{Name: "grilling", Action: "install"}},
		}},
	}
	stdout := new(bytes.Buffer)
	printInitializationPlan(stdout, plan, "agx init --root D:\\agx --github-owner octo-lab --provider codex --apply")
	for _, wanted := range []string{
		"no changes made", "create octo-lab/agent-control", "Project create", "agent-control deployment (install-test)",
		"link octo-lab/agent-control", "Marketplace add", "grilling install", "--apply",
		"agent-plugins as the only installed source", "persist a recovery receipt", "retained on uninstall",
		"never adopted or overwritten", "same arguments", "agx init --root D:\\agx --github-owner octo-lab --provider codex --apply",
	} {
		if !strings.Contains(stdout.String(), wanted) {
			t.Fatalf("plan output %q does not contain %q", stdout.String(), wanted)
		}
	}
}

func TestFormatInitCommandAppendsApplyWithoutChangingArguments(t *testing.T) {
	args := []string{"--root", `D:\AGX & tools\cost $5's`, "--github-owner", "octo-lab", "--provider", "both", "--profile", "github"}
	tests := []struct {
		goos string
		want string
	}{
		{goos: "windows", want: `agx init --root 'D:\AGX & tools\cost $5''s' --github-owner octo-lab --provider both --profile github --apply`},
		{goos: "linux", want: `agx init --root 'D:\AGX & tools\cost $5'"'"'s' --github-owner octo-lab --provider both --profile github --apply`},
	}
	for _, test := range tests {
		if got := formatInitCommandForPlatform(args, true, test.goos); got != test.want {
			t.Fatalf("formatInitCommandForPlatform(%s) = %q, want %q", test.goos, got, test.want)
		}
	}
}

func TestQuoteCommandArgForPlatformQuotesShellMetacharacters(t *testing.T) {
	for _, value := range []string{"space here", "a&b", "a;b", "$HOME", "a|b", "it's"} {
		for _, goos := range []string{"windows", "linux"} {
			got := quoteCommandArgForPlatform(value, goos)
			if got == value || !strings.HasPrefix(got, "'") || !strings.HasSuffix(got, "'") {
				t.Fatalf("quoteCommandArgForPlatform(%q, %s) = %q, want single-quoted safe argument", value, goos, got)
			}
		}
	}
	if got := quoteCommandArgForPlatform("it's", "windows"); got != `'it''s'` {
		t.Fatalf("PowerShell quote = %q", got)
	}
	if got := quoteCommandArgForPlatform("it's", "linux"); got != `'it'"'"'s'` {
		t.Fatalf("POSIX quote = %q", got)
	}
}

func TestPrintInitRecoveryUsesOriginalApplyCommandAndRejectsResumeCommand(t *testing.T) {
	stdout := new(bytes.Buffer)
	args := []string{"--root", `D:\agx`, "--github-owner", "octo-lab", "--provider", "codex", "--apply"}
	printInitRecovery(stdout, activation.Receipt{Phase: activation.PhaseNeedsResume}, args)
	want := "Initialization stopped in phase needs_resume. AGX retained its recovery receipt.\n" +
		"There is no separate resume command.\n" +
		fmt.Sprintf("Next: resolve the reported problem, then run this %s command again with the same arguments:\n", commandShellLabel()) +
		fmt.Sprintf("  %s\n", formatInitCommand(args, false))
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
			want:           []string{"preview initialization", "agx init --guided --root " + quoteCommandArg(`D:\AGX installations\default`)},
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
			want:           []string{"repair every missing or modified", "resolve every initialization problem", "agx status --root " + quoteCommandArg(`D:\AGX installations\default`)},
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

func TestDiagnoseNextStepsNamesInitializationResumeCommand(t *testing.T) {
	next := diagnoseNextSteps(`D:\agx`, installer.State{Phase: "configured"}, activation.State{Status: activation.PhaseNeedsResume})
	if len(next) != 1 || !strings.Contains(next[0], "agx init") || !strings.Contains(next[0], "--apply") || strings.Contains(next[0], "original apply command") {
		t.Fatalf("diagnoseNextSteps() = %#v, want original agx init ... --apply guidance", next)
	}
}

func TestDiagnoseDoesNotDiscloseAbsoluteInstallationRoot(t *testing.T) {
	root := makeGuidedInstallation(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{"human", "json"} {
		t.Run(output, func(t *testing.T) {
			stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
			code := runWithDependencies(
				[]string{"diagnose", "--root", root, "--output", output}, "0.0.0-test", stdout, stderr, runtimeDependencies{},
			)
			if code != exitcode.Success {
				t.Fatalf("diagnose code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			combined := stdout.String() + stderr.String()
			escapedRoot, _ := json.Marshal(root)
			escapedHome, _ := json.Marshal(home)
			for _, sentinel := range []string{root, home, strings.Trim(string(escapedRoot), `"`), strings.Trim(string(escapedHome), `"`)} {
				if sentinel != "" && strings.Contains(combined, sentinel) {
					t.Fatalf("diagnose %s output disclosed local path sentinel %q: %q", output, sentinel, combined)
				}
			}
			placeholderOutput := combined
			if output == "json" {
				var report struct {
					Next []string `json:"next_steps"`
				}
				if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
					t.Fatal(err)
				}
				placeholderOutput = strings.Join(report.Next, "\n")
			}
			if !strings.Contains(placeholderOutput, "<installation-root>") {
				t.Fatalf("diagnose %s output = %q, want stable root placeholder", output, combined)
			}
		})
	}
}

func TestStatusAndDiagnoseHideInconclusivePartialState(t *testing.T) {
	root := makeGuidedInstallation(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	poisoned := activation.State{
		Status:       activation.StatusDrifted,
		Problems:     []string{"drift at " + root, "awaiting operator at " + home},
		Repositories: []string{"poisoned/repository"},
		Smoke: smoke.Evidence{
			Status:   smoke.StatusAwaiting,
			Problems: []string{"run agx init --apply from " + root},
		},
	}
	statusErr := fmt.Errorf("AGX-STATUS-INCONCLUSIVE: remote readback timed out; rerun agx status or agx diagnose; no changes were made: %w", context.DeadlineExceeded)
	status := func(context.Context, string, provider.Runner, ...repository.Runner) (activation.State, error) {
		return poisoned, statusErr
	}

	for _, command := range []string{"status", "diagnose"} {
		for _, output := range []string{"human", "json"} {
			t.Run(command+"/"+output, func(t *testing.T) {
				stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
				code := runWithDependencies(
					[]string{command, "--root", root, "--output", output}, "0.0.0-test", stdout, stderr,
					runtimeDependencies{status: status},
				)
				if code != exitcode.Data {
					t.Fatalf("%s --output %s code=%d, want %d", command, output, code, exitcode.Data)
				}
				if stdout.Len() != 0 {
					t.Fatalf("%s --output %s emitted success stdout: %q", command, output, stdout.String())
				}
				if !strings.Contains(stderr.String(), "AGX-STATUS-INCONCLUSIVE") ||
					!strings.Contains(stderr.String(), "rerun agx status or agx diagnose") {
					t.Fatalf("%s --output %s stderr=%q, want stable inconclusive rerun guidance", command, output, stderr.String())
				}

				combined := stdout.String() + stderr.String()
				escapedRoot, _ := json.Marshal(root)
				escapedHome, _ := json.Marshal(home)
				for _, forbidden := range []string{
					"drift", "awaiting", "--apply", root, home,
					strings.Trim(string(escapedRoot), `"`), strings.Trim(string(escapedHome), `"`),
					`"installation"`, `"initialization"`, `"phase"`, "AGX diagnosis",
				} {
					if forbidden != "" && strings.Contains(combined, forbidden) {
						t.Fatalf("%s --output %s disclosed forbidden partial-state marker %q: %q", command, output, forbidden, combined)
					}
				}
			})
		}
	}
}

func TestInitRejectsInvalidEvidenceSelectionBeforePlanning(t *testing.T) {
	validUUID := "123e4567-e89b-42d3-a456-426614174000"
	tests := []struct {
		name string
		args []string
		code string
	}{
		{
			name: "missing profile",
			args: []string{"init", "--root", t.TempDir(), "--github-owner", "octo-lab", "--provider", "codex"},
			code: "AGX-EVIDENCE-PROFILE-REQUIRED",
		},
		{
			name: "unsupported profile",
			args: []string{"init", "--root", t.TempDir(), "--github-owner", "octo-lab", "--provider", "codex", "--evidence-profile", "github-delivery/v2"},
			code: "AGX-EVIDENCE-PROFILE-UNSUPPORTED",
		},
		{
			name: "incomplete Multica selectors",
			args: []string{"init", "--root", t.TempDir(), "--github-owner", "octo-lab", "--provider", "codex", "--evidence-profile", "multica-execution/v1", "--multica-workspace-id", validUUID},
			code: "AGX-EVIDENCE-SUBJECT-INCOMPLETE",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			planned := false
			stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
			result := runWithDependencies(test.args, "0.0.0-test", stdout, stderr, runtimeDependencies{
				initPlan: func(context.Context, activation.Options) (activation.InitializationPlan, error) {
					planned = true
					return activation.InitializationPlan{}, nil
				},
			})
			if result != exitcode.Usage || planned || stdout.Len() != 0 || !strings.Contains(stderr.String(), test.code) {
				t.Fatalf("runWithDependencies() code=%d planned=%v stdout=%q stderr=%q, want preflight %s", result, planned, stdout.String(), stderr.String(), test.code)
			}
		})
	}
}

func TestInitPlanResultHasStableMachineReadableEnvelope(t *testing.T) {
	plan := activation.InitializationPlan{
		InstallationID: "install-test", TemplateVersion: "bootstrap-test",
		TemplateContentSHA256: strings.Repeat("a", 64), PluginSource: "zaurakworks/agent-plugins",
		Profile: activation.ProfileCore, Providers: []activation.ProviderPlan{}, Repositories: []activation.RepositoryPlan{},
		Project: activation.ProjectPlan{
			Owner: "octo-lab", Title: "agent-control deployment (install-test)", Visibility: project.VisibilityPrivate,
			LinkedRepository: "octo-lab/agent-control", Action: "create", Retained: true,
		},
	}
	data, err := json.Marshal(newInitPlanResult(plan))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"mode":"plan","mutation_performed":false,"plan":{"installation_id":"install-test","template_version":"bootstrap-test","template_content_sha256":"` + strings.Repeat("a", 64) + `","plugin_source":"zaurakworks/agent-plugins","profile":"core","evidence_profile":"","deployment_digest":"","subject_digest":"","providers":[],"repositories":[],"project":{"owner":"octo-lab","title":"agent-control deployment (install-test)","visibility":"private","linked_repository":"octo-lab/agent-control","action":"create","retained_on_uninstall":true}}}`
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

func firstUseReceipt(names []provider.Name, profile activation.Profile) activation.Receipt {
	installationID := "installation-test"
	return activation.Receipt{
		InstallationID: installationID, Phase: activation.PhaseInitialized, Profile: profile,
		GitHubOwner: "octo-lab", ControlRepository: "agent-control", ContractsRepository: "agent-contracts",
		Repositories: []repository.Receipt{
			{NameWithOwner: "octo-lab/agent-control", URL: "https://github.com/octo-lab/agent-control"},
			{NameWithOwner: "octo-lab/agent-contracts", URL: "https://github.com/octo-lab/agent-contracts"},
		},
		Project: &project.Receipt{
			Owner: "octo-lab", Number: 7, NodeID: "PVT_test", URL: "https://github.com/orgs/octo-lab/projects/7",
			Title: "agent-control deployment (" + installationID + ")", Visibility: project.VisibilityPrivate,
			LinkedRepository: "octo-lab/agent-control", InstallationID: installationID, Created: true, Linked: true,
			Verification: project.VerificationReadback,
		},
		Providers: providerReceiptsForProfile(names, profile),
	}
}

func providerReceiptsForProfile(names []provider.Name, profile activation.Profile) []activation.ProviderReceipt {
	plugins := map[activation.Profile][]string{
		activation.ProfileCore:   {"grilling", "self-improvement", "knowledge-maintenance", "adaptive-problem-solving"},
		activation.ProfileGitHub: {"grilling", "self-improvement", "knowledge-maintenance", "adaptive-problem-solving", "github-collaboration"},
		activation.ProfileTeam:   {"grilling", "self-improvement", "knowledge-maintenance", "adaptive-problem-solving", "github-collaboration", "orchestrated-collaboration"},
		activation.ProfileFull:   {"grilling", "self-improvement", "knowledge-maintenance", "adaptive-problem-solving", "github-collaboration", "orchestrated-collaboration", "resource-observability"},
	}[profile]
	receipts := make([]activation.ProviderReceipt, 0, len(names))
	for _, name := range names {
		receipts = append(receipts, activation.ProviderReceipt{Name: name, SelectedPlugins: append([]string(nil), plugins...)})
	}
	return receipts
}

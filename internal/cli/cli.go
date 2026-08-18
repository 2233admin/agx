package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/bundle"
	"github.com/2233admin/agx/internal/contracts"
	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/project"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
	"github.com/2233admin/agx/internal/smoke"
)

type command struct {
	name        string
	description string
}

var lifecycleCommands = []command{
	{name: "plan", description: "Show a side-effect-free Installation Plan"},
	{name: "apply", description: "Install pinned Bundle assets"},
	{name: "init", description: "Plan or apply repositories, Project, and provider activation"},
	{name: "status", description: "Show the observed Installation state"},
	{name: "diagnose", description: "Explain deployment evidence and next recovery steps"},
	{name: "uninstall", description: "Remove AGX-owned Installation resources"},
}

type runtimeDependencies struct {
	stdin            io.Reader
	providerRunner   provider.Runner
	repositoryRunner repository.Runner
	initPlan         func(context.Context, activation.Options) (activation.InitializationPlan, error)
	goos             string
}

func Run(args []string, version string, stdout, stderr io.Writer) int {
	return runWithDependencies(args, version, stdout, stderr, runtimeDependencies{stdin: os.Stdin, goos: runtime.GOOS})
}

func runWithDependencies(args []string, version string, stdout, stderr io.Writer, dependencies runtimeDependencies) int {
	if dependencies.stdin == nil {
		dependencies.stdin = os.Stdin
	}
	if dependencies.goos == "" {
		dependencies.goos = runtime.GOOS
	}
	if len(args) == 0 || isHelp(args[0]) {
		if len(args) > 1 {
			return showCommandHelp(args[1], stdout, stderr)
		}
		printGlobalHelp(stdout)
		return exitcode.Success
	}

	commandName := args[0]
	if len(args) > 1 && isHelp(args[1]) {
		return showCommandHelp(commandName, stdout, stderr)
	}

	switch commandName {
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "agx %s\n", version)
		return exitcode.Success
	case "mascot":
		fmt.Fprint(stdout, mascotText)
		return exitcode.Success
	case "plan":
		return runPlan(args[1:], stdout, stderr)
	case "apply":
		return runApply(args[1:], stdout, stderr)
	case "init":
		return runInit(args[1:], stdout, stderr, dependencies)
	case "status":
		return runStatus(args[1:], stdout, stderr, dependencies)
	case "uninstall":
		return runUninstall(args[1:], stdout, stderr)
	case "task", "tasks":
		fmt.Fprintln(stderr, "AGX-UNSUPPORTED-TASK: AGX does not create, assign, or schedule daily Tasks")
		return exitcode.Unsupported
	case "verify", "resume", "support-bundle", "upgrade", "rollback":
		fmt.Fprintf(stderr, "AGX-UNSUPPORTED-COMMAND: %q is outside the AGX 0.1 deployment surface\n", commandName)
		return exitcode.Unsupported
	case "diagnose":
		return runDiagnose(args[1:], stdout, stderr, dependencies)
	}

	if knownLifecycleCommand(commandName) {
		fmt.Fprintf(stderr, "AGX-UNSUPPORTED-COMMAND: %q is not implemented in this preview\n", commandName)
		return exitcode.Unsupported
	}

	fmt.Fprintf(stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", commandName)
	return exitcode.Software
}

func runInit(args []string, stdout, stderr io.Writer, dependencies runtimeDependencies) int {
	values, err := parseNamedOptions(args, map[string]bool{
		"--root": true, "--github-owner": true, "--provider": true, "--profile": true,
		"--visibility": true, "--control-repo": true, "--contracts-repo": true,
		"--output": true, "--apply": false, "--guided": false,
	})
	if containsOption(args, "--guided") {
		return runGuidedInit(args, values, stdout, stderr, dependencies)
	}
	if err != nil || values["--root"] == "" || values["--github-owner"] == "" || values["--provider"] == "" ||
		(values["--output"] != "" && values["--output"] != "json" && values["--output"] != "human") {
		printInitUsage(stderr)
		return exitcode.Usage
	}
	profileName := values["--profile"]
	if profileName == "" {
		profileName = string(activation.ProfileCore)
	}
	profile, err := activation.ParseProfile(profileName)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Usage
	}
	providers, err := parseProviders(values["--provider"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Usage
	}
	visibility := repository.VisibilityPrivate
	if values["--visibility"] != "" {
		visibility = repository.Visibility(strings.ToLower(values["--visibility"]))
		if visibility != repository.VisibilityPrivate && visibility != repository.VisibilityPublic {
			fmt.Fprintln(stderr, "AGX-INIT-VISIBILITY: --visibility must be private or public")
			return exitcode.Usage
		}
	}
	options := activation.Options{
		Root:                values["--root"],
		GitHubOwner:         values["--github-owner"],
		ControlRepository:   values["--control-repo"],
		ContractsRepository: values["--contracts-repo"],
		Visibility:          visibility,
		Profile:             profile,
		Providers:           providers,
	}
	if dependencies.providerRunner != nil {
		options.Runner = dependencies.providerRunner
	}
	if dependencies.repositoryRunner != nil {
		options.RepositoryRunner = dependencies.repositoryRunner
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if values["--apply"] == "" {
		planFunc := dependencies.initPlan
		if planFunc == nil {
			planFunc = activation.Plan
		}
		plan, err := planFunc(ctx, options)
		if err != nil {
			printInitError(stderr, err, values["--output"])
			return exitcode.Software
		}
		if values["--output"] == "json" {
			data, marshalErr := json.Marshal(newInitPlanResult(plan))
			if marshalErr != nil {
				fmt.Fprintln(stderr, "AGX-INIT-PLAN-ENCODE: cannot encode initialization plan")
				return exitcode.Software
			}
			fmt.Fprintln(stdout, string(data))
			return exitcode.Success
		}
		printInitializationPlan(stdout, plan, formatInitCommand(args, true))
		return exitcode.Success
	}

	receipt, unchanged, err := activation.Initialize(ctx, options)
	if err != nil {
		if receipt.SchemaVersion != "" {
			if values["--output"] == "json" {
				data, marshalErr := json.Marshal(struct {
					Status  string             `json:"status"`
					Error   string             `json:"error"`
					Receipt activation.Receipt `json:"receipt"`
				}{Status: receipt.Phase, Error: err.Error(), Receipt: receipt})
				if marshalErr == nil {
					fmt.Fprintln(stdout, string(data))
				}
			} else {
				printInitRecovery(stdout, receipt, args)
			}
		}
		printInitError(stderr, err, values["--output"])
		return exitcode.Software
	}
	if values["--output"] == "json" {
		result := newInitResult(receipt, unchanged)
		data, _ := json.Marshal(result)
		fmt.Fprintln(stdout, string(data))
		return exitcode.Success
	}
	if unchanged {
		fmt.Fprintf(stdout, "AGX Installation %s is already initialized for profile %s; no changes made.\n", receipt.InstallationID, receipt.Profile)
	} else {
		fmt.Fprintf(stdout, "AGX Installation %s initialized for profile %s.\n", receipt.InstallationID, receipt.Profile)
	}
	fmt.Fprintln(stdout, "Installation phase remains configured; provider activation is not verified.")
	printInitializedRepositories(stdout, receipt.Repositories)
	printFirstUse(stdout, receipt)
	return exitcode.Success
}

func containsOption(args []string, option string) bool {
	for _, arg := range args {
		if arg == option {
			return true
		}
	}
	return false
}

type initPlanResult struct {
	Mode              string                        `json:"mode"`
	MutationPerformed bool                          `json:"mutation_performed"`
	Plan              activation.InitializationPlan `json:"plan"`
}

func newInitPlanResult(plan activation.InitializationPlan) initPlanResult {
	return initPlanResult{Mode: "plan", MutationPerformed: false, Plan: plan}
}

func printInitUsage(output io.Writer) {
	fmt.Fprintln(output, "AGX-USAGE-INIT: --guided --root <directory> OR --root <directory> --github-owner <owner> --provider codex|claude|both [--profile core|github|team|full] [--visibility private|public] [--control-repo <name>] [--contracts-repo <name>] [--apply] [--output human|json]")
	fmt.Fprintln(output, "Prerequisites: git, an authenticated GitHub CLI (gh) with project scope, and every selected provider CLI must be on PATH.")
	fmt.Fprintln(output, "Defaults: explicit init uses --profile core; guided init suggests profile github. Both default to --visibility private, --control-repo agent-control, --contracts-repo agent-contracts.")
	fmt.Fprintln(output, "Order: agx apply, agx init --guided (or explicit init plan), then the same agx init command with --apply appended.")
	fmt.Fprintln(output, "Collision policy: AGX stops on same-name repositories or Projects; it never adopts or overwrites them.")
}

func printInitializationPlan(output io.Writer, plan activation.InitializationPlan, applyCommand ...string) {
	fmt.Fprintln(output, "AGX initialization plan (no changes made)")
	fmt.Fprintf(output, "Installation: %s\n", plan.InstallationID)
	fmt.Fprintf(output, "Plugin source: %s (installed by agx apply)\n", plan.PluginSource)
	fmt.Fprintf(output, "Template: %s (%s)\n", plan.TemplateVersion, plan.TemplateContentSHA256)
	fmt.Fprintln(output, "Deployment model: AGX keeps agent-plugins as the only installed source, then creates deployment-owned agent-control and agent-contracts repositories from clean templates.")
	fmt.Fprintln(output, "Repositories:")
	for _, item := range plan.Repositories {
		fmt.Fprintf(output, "  - %s %s/%s (%s; %s; template %s %s)\n", item.Action, item.Owner, item.Name, item.Visibility, item.Kind, item.TemplateVersion, item.TemplateDigest)
	}
	if plan.Project.Owner != "" {
		fmt.Fprintf(output, "Project %s: %q for %s (%s; link %s; retained on uninstall: %t)\n",
			plan.Project.Action, plan.Project.Title, plan.Project.Owner, plan.Project.Visibility,
			plan.Project.LinkedRepository, plan.Project.Retained)
	}
	fmt.Fprintln(output, "Providers:")
	for _, item := range plan.Providers {
		fmt.Fprintf(output, "  - %s: Marketplace %s", item.Name, item.MarketplaceAction)
		for _, plugin := range item.Plugins {
			fmt.Fprintf(output, "; %s %s", plugin.Name, plugin.Action)
		}
		fmt.Fprintln(output)
	}
	fmt.Fprintln(output, "Order with --apply: create and validate repositories, create/configure/link the Project, persist a recovery receipt after every mutation, then activate providers.")
	fmt.Fprintln(output, "Remote repositories and the Project are retained on uninstall; existing same-name resources stop before writes and are never adopted or overwritten.")
	if len(applyCommand) > 0 && applyCommand[0] != "" {
		fmt.Fprintf(output, "Next: run this %s command with the same arguments and --apply appended:\n", commandShellLabel())
		fmt.Fprintf(output, "  %s\n", applyCommand[0])
	} else {
		fmt.Fprintln(output, "Next: rerun the same agx init arguments with --apply appended and no other changes.")
	}
}

func formatInitCommand(args []string, appendApply bool) string {
	return formatInitCommandForPlatform(args, appendApply, runtime.GOOS)
}

func formatInitCommandForPlatform(args []string, appendApply bool, goos string) string {
	command := []string{"agx", "init"}
	command = append(command, args...)
	if appendApply {
		hasApply := false
		for _, item := range args {
			if item == "--apply" {
				hasApply = true
				break
			}
		}
		if !hasApply {
			command = append(command, "--apply")
		}
	}
	for index, item := range command {
		command[index] = quoteCommandArgForPlatform(item, goos)
	}
	return strings.Join(command, " ")
}

func quoteCommandArg(value string) string {
	return quoteCommandArgForPlatform(value, runtime.GOOS)
}

func quoteCommandArgForPlatform(value, goos string) string {
	if isSafeCommandArg(value, goos) {
		return value
	}
	if goos == "windows" {
		return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
	}
	return `'` + strings.ReplaceAll(value, `'`, `'"'"'`) + `'`
}

func isSafeCommandArg(value, goos string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' {
			continue
		}
		if strings.ContainsRune("_./-", character) {
			continue
		}
		if goos == "windows" && strings.ContainsRune(`:\`, character) {
			continue
		}
		if goos != "windows" && strings.ContainsRune("@%+=:,", character) {
			continue
		}
		return false
	}
	return true
}

func commandShellLabel() string {
	if runtime.GOOS == "windows" {
		return "PowerShell"
	}
	return "POSIX shell"
}

func printInitError(output io.Writer, err error, outputMode string) {
	fmt.Fprintln(output, err)
	if outputMode == "json" || err == nil {
		return
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "AGX-REPOSITORY-COLLISION"):
		fmt.Fprintln(output, "Next: choose unused names with --control-repo and --contracts-repo, then rerun the same init command. AGX will not adopt or overwrite same-name repositories.")
	case strings.Contains(message, "AGX-INIT-SOURCE-CONFLICT"):
		fmt.Fprintln(output, "Next: resolve the existing Marketplace source conflict in the selected provider, then rerun the same init command. AGX will not replace an existing source.")
	case strings.Contains(message, "AGX-REPOSITORY-AUTH"):
		fmt.Fprintln(output, "Next: run gh auth login, confirm access to the target owner with gh auth status, then rerun the same init command.")
	case strings.Contains(message, "AGX-REPOSITORY-CLI-MISSING"):
		fmt.Fprintln(output, "Next: install git and GitHub CLI (gh), ensure both are on PATH, authenticate gh, then rerun the same init command.")
	case strings.Contains(message, "AGX-INIT-PROVIDER-CLI-MISSING"):
		fmt.Fprintln(output, "Next: install every selected provider CLI (codex and/or claude), ensure it is on PATH, then rerun the same init command.")
	case strings.Contains(message, "AGX-GUIDED-PROVIDER"):
		fmt.Fprintln(output, "Next: install or repair at least one provider CLI (codex or claude), resolve any Marketplace source conflicts, then rerun agx init --guided --root <directory>.")
	}
}

func printInitializedRepositories(output io.Writer, repositories []repository.Receipt) {
	if len(repositories) == 0 {
		return
	}
	fmt.Fprintln(output, "Initialized GitHub repositories (retained on uninstall):")
	for _, item := range repositories {
		fmt.Fprintf(output, "  - %s (%s; initial commit %s)\n", item.URL, item.Visibility, item.InitialCommit)
	}
}

func printInitRecovery(output io.Writer, receipt activation.Receipt, args []string) {
	fmt.Fprintf(output, "Initialization stopped in phase %s. AGX retained its recovery receipt.\n", receipt.Phase)
	printInitializedRepositories(output, receipt.Repositories)
	fmt.Fprintln(output, "There is no separate resume command.")
	fmt.Fprintf(output, "Next: resolve the reported problem, then run this %s command again with the same arguments:\n", commandShellLabel())
	fmt.Fprintf(output, "  %s\n", formatInitCommand(args, false))
}

type initResult struct {
	Status            string                       `json:"status"`
	Unchanged         bool                         `json:"unchanged"`
	InstallationID    string                       `json:"installation_id"`
	Profile           activation.Profile           `json:"profile"`
	Providers         []activation.ProviderReceipt `json:"providers"`
	Repositories      []repository.Receipt         `json:"repositories"`
	Project           *project.Receipt             `json:"project,omitempty"`
	TemplateVersion   string                       `json:"template_version"`
	TemplateDigest    string                       `json:"template_content_sha256"`
	InstallationPhase string                       `json:"installation_phase"`
	FirstUse          []firstUsePrompt             `json:"first_use"`
	FirstUseContract  smoke.Contract               `json:"first_use_contract"`
}

type firstUsePrompt struct {
	Provider provider.Name `json:"provider"`
	Prompt   string        `json:"prompt"`
}

func newInitResult(receipt activation.Receipt, unchanged bool) initResult {
	contract, _ := activation.FirstUseContract(receipt)
	return initResult{
		Status:            receipt.Phase,
		Unchanged:         unchanged,
		InstallationID:    receipt.InstallationID,
		Profile:           receipt.Profile,
		Providers:         receipt.Providers,
		Repositories:      receipt.Repositories,
		Project:           receipt.Project,
		TemplateVersion:   receipt.TemplateVersion,
		TemplateDigest:    receipt.TemplateContentSHA256,
		InstallationPhase: "configured",
		FirstUse:          firstUsePrompts(receipt),
		FirstUseContract:  contract,
	}
}

func parseProviders(value string) ([]provider.Name, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "codex":
		return []provider.Name{provider.Codex}, nil
	case "claude":
		return []provider.Name{provider.Claude}, nil
	case "both":
		return []provider.Name{provider.Codex, provider.Claude}, nil
	default:
		return nil, fmt.Errorf("AGX-INIT-PROVIDER: unsupported provider %q", value)
	}
}

func printFirstUse(stdout io.Writer, receipt activation.Receipt) {
	contract, err := activation.FirstUseContract(receipt)
	if err != nil {
		fmt.Fprintf(stdout, "First-use contract unavailable: %v\n", err)
		return
	}
	payload, err := json.Marshal(contract)
	if err != nil {
		fmt.Fprintln(stdout, "First-use contract unavailable: cannot encode contract")
		return
	}
	fmt.Fprintf(stdout, "GitHub Project: %s\n", contract.ProjectURL)
	fmt.Fprintf(stdout, "First-use contract: %s\n", contract.SchemaVersion)
	fmt.Fprintf(stdout, "  %s\n", payload)
	fmt.Fprintln(stdout, "Start a new Agent session and run one matching prompt:")
	for _, item := range firstUsePrompts(receipt) {
		fmt.Fprintf(stdout, "  %-7s %s\n", providerDisplayName(item.Provider)+":", item.Prompt)
	}
	fmt.Fprintln(stdout, "After the Agent opens the Issue and PR, rerun agx status to read Project, Project item, PR, and validation evidence.")
}

func firstUsePrompts(receipt activation.Receipt) []firstUsePrompt {
	contract, err := activation.FirstUseContract(receipt)
	if err != nil {
		return nil
	}
	payload, err := json.Marshal(contract)
	if err != nil {
		return nil
	}
	prompts := make([]firstUsePrompt, 0, len(receipt.Providers))
	for _, item := range receipt.Providers {
		invocation := ""
		switch item.Name {
		case provider.Codex:
			invocation = "$grilling:grilling"
		case provider.Claude:
			invocation = "/grilling:grilling"
		}
		if invocation != "" {
			prompts = append(prompts, firstUsePrompt{
				Provider: item.Name,
				Prompt:   invocation + " 请严格按以下 " + smoke.ContractVersionV1 + " 合同完成 Bootstrap Verification：" + string(payload),
			})
		}
	}
	return prompts
}

func providerDisplayName(name provider.Name) string {
	switch name {
	case provider.Codex:
		return "Codex"
	case provider.Claude:
		return "Claude"
	default:
		return string(name)
	}
}

func runApply(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--bundle": true, "--root": true})
	_, bundleProvided := values["--bundle"]
	if err != nil || values["--root"] == "" || (bundleProvided && values["--bundle"] == "") {
		fmt.Fprintln(stderr, "AGX-USAGE-APPLY: --root <directory> is required. Without --bundle, AGX uses its built-in production Bundle; --bundle <bundle.json> explicitly overrides it. These Bundle sources cannot be combined.")
		return exitcode.Usage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, unchanged, err := installer.Apply(ctx, newApplyOptions(values["--root"], values["--bundle"]))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	if unchanged {
		fmt.Fprintf(stdout, "AGX installation %s already configured (Bundle %s); no changes made.\n", receipt.InstallationID, receipt.BundleID)
	} else {
		fmt.Fprintf(stdout, "AGX installation %s configured from Bundle %s.\n", receipt.InstallationID, receipt.BundleID)
	}
	printApplyNextStep(stdout, values["--root"])
	return exitcode.Success
}

func newApplyOptions(root, bundlePath string) installer.Options {
	if bundlePath != "" {
		return installer.Options{BundlePath: bundlePath, Root: root}
	}
	return installer.Options{BundleData: bundle.Production(), Root: root}
}

func printApplyNextStep(stdout io.Writer, root ...string) {
	rootValue := quoteCommandArg("<directory>")
	if len(root) > 0 && strings.TrimSpace(root[0]) != "" {
		rootValue = quoteCommandArg(root[0])
	}
	fmt.Fprintf(stdout, "Next: run the guided initialization preview with this %s command. It discovers gh identity, usable provider CLIs, source conflicts, repositories, and prints an exact apply command:\n", commandShellLabel())
	fmt.Fprintf(stdout, "  agx init --guided --root %s\n", rootValue)
	fmt.Fprintln(stdout, "Automation can keep using explicit agx init --root ... --github-owner ... --provider ... followed by the same command with --apply.")
	fmt.Fprintln(stdout, "Installation phase is configured; initialization does not claim verified.")
}

func runStatus(args []string, stdout, stderr io.Writer, dependencies runtimeDependencies) int {
	values, err := parseNamedOptions(args, map[string]bool{"--root": true, "--output": true})
	if err != nil || values["--root"] == "" || (values["--output"] != "" && values["--output"] != "json" && values["--output"] != "human") {
		fmt.Fprintln(stderr, "AGX-USAGE-STATUS: --root <directory> [--output human|json]")
		return exitcode.Usage
	}
	state, err := installer.Status(values["--root"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Data
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	initialization, initializationErr := activation.Status(ctx, values["--root"], dependencies.providerRunner, dependencies.repositoryRunner)
	if initializationErr != nil {
		fmt.Fprintln(stderr, initializationErr)
		return exitcode.Data
	}
	if values["--output"] == "json" {
		result := struct {
			Phase          string           `json:"phase"`
			InstallationID string           `json:"installation_id,omitempty"`
			BundleID       string           `json:"bundle_id,omitempty"`
			Missing        []string         `json:"missing,omitempty"`
			Modified       []string         `json:"modified,omitempty"`
			Initialization activation.State `json:"initialization"`
		}{Phase: state.Phase, Missing: state.Missing, Modified: state.Modified, Initialization: initialization}
		if state.Receipt != nil {
			result.InstallationID = state.Receipt.InstallationID
			result.BundleID = state.Receipt.BundleID
		}
		data, _ := json.Marshal(result)
		fmt.Fprintln(stdout, string(data))
		return exitcode.Success
	}
	fmt.Fprintf(stdout, "AGX installation phase: %s\n", state.Phase)
	if state.Receipt != nil {
		fmt.Fprintf(stdout, "Installation: %s\nBundle: %s\n", state.Receipt.InstallationID, state.Receipt.BundleID)
	}
	for _, missing := range state.Missing {
		fmt.Fprintf(stdout, "Missing owned file: %s\n", missing)
	}
	for _, modified := range state.Modified {
		fmt.Fprintf(stdout, "Modified owned file: %s\n", modified)
	}
	fmt.Fprintf(stdout, "Provider initialization: %s\n", initialization.Status)
	if initialization.Profile != "" {
		fmt.Fprintf(stdout, "Initialization profile: %s\n", initialization.Profile)
	}
	printDeploymentVisibility(stdout, initialization)
	for _, problem := range initialization.Problems {
		fmt.Fprintf(stdout, "Initialization problem: %s\n", problem)
	}
	printStatusNext(stdout, values["--root"], state.Phase, state.Missing, state.Modified, initialization)
	return exitcode.Success
}

func printDeploymentVisibility(output io.Writer, state activation.State) {
	for _, deployedRepository := range state.RepositoryDetails {
		evidence := "readback matched"
		if deployedRepository.Verification == repository.VerificationUncertain {
			evidence = "readback uncertain"
		}
		fmt.Fprintf(output, "Deployment repository: %s (%s; template digest %s; %s)\n",
			deployedRepository.URL, deployedRepository.NameWithOwner, deployedRepository.TemplateDigest, evidence)
	}
	if len(state.RepositoryDetails) == 0 {
		for _, deployedRepository := range state.Repositories {
			fmt.Fprintf(output, "Deployment repository: %s\n", deployedRepository)
		}
	}
	if state.Project != nil {
		fmt.Fprintf(output, "GitHub Project: %s (%s; linked repository %s)\n",
			state.Project.URL, state.Project.Visibility, state.Project.LinkedRepository)
	}
	if state.Smoke.Status != "" {
		fmt.Fprintf(output, "Agent smoke: %s\n", state.Smoke.Status)
		if state.Smoke.IssueURL != "" {
			fmt.Fprintf(output, "Bootstrap Issue: %s\n", state.Smoke.IssueURL)
		}
		if state.Smoke.ProjectItem != "" {
			fmt.Fprintf(output, "Project item: %s\n", state.Smoke.ProjectItem)
		}
		if state.Smoke.PullRequestURL != "" {
			fmt.Fprintf(output, "Bootstrap PR: %s\n", state.Smoke.PullRequestURL)
		}
		if state.Smoke.WorkPointer != "" {
			fmt.Fprintf(output, "Work pointer: %s\n", state.Smoke.WorkPointer)
		}
		if state.Smoke.ValidationResult != "" {
			fmt.Fprintf(output, "Template validation: %s\n", state.Smoke.ValidationResult)
		}
		for _, problem := range state.Smoke.Problems {
			fmt.Fprintf(output, "Agent smoke pending: %s\n", problem)
		}
	}
}

func runDiagnose(args []string, stdout, stderr io.Writer, dependencies runtimeDependencies) int {
	values, err := parseNamedOptions(args, map[string]bool{"--root": true, "--output": true})
	if err != nil || values["--root"] == "" || (values["--output"] != "" && values["--output"] != "json" && values["--output"] != "human") {
		fmt.Fprintln(stderr, "AGX-USAGE-DIAGNOSE: --root <directory> [--output human|json]")
		return exitcode.Usage
	}
	installation, err := installer.Status(values["--root"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Data
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	initialization, initializationErr := activation.Status(ctx, values["--root"], dependencies.providerRunner, dependencies.repositoryRunner)
	if initializationErr != nil {
		fmt.Fprintln(stderr, initializationErr)
		return exitcode.Data
	}
	result := struct {
		Installation   installer.State  `json:"installation"`
		Initialization activation.State `json:"initialization"`
		Next           []string         `json:"next_steps,omitempty"`
	}{Installation: installation, Initialization: initialization}
	result.Next = diagnoseNextSteps(values["--root"], installation, initialization)
	if values["--output"] == "json" {
		data, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			fmt.Fprintln(stderr, "AGX-DIAGNOSE-ENCODE: cannot encode diagnostic result")
			return exitcode.Software
		}
		fmt.Fprintln(stdout, string(data))
		return exitcode.Success
	}
	fmt.Fprintln(stdout, "AGX diagnosis (read-only)")
	fmt.Fprintf(stdout, "Installation phase: %s\n", installation.Phase)
	if installation.Receipt != nil {
		fmt.Fprintf(stdout, "Bundle: %s\n", installation.Receipt.BundleID)
	}
	fmt.Fprintf(stdout, "Initialization: %s\n", initialization.Status)
	printDeploymentVisibility(stdout, initialization)
	for _, problem := range initialization.Problems {
		fmt.Fprintf(stdout, "Problem: %s\n", problem)
	}
	for _, next := range result.Next {
		fmt.Fprintf(stdout, "Next: %s\n", next)
	}
	return exitcode.Success
}

func diagnoseNextSteps(root string, installation installer.State, initialization activation.State) []string {
	var next []string
	if installation.Phase == "absent" {
		return []string{"run agx apply --root " + quoteCommandArg(root)}
	}
	if installation.Phase == "drifted" {
		next = append(next, "repair the listed missing or modified AGX-owned files")
	}
	if initialization.Status == activation.StatusAbsent {
		next = append(next, "run agx init --guided --root "+quoteCommandArg(root)+" for a guided, read-only preview")
	}
	if initialization.Status == activation.PhaseNeedsResume || initialization.Status == activation.PhaseProvisioning {
		next = append(next, "resolve the initialization problem and rerun the original agx init ... --apply command unchanged")
	}
	if initialization.Smoke.Status == smoke.StatusAwaiting {
		next = append(next, "run one first-use Agent prompt from the initialization result, then run agx status --root "+quoteCommandArg(root))
	}
	return next
}

func printStatusNext(output io.Writer, root, installationPhase string, missing, modified []string, initialization activation.State) {
	statusCommand := "agx status --root " + quoteCommandArg(root)
	if installationPhase == "drifted" || initialization.Status == activation.StatusDrifted {
		if len(missing) > 0 || len(modified) > 0 {
			fmt.Fprintln(output, "Next: repair every missing or modified owned file listed above.")
		}
		if len(initialization.Problems) > 0 {
			fmt.Fprintln(output, "Next: resolve every initialization problem listed above.")
		}
		fmt.Fprintf(output, "Then rerun this %s command: %s\n", commandShellLabel(), statusCommand)
		return
	}
	if installationPhase == "configured" && initialization.Status == activation.StatusAbsent {
		fmt.Fprintf(output, "Next: preview initialization with this %s guided command (no changes are made):\n", commandShellLabel())
		fmt.Fprintf(output, "  agx init --guided --root %s\n", quoteCommandArg(root))
		return
	}
	if initialization.Status == activation.PhaseNeedsResume || initialization.Status == activation.PhaseProvisioning {
		fmt.Fprintln(output, "Next: there is no separate resume command. Resolve the initialization problem, then rerun the original agx init ... --apply command unchanged.")
		return
	}
	if initialization.Smoke.Status == smoke.StatusAwaiting {
		fmt.Fprintln(output, "Next: start a new Agent session and run one first-use prompt emitted by agx init.")
		fmt.Fprintf(output, "Then rerun this %s command: %s\n", commandShellLabel(), statusCommand)
	}
}

func runUninstall(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--root": true, "--output": true})
	if err != nil || values["--root"] == "" || (values["--output"] != "" && values["--output"] != "human" && values["--output"] != "json") {
		fmt.Fprintln(stderr, "AGX-USAGE-UNINSTALL: --root <directory> [--output human|json]")
		return exitcode.Usage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	initialization, err := activation.UninitializeDetailed(ctx, values["--root"], nil)
	if err != nil {
		if values["--output"] == "json" {
			data, marshalErr := json.Marshal(struct {
				Status         string                        `json:"status"`
				Error          string                        `json:"error"`
				Initialization activation.UninitializeResult `json:"initialization"`
			}{Status: "blocked", Error: err.Error(), Initialization: initialization})
			if marshalErr == nil {
				fmt.Fprintln(stdout, string(data))
			}
		} else if len(initialization.RetainedRepositories) > 0 {
			fmt.Fprintln(stdout, "Uninstall stopped; deployment repositories remain retained:")
			for _, item := range initialization.RetainedRepositories {
				fmt.Fprintf(stdout, "  - %s\n", item.URL)
			}
			if initialization.RetainedProject != nil {
				fmt.Fprintf(stdout, "Retained GitHub Project: %s\n", initialization.RetainedProject.URL)
			}
		}
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	retained, err := installer.Uninstall(values["--root"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	if values["--output"] == "json" {
		data, marshalErr := json.Marshal(struct {
			Status               string                        `json:"status"`
			Initialization       activation.UninitializeResult `json:"initialization"`
			RetainedUnknownPaths []string                      `json:"retained_unknown_paths"`
		}{Status: "uninstalled", Initialization: initialization, RetainedUnknownPaths: retained})
		if marshalErr != nil {
			fmt.Fprintln(stderr, "AGX-UNINSTALL-ENCODE: cannot encode uninstall result")
			return exitcode.Software
		}
		fmt.Fprintln(stdout, string(data))
		return exitcode.Success
	}
	if len(retained) == 0 {
		if initialization.Changed {
			fmt.Fprintln(stdout, "AGX-owned provider activation removed.")
		}
		fmt.Fprintln(stdout, "AGX-owned installation removed.")
	} else {
		fmt.Fprintf(stdout, "AGX-owned files removed; retained %d unknown path(s):\n", len(retained))
		for _, item := range retained {
			fmt.Fprintf(stdout, "  %s\n", item)
		}
	}
	if len(initialization.RetainedRepositories) > 0 {
		fmt.Fprintln(stdout, "Retained deployment repositories (AGX never deletes remote repositories):")
		for _, item := range initialization.RetainedRepositories {
			fmt.Fprintf(stdout, "  - %s\n", item.URL)
		}
	}
	if initialization.RetainedProject != nil {
		fmt.Fprintln(stdout, "Retained GitHub Project (AGX never deletes it during uninstall):")
		fmt.Fprintf(stdout, "  - %s\n", initialization.RetainedProject.URL)
	}
	return exitcode.Success
}

func parseNamedOptions(args []string, allowed map[string]bool) (map[string]string, error) {
	values := map[string]string{}
	seen := map[string]bool{}
	for index := 0; index < len(args); index++ {
		name := args[index]
		requiresValue, known := allowed[name]
		if !known || seen[name] {
			return nil, fmt.Errorf("invalid option %q", name)
		}
		seen[name] = true
		if !requiresValue {
			values[name] = "true"
			continue
		}
		if index+1 >= len(args) {
			return nil, fmt.Errorf("option %q requires a value", name)
		}
		index++
		values[name] = args[index]
	}
	return values, nil
}

type planOptions struct {
	contractPath string
	output       string
}

func runPlan(args []string, stdout, stderr io.Writer) int {
	options, err := parsePlanOptions(args)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-USAGE-PLAN: %v\n", err)
		return exitcode.Usage
	}
	data, err := os.ReadFile(options.contractPath)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-CONTRACT-READ: cannot read %q: %v\n", options.contractPath, err)
		return exitcode.Data
	}
	document, err := contracts.Decode(data)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-CONTRACT-INVALID: %v\n", err)
		return exitcode.Data
	}

	if options.output == "json" {
		encoded, err := contracts.Encode(document)
		if err != nil {
			fmt.Fprintf(stderr, "AGX-CONTRACT-INVALID: %v\n", err)
			return exitcode.Data
		}
		fmt.Fprintln(stdout, string(encoded))
		return exitcode.Success
	}

	renderPlan(document, stdout)
	return exitcode.Success
}

func parsePlanOptions(args []string) (planOptions, error) {
	options := planOptions{output: "human"}
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--contract":
			if index+1 == len(args) || options.contractPath != "" {
				return planOptions{}, fmt.Errorf("provide exactly one --contract <path>")
			}
			index++
			options.contractPath = args[index]
		case "--output":
			if index+1 == len(args) {
				return planOptions{}, fmt.Errorf("--output requires human or json")
			}
			index++
			options.output = args[index]
			if options.output != "human" && options.output != "json" {
				return planOptions{}, fmt.Errorf("--output must be human or json")
			}
		default:
			return planOptions{}, fmt.Errorf("unknown plan option %q", args[index])
		}
	}
	if options.contractPath == "" {
		return planOptions{}, fmt.Errorf("--contract <path> is required")
	}
	return options, nil
}

func renderPlan(document contracts.Document, stdout io.Writer) {
	desired := document.Contract.Desired
	plan := document.Contract.Plan

	fmt.Fprintln(stdout, "AGX Installation Plan")
	fmt.Fprintln(stdout, "")
	fmt.Fprintf(stdout, "Installation: %s\n", desired.InstallationID)
	fmt.Fprintf(stdout, "Bundle: %s\n", desired.BundleID)
	fmt.Fprintf(stdout, "Desired hash: %s\n", desired.DesiredHash)
	fmt.Fprintln(stdout, "Steps:")
	if len(plan.Steps) == 0 {
		fmt.Fprintln(stdout, "  (none)")
	}
	for _, step := range plan.Steps {
		fmt.Fprintf(stdout, "  - %s: %s (risk: %s; compensation: %s)\n", step.ID, step.Kind, step.Risk, step.Compensation)
	}
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "No external system is contacted and no contract file is changed.")
}

func printGlobalHelp(stdout io.Writer) {
	fmt.Fprintln(stdout, "AGXCLI — installation and lifecycle CLI")
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Usage:")
	fmt.Fprintln(stdout, "  agx <command>")
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Available now:")
	fmt.Fprintln(stdout, "  help       Show command help")
	fmt.Fprintln(stdout, "  version    Show the build version")
	fmt.Fprintln(stdout, "  mascot     Show the terminal-safe AGX OC identity")
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Lifecycle commands:")
	for _, command := range lifecycleCommands {
		fmt.Fprintf(stdout, "  %-15s %s\n", command.name, command.description)
	}
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "AGX does not create, assign, or schedule daily Tasks.")
}

func showCommandHelp(commandName string, stdout, stderr io.Writer) int {
	if commandName == "version" {
		fmt.Fprintln(stdout, "Usage: agx version")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Print the build version. No external system is contacted.")
		return exitcode.Success
	}
	if commandName == "mascot" {
		fmt.Fprintln(stdout, "Usage: agx mascot")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Print the terminal-safe AGX identity. No external system is contacted.")
		return exitcode.Success
	}
	switch commandName {
	case "apply":
		fmt.Fprintln(stdout, "Usage: agx apply --root <directory> [--bundle <bundle.json>]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Download, verify, and atomically install the built-in production Bundle. Use --bundle only to explicitly override it with a local Bundle file.")
		return exitcode.Success
	case "init":
		fmt.Fprintln(stdout, "Usage: agx init --guided --root <directory>")
		fmt.Fprintln(stdout, "   or: agx init --root <directory> --github-owner <owner> --provider codex|claude|both [--profile core|github|team|full] [--visibility private|public] [--control-repo <name>] [--contracts-repo <name>] [--apply] [--output human|json]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Preview a side-effect-free initialization plan. Use --guided for first run discovery and confirmation; add --apply only to create deployment repositories, link a GitHub Project, and activate the pinned agent-plugins component.")
		fmt.Fprintln(stdout, "Ownership is recorded for safe uninstall and recovery; remote repositories and the Project are always retained.")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Prerequisites:")
		fmt.Fprintln(stdout, "  - git and GitHub CLI (gh) are on PATH; gh is authenticated, has project scope, and can create repositories and a Project for <owner>.")
		fmt.Fprintln(stdout, "  - Every selected provider CLI (codex and/or claude) is on PATH.")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Defaults:")
		fmt.Fprintln(stdout, "  - explicit init profile: core")
		fmt.Fprintln(stdout, "  - guided init suggested profile: github")
		fmt.Fprintln(stdout, "  - visibility: private")
		fmt.Fprintln(stdout, "  - repositories: agent-control and agent-contracts")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Repository model:")
		fmt.Fprintln(stdout, "  - 2233admin/agx: the installer and lifecycle CLI.")
		fmt.Fprintln(stdout, "  - zaurakworks/agent-plugins: the only installed Plugin source.")
		fmt.Fprintln(stdout, "  - <owner>/agent-control: deployment-owned control-state repository created from template.")
		fmt.Fprintln(stdout, "  - <owner>/agent-contracts: deployment-owned contract repository created from template.")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "First deployment order:")
		fmt.Fprintln(stdout, "  agx apply --root '<new-install-dir>'")
		fmt.Fprintln(stdout, "  agx init --guided --root '<new-install-dir>'")
		fmt.Fprintln(stdout, "  agx init --root '<new-install-dir>' --github-owner '<owner>' --provider '<recommended>' --profile github --apply")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "A same-name repository is a collision: AGX stops before writes and never adopts or overwrites it. The same rule applies to the deployment Project.")
		return exitcode.Success
	case "status":
		fmt.Fprintln(stdout, "Usage: agx status --root <directory> [--output human|json]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Read the local receipt and detect missing AGX-owned files without writing.")
		return exitcode.Success
	case "diagnose":
		fmt.Fprintln(stdout, "Usage: agx diagnose --root <directory> [--output human|json]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Read-only diagnostics for installation integrity, Project/repository evidence, Agent smoke, and next steps.")
		return exitcode.Success
	case "uninstall":
		fmt.Fprintln(stdout, "Usage: agx uninstall --root <directory> [--output human|json]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Reverse AGX-owned provider activation, then remove AGX-owned files while retaining remote repositories, the GitHub Project, and unknown files.")
		return exitcode.Success
	}
	if command, ok := lookupLifecycleCommand(commandName); ok {
		fmt.Fprintf(stdout, "Usage: agx %s [options]\n", command.name)
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, command.description+".")
		fmt.Fprintln(stdout, "Status: unavailable in this preview. No external system is contacted.")
		return exitcode.Success
	}
	if commandName == "task" || commandName == "tasks" {
		fmt.Fprintln(stdout, "AGX does not create, assign, or schedule daily Tasks.")
		return exitcode.Success
	}
	fmt.Fprintf(stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", commandName)
	return exitcode.Software
}

func isHelp(value string) bool {
	return value == "help" || value == "--help" || value == "-h"
}

func knownLifecycleCommand(name string) bool {
	_, ok := lookupLifecycleCommand(name)
	return ok
}

func lookupLifecycleCommand(name string) (command, bool) {
	for _, command := range lifecycleCommands {
		if strings.EqualFold(command.name, name) {
			return command, true
		}
	}
	return command{}, false
}

const mascotText = ` /\_/\\
( o.o )  AGXCLI coordination console
 > ^ <   identity only; use command receipts for state
`

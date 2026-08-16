package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/contracts"
	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/provider"
)

type command struct {
	name        string
	description string
}

var lifecycleCommands = []command{
	{name: "plan", description: "Show a side-effect-free Installation Plan"},
	{name: "apply", description: "Install pinned Bundle assets"},
	{name: "init", description: "Activate an installed Bundle for Codex or Claude"},
	{name: "status", description: "Show the observed Installation state"},
	{name: "uninstall", description: "Remove AGX-owned Installation resources"},
}

func Run(args []string, version string, stdout, stderr io.Writer) int {
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
		return runInit(args[1:], stdout, stderr)
	case "status":
		return runStatus(args[1:], stdout, stderr)
	case "uninstall":
		return runUninstall(args[1:], stdout, stderr)
	case "task", "tasks":
		fmt.Fprintln(stderr, "AGX-UNSUPPORTED-TASK: AGX does not create, assign, or schedule daily Tasks")
		return exitcode.Unsupported
	case "verify", "resume", "diagnose", "support-bundle", "upgrade", "rollback":
		fmt.Fprintf(stderr, "AGX-UNSUPPORTED-COMMAND: %q is outside the AGX 0.1 deployment surface\n", commandName)
		return exitcode.Unsupported
	}

	if knownLifecycleCommand(commandName) {
		fmt.Fprintf(stderr, "AGX-UNSUPPORTED-COMMAND: %q is not implemented in this preview\n", commandName)
		return exitcode.Unsupported
	}

	fmt.Fprintf(stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", commandName)
	return exitcode.Software
}

func runInit(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--root": true, "--provider": true, "--profile": true, "--output": true})
	if err != nil || values["--root"] == "" || values["--provider"] == "" || (values["--output"] != "" && values["--output"] != "json" && values["--output"] != "human") {
		fmt.Fprintln(stderr, "AGX-USAGE-INIT: --root <directory> --provider codex|claude|both [--profile core|github|team|full] [--output human|json]")
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
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, unchanged, err := activation.Initialize(ctx, activation.Options{
		Root: values["--root"], Profile: profile, Providers: providers,
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
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
	printFirstUse(stdout, receipt)
	return exitcode.Success
}

type initResult struct {
	Status            string                       `json:"status"`
	Unchanged         bool                         `json:"unchanged"`
	InstallationID    string                       `json:"installation_id"`
	Profile           activation.Profile           `json:"profile"`
	Providers         []activation.ProviderReceipt `json:"providers"`
	InstallationPhase string                       `json:"installation_phase"`
	FirstUse          []firstUsePrompt             `json:"first_use"`
}

type firstUsePrompt struct {
	Provider provider.Name `json:"provider"`
	Prompt   string        `json:"prompt"`
}

func newInitResult(receipt activation.Receipt, unchanged bool) initResult {
	return initResult{
		Status:            receipt.Phase,
		Unchanged:         unchanged,
		InstallationID:    receipt.InstallationID,
		Profile:           receipt.Profile,
		Providers:         receipt.Providers,
		InstallationPhase: "configured",
		FirstUse:          firstUsePrompts(receipt),
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
	fmt.Fprintln(stdout, "Start a new provider session, then try:")
	for _, item := range firstUsePrompts(receipt) {
		fmt.Fprintf(stdout, "  %-7s %s\n", providerDisplayName(item.Provider)+":", item.Prompt)
	}
}

func firstUsePrompts(receipt activation.Receipt) []firstUsePrompt {
	seen := map[provider.Name]bool{}
	for _, item := range receipt.Providers {
		seen[item.Name] = true
	}
	prompts := make([]firstUsePrompt, 0, 6)
	if seen[provider.Codex] {
		prompts = append(prompts, firstUsePrompt{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"})
	}
	if seen[provider.Claude] {
		prompts = append(prompts, firstUsePrompt{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"})
	}
	if receipt.Profile == activation.ProfileGitHub || receipt.Profile == activation.ProfileTeam || receipt.Profile == activation.ProfileFull {
		if seen[provider.Codex] {
			prompts = append(prompts, firstUsePrompt{Provider: provider.Codex, Prompt: "$github-collaboration:issue-workflow 处理 GitHub Issue #123"})
		}
		if seen[provider.Claude] {
			prompts = append(prompts, firstUsePrompt{Provider: provider.Claude, Prompt: "/github-collaboration:issue-workflow 处理 GitHub Issue #123"})
		}
	}
	if receipt.Profile == activation.ProfileFull {
		if seen[provider.Codex] {
			prompts = append(prompts, firstUsePrompt{Provider: provider.Codex, Prompt: "$resource-observability:resource-observability 查看当前账户额度"})
		}
		if seen[provider.Claude] {
			prompts = append(prompts, firstUsePrompt{Provider: provider.Claude, Prompt: "/resource-observability:resource-observability 查看当前账户额度"})
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
	if err != nil || values["--bundle"] == "" || values["--root"] == "" {
		fmt.Fprintln(stderr, "AGX-USAGE-APPLY: --bundle <path> and --root <directory> are required")
		return exitcode.Usage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, unchanged, err := installer.Apply(ctx, installer.Options{BundlePath: values["--bundle"], Root: values["--root"]})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	if unchanged {
		fmt.Fprintf(stdout, "AGX installation %s already configured (Bundle %s); no changes made.\n", receipt.InstallationID, receipt.BundleID)
	} else {
		fmt.Fprintf(stdout, "AGX installation %s configured from Bundle %s.\n", receipt.InstallationID, receipt.BundleID)
	}
	printApplyNextStep(stdout)
	return exitcode.Success
}

func printApplyNextStep(stdout io.Writer) {
	fmt.Fprintln(stdout, "Next: initialize this root with agx init --root <directory> --provider codex|claude|both [--profile core|github|team|full].")
	fmt.Fprintln(stdout, "Installation phase is configured; initialization does not claim verified.")
}

func runStatus(args []string, stdout, stderr io.Writer) int {
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
	initialization, initializationErr := activation.Status(ctx, values["--root"], nil)
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
			Initialization activation.State `json:"initialization"`
		}{Phase: state.Phase, Missing: state.Missing, Initialization: initialization}
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
	fmt.Fprintf(stdout, "Provider initialization: %s\n", initialization.Status)
	if initialization.Profile != "" {
		fmt.Fprintf(stdout, "Initialization profile: %s\n", initialization.Profile)
	}
	for _, problem := range initialization.Problems {
		fmt.Fprintf(stdout, "Initialization problem: %s\n", problem)
	}
	return exitcode.Success
}

func runUninstall(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--root": true})
	if err != nil || values["--root"] == "" {
		fmt.Fprintln(stderr, "AGX-USAGE-UNINSTALL: --root <directory> is required")
		return exitcode.Usage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	providerRemoved, err := activation.Uninitialize(ctx, values["--root"], nil)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	retained, err := installer.Uninstall(values["--root"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	if len(retained) == 0 {
		if providerRemoved {
			fmt.Fprintln(stdout, "AGX-owned provider activation removed.")
		}
		fmt.Fprintln(stdout, "AGX-owned installation removed.")
		return exitcode.Success
	}
	fmt.Fprintf(stdout, "AGX-owned files removed; retained %d unknown path(s):\n", len(retained))
	for _, item := range retained {
		fmt.Fprintf(stdout, "  %s\n", item)
	}
	return exitcode.Success
}

func parseNamedOptions(args []string, allowed map[string]bool) (map[string]string, error) {
	values := map[string]string{}
	for index := 0; index < len(args); index++ {
		name := args[index]
		if !allowed[name] || values[name] != "" || index+1 >= len(args) {
			return nil, fmt.Errorf("invalid option %q", name)
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
		fmt.Fprintln(stdout, "Usage: agx apply --bundle <bundle.json> --root <directory>")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Download, verify, and atomically install pinned Bundle assets.")
		return exitcode.Success
	case "init":
		fmt.Fprintln(stdout, "Usage: agx init --root <directory> --provider codex|claude|both [--profile core|github|team|full] [--output human|json]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Activate the pinned agent-plugins component for selected providers and record ownership for safe uninstall.")
		return exitcode.Success
	case "status":
		fmt.Fprintln(stdout, "Usage: agx status --root <directory> [--output human|json]")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Read the local receipt and detect missing AGX-owned files without writing.")
		return exitcode.Success
	case "uninstall":
		fmt.Fprintln(stdout, "Usage: agx uninstall --root <directory>")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Reverse AGX-owned provider activation, then remove AGX-owned files while retaining unknown files.")
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

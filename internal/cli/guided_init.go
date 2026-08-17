package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
)

const guidedPromptAttempts = 3

type guidedInitChoices struct {
	root                string
	githubOwner         string
	providerChoice      string
	profile             activation.Profile
	visibility          repository.Visibility
	controlRepository   string
	contractsRepository string
}

type guidedDiscovery struct {
	installationID string
	pluginSource   string
	githubLogin    string
	providers      []guidedProviderStatus
	recommended    string
}

type guidedProviderStatus struct {
	name      provider.Name
	usable    bool
	reason    string
	inventory provider.Inventory
}

func runGuidedInit(args []string, values map[string]string, stdout, stderr io.Writer, dependencies runtimeDependencies) int {
	if !validGuidedInvocation(args) || values["--root"] == "" {
		fmt.Fprintln(stderr, "AGX-USAGE-INIT-GUIDED: agx init --guided --root <directory>")
		fmt.Fprintln(stderr, "Guided init is human-only and side-effect-free; combine it only with --root.")
		fmt.Fprintln(stderr, "Next: use agx init --guided --root <directory>, or use ordinary agx init flags for JSON and automation.")
		return exitcode.Usage
	}

	discoveryCtx, cancelDiscovery := context.WithTimeout(context.Background(), 2*time.Minute)
	discovery, err := discoverGuidedInit(discoveryCtx, values["--root"], dependencies)
	cancelDiscovery()
	if err != nil {
		printInitError(stderr, err, "human")
		return exitcode.Software
	}
	printGuidedDiscovery(stdout, discovery)

	reader := bufio.NewReader(dependencies.stdin)
	choices, err := promptGuidedChoices(reader, stdout, values["--root"], discovery)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Usage
	}
	printGuidedConfirmation(stdout, choices)
	confirmed, err := promptRequiredConfirmation(reader, stdout)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Usage
	}
	if !confirmed {
		fmt.Fprintln(stderr, guidedCancelNextStep())
		return exitcode.Usage
	}
	options := activation.Options{
		Root:                choices.root,
		GitHubOwner:         choices.githubOwner,
		ControlRepository:   choices.controlRepository,
		ContractsRepository: choices.contractsRepository,
		Visibility:          choices.visibility,
		Profile:             choices.profile,
		Runner:              dependencies.providerRunner,
		RepositoryRunner:    dependencies.repositoryRunner,
	}
	options.Providers, err = parseProviders(choices.providerChoice)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Usage
	}

	planFunc := dependencies.initPlan
	if planFunc == nil {
		planFunc = activation.Plan
	}
	planCtx, cancelPlan := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelPlan()
	plan, err := planFunc(planCtx, options)
	if err != nil {
		printInitError(stderr, err, "human")
		return exitcode.Software
	}

	applyArgs := guidedApplyArgs(choices)
	fmt.Fprintln(stdout, "")
	printInitializationPlan(stdout, plan, formatInitCommandForPlatform(applyArgs, true, dependencies.goos))
	_ = args
	return exitcode.Success
}

func validGuidedInvocation(args []string) bool {
	seenGuided := false
	seenRoot := false
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--guided":
			if seenGuided {
				return false
			}
			seenGuided = true
		case "--root":
			if seenRoot || index+1 >= len(args) {
				return false
			}
			seenRoot = true
			index++
		default:
			return false
		}
	}
	return seenGuided && seenRoot
}

func discoverGuidedInit(ctx context.Context, root string, dependencies runtimeDependencies) (guidedDiscovery, error) {
	state, err := installer.Status(root)
	if err != nil {
		return guidedDiscovery{}, err
	}
	if state.Receipt == nil || state.Phase != "configured" {
		return guidedDiscovery{}, fmt.Errorf("AGX-INIT-INSTALLATION: Installation must be intact and configured")
	}
	source, err := installedPluginSource(root, state.Receipt.Components)
	if err != nil {
		return guidedDiscovery{}, err
	}
	repositoryRunner := dependencies.repositoryRunner
	if repositoryRunner == nil {
		repositoryRunner = repository.OSRunner{}
	}
	if _, err := repositoryRunner.LookPath("git"); err != nil {
		return guidedDiscovery{}, fmt.Errorf("AGX-REPOSITORY-CLI-MISSING: git is unavailable")
	}
	if _, err := repositoryRunner.LookPath("gh"); err != nil {
		return guidedDiscovery{}, fmt.Errorf("AGX-REPOSITORY-CLI-MISSING: gh is unavailable")
	}
	output, err := repositoryRunner.Run(ctx, "", "gh", "api", "user")
	if err != nil {
		return guidedDiscovery{}, fmt.Errorf("AGX-REPOSITORY-AUTH: cannot authenticate GitHub CLI: %w", err)
	}
	var user struct {
		Login string `json:"login"`
	}
	if err := json.Unmarshal(output, &user); err != nil || strings.TrimSpace(user.Login) == "" {
		return guidedDiscovery{}, fmt.Errorf("AGX-REPOSITORY-AUTH: GitHub CLI returned invalid user inventory")
	}

	providerRunner := dependencies.providerRunner
	if providerRunner == nil {
		providerRunner = provider.OSRunner{}
	}
	discovery := guidedDiscovery{
		installationID: state.Receipt.InstallationID,
		pluginSource:   source,
		githubLogin:    user.Login,
	}
	for _, name := range []provider.Name{provider.Codex, provider.Claude} {
		status := guidedProviderStatus{name: name}
		inventory, err := provider.Inspect(ctx, name, providerRunner)
		if err != nil {
			status.reason = err.Error()
		} else if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			status.inventory = inventory
			status.reason = fmt.Sprintf("AGX-INIT-SOURCE-CONFLICT: %s Marketplace %q is already bound to a different source", name, provider.MarketplaceName)
		} else {
			status.usable = true
			status.inventory = inventory
			if inventory.Marketplace.Present {
				status.reason = "existing agent-plugins Marketplace matches this installation"
			} else {
				status.reason = "available; AGX would add agent-plugins Marketplace during apply"
			}
		}
		discovery.providers = append(discovery.providers, status)
	}
	discovery.recommended = recommendProvider(discovery.providers)
	if discovery.recommended == "" {
		return guidedDiscovery{}, fmt.Errorf("AGX-GUIDED-PROVIDER: no usable provider CLI found")
	}
	return discovery, nil
}

func installedPluginSource(root string, components []installer.Component) (string, error) {
	for _, component := range components {
		if component.Name != "agent-plugins" {
			continue
		}
		absoluteRoot, err := filepath.Abs(root)
		if err != nil {
			return "", fmt.Errorf("AGX-INIT-INSTALLATION: invalid Installation root")
		}
		return filepath.Join(absoluteRoot, filepath.FromSlash(component.Path)), nil
	}
	return "", fmt.Errorf("AGX-INIT-INSTALLATION: receipt has no agent-plugins component")
}

func recommendProvider(statuses []guidedProviderStatus) string {
	usable := map[provider.Name]bool{}
	for _, status := range statuses {
		usable[status.name] = status.usable
	}
	switch {
	case usable[provider.Codex] && usable[provider.Claude]:
		return "both"
	case usable[provider.Codex]:
		return string(provider.Codex)
	case usable[provider.Claude]:
		return string(provider.Claude)
	default:
		return ""
	}
}

func printGuidedDiscovery(output io.Writer, discovery guidedDiscovery) {
	fmt.Fprintln(output, "AGX guided initialization discovery (no changes made)")
	fmt.Fprintf(output, "Installation: %s\n", discovery.installationID)
	fmt.Fprintf(output, "Plugin source: %s\n", discovery.pluginSource)
	fmt.Fprintf(output, "GitHub CLI: authenticated as %s\n", discovery.githubLogin)
	fmt.Fprintln(output, "Provider inventory:")
	for _, status := range discovery.providers {
		label := "unavailable"
		if status.usable {
			label = "usable"
		}
		fmt.Fprintf(output, "  - %s: %s (%s)\n", providerDisplayName(status.name), label, status.reason)
	}
	fmt.Fprintf(output, "Recommended provider: %s\n", discovery.recommended)
}

func promptGuidedChoices(reader *bufio.Reader, output io.Writer, root string, discovery guidedDiscovery) (guidedInitChoices, error) {
	choices := guidedInitChoices{
		root:                root,
		githubOwner:         discovery.githubLogin,
		providerChoice:      discovery.recommended,
		profile:             activation.ProfileGitHub,
		visibility:          repository.VisibilityPrivate,
		controlRepository:   "agent-control",
		contractsRepository: "agent-contracts",
	}
	var err error
	if choices.githubOwner, err = promptValue(reader, output, "GitHub owner", choices.githubOwner); err != nil {
		return guidedInitChoices{}, err
	}
	if choices.providerChoice, err = promptProvider(reader, output, choices.providerChoice); err != nil {
		return guidedInitChoices{}, err
	}
	if choices.profile, err = promptProfile(reader, output, choices.profile); err != nil {
		return guidedInitChoices{}, err
	}
	if choices.visibility, err = promptVisibility(reader, output, choices.visibility); err != nil {
		return guidedInitChoices{}, err
	}
	if choices.controlRepository, err = promptValue(reader, output, "Control repository", choices.controlRepository); err != nil {
		return guidedInitChoices{}, err
	}
	if choices.contractsRepository, err = promptValue(reader, output, "Contracts repository", choices.contractsRepository); err != nil {
		return guidedInitChoices{}, err
	}
	return choices, nil
}

func promptProvider(reader *bufio.Reader, output io.Writer, defaultValue string) (string, error) {
	var last error
	for attempt := 1; attempt <= guidedPromptAttempts; attempt++ {
		value, err := promptValue(reader, output, "Provider (codex, claude, both)", defaultValue)
		if err != nil {
			return "", err
		}
		if _, err := parseProviders(value); err == nil {
			return value, nil
		} else {
			last = err
			fmt.Fprintf(output, "Invalid provider. Use codex, claude, or both (%d attempt(s) left).\n", guidedPromptAttempts-attempt)
		}
	}
	return "", fmt.Errorf("%v. Next: rerun guided init and choose codex, claude, or both; no changes were made.", last)
}

func promptProfile(reader *bufio.Reader, output io.Writer, defaultValue activation.Profile) (activation.Profile, error) {
	var last error
	for attempt := 1; attempt <= guidedPromptAttempts; attempt++ {
		value, err := promptValue(reader, output, "Profile (core, github, team, full)", string(defaultValue))
		if err != nil {
			return "", err
		}
		profile, err := activation.ParseProfile(value)
		if err == nil {
			return profile, nil
		}
		last = err
		fmt.Fprintf(output, "Invalid profile. Use core, github, team, or full (%d attempt(s) left).\n", guidedPromptAttempts-attempt)
	}
	return "", fmt.Errorf("%v. Next: rerun guided init and choose core, github, team, or full; no changes were made.", last)
}

func promptVisibility(reader *bufio.Reader, output io.Writer, defaultValue repository.Visibility) (repository.Visibility, error) {
	var last error
	for attempt := 1; attempt <= guidedPromptAttempts; attempt++ {
		value, err := promptValue(reader, output, "Visibility (private, public)", string(defaultValue))
		if err != nil {
			return "", err
		}
		visibility := repository.Visibility(strings.ToLower(value))
		if visibility == repository.VisibilityPrivate || visibility == repository.VisibilityPublic {
			return visibility, nil
		}
		last = fmt.Errorf("AGX-INIT-VISIBILITY: --visibility must be private or public")
		fmt.Fprintf(output, "Invalid visibility. Use private or public (%d attempt(s) left).\n", guidedPromptAttempts-attempt)
	}
	return "", fmt.Errorf("%v. Next: rerun guided init and choose private or public; no changes were made.", last)
}

func promptValue(reader *bufio.Reader, output io.Writer, label, defaultValue string) (string, error) {
	fmt.Fprintf(output, "%s [%s]: ", label, defaultValue)
	line, err := reader.ReadString('\n')
	if err != nil {
		if err != io.EOF {
			return "", fmt.Errorf("AGX-GUIDED-INPUT: cannot read %s: %w. Next: rerun guided init; no changes were made.", label, err)
		}
		if line == "" {
			return "", fmt.Errorf("AGX-GUIDED-CANCELLED: no changes made; input ended before %s was confirmed. Next: rerun agx init --guided --root <directory> when you are ready.", label)
		}
	}
	value := normalizePromptValue(line)
	if value == "" {
		value = defaultValue
	}
	if isCancelInput(value) {
		return "", fmt.Errorf("%s", guidedCancelNextStep())
	}
	return value, nil
}

func printGuidedConfirmation(output io.Writer, choices guidedInitChoices) {
	fmt.Fprintln(output, "")
	fmt.Fprintln(output, "Discovery and choices reviewed; no repositories or provider state were changed.")
	fmt.Fprintln(output, "Confirm exact initialization choices:")
	fmt.Fprintf(output, "  - owner: %s\n", choices.githubOwner)
	fmt.Fprintf(output, "  - provider: %s\n", choices.providerChoice)
	fmt.Fprintf(output, "  - profile: %s\n", choices.profile)
	fmt.Fprintf(output, "  - visibility: %s\n", choices.visibility)
	fmt.Fprintf(output, "  - control repo: %s/%s\n", choices.githubOwner, choices.controlRepository)
	fmt.Fprintf(output, "  - contracts repo: %s/%s\n", choices.githubOwner, choices.contractsRepository)
	fmt.Fprintln(output, "Remote repositories are retained on uninstall; same-name repositories stop initialization before writes.")
}

func promptRequiredConfirmation(reader *bufio.Reader, output io.Writer) (bool, error) {
	fmt.Fprint(output, "Type yes to run the read-only plan preflight and print the exact --apply command: ")
	line, err := reader.ReadString('\n')
	if err != nil {
		if err != io.EOF {
			return false, fmt.Errorf("AGX-GUIDED-INPUT: cannot read confirmation: %w. Next: rerun guided init; no changes were made.", err)
		}
		if line == "" {
			return false, fmt.Errorf("AGX-GUIDED-CANCELLED: no changes made; input ended before final confirmation. Next: rerun agx init --guided --root <directory> when you are ready.")
		}
	}
	value := strings.ToLower(normalizePromptValue(line))
	if isCancelInput(value) {
		return false, nil
	}
	return value == "yes", nil
}

func guidedApplyArgs(choices guidedInitChoices) []string {
	return []string{
		"--root", choices.root,
		"--github-owner", choices.githubOwner,
		"--provider", choices.providerChoice,
		"--profile", string(choices.profile),
		"--visibility", string(choices.visibility),
		"--control-repo", choices.controlRepository,
		"--contracts-repo", choices.contractsRepository,
	}
}

func normalizePromptValue(value string) string {
	return strings.TrimPrefix(strings.TrimSpace(value), "\ufeff")
}

func guidedCancelNextStep() string {
	return "AGX-GUIDED-CANCELLED: no changes made. Next: rerun agx init --guided --root <directory> when you are ready, or use agx init with explicit flags."
}

func isCancelInput(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "cancel", "q", "quit", "exit":
		return true
	default:
		return false
	}
}

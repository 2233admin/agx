// Package activation initializes an installed Bundle for provider use while
// retaining enough ownership evidence to reverse only AGX-created objects.
package activation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/provider"
)

const (
	receiptSchema      = "agx.initialization/v1"
	initializationFile = "initialization.json"
	PhaseInitialized   = "initialized"
	PhaseManualCleanup = "needs_manual_cleanup"
	StatusAbsent       = "absent"
	StatusDrifted      = "drifted"
)

type Profile string

const (
	ProfileCore   Profile = "core"
	ProfileGitHub Profile = "github"
	ProfileTeam   Profile = "team"
	ProfileFull   Profile = "full"
)

var corePlugins = []string{
	"grilling",
	"self-improvement",
	"knowledge-maintenance",
	"adaptive-problem-solving",
}

func ParseProfile(value string) (Profile, error) {
	profile := Profile(strings.ToLower(strings.TrimSpace(value)))
	switch profile {
	case ProfileCore, ProfileGitHub, ProfileTeam, ProfileFull:
		return profile, nil
	default:
		return "", fmt.Errorf("AGX-INIT-PROFILE: unsupported profile %q", value)
	}
}

func Plugins(profile Profile) ([]string, error) {
	plugins := append([]string(nil), corePlugins...)
	switch profile {
	case ProfileCore:
	case ProfileGitHub:
		plugins = append(plugins, "github-collaboration")
	case ProfileTeam:
		plugins = append(plugins, "github-collaboration", "orchestrated-collaboration")
	case ProfileFull:
		plugins = append(plugins, "github-collaboration", "orchestrated-collaboration", "resource-observability")
	default:
		return nil, fmt.Errorf("AGX-INIT-PROFILE: unsupported profile %q", profile)
	}
	return plugins, nil
}

type ProviderReceipt struct {
	Name             provider.Name `json:"name"`
	MarketplaceAdded bool          `json:"marketplace_added"`
	SelectedPlugins  []string      `json:"selected_plugins"`
	AddedPlugins     []string      `json:"added_plugins"`
}

type Receipt struct {
	SchemaVersion  string            `json:"schema_version"`
	InstallationID string            `json:"installation_id"`
	Phase          string            `json:"phase"`
	Profile        Profile           `json:"profile"`
	Providers      []ProviderReceipt `json:"providers"`
}

type State struct {
	Status    string          `json:"status"`
	Profile   Profile         `json:"profile,omitempty"`
	Providers []provider.Name `json:"providers,omitempty"`
	Problems  []string        `json:"problems,omitempty"`
}

type Options struct {
	Root      string
	Profile   Profile
	Providers []provider.Name
	Runner    provider.Runner
}

type target struct {
	name      provider.Name
	before    provider.Inventory
	receipt   ProviderReceipt
	toInstall []string
}

func Initialize(ctx context.Context, options Options) (Receipt, bool, error) {
	runner := options.Runner
	if runner == nil {
		runner = provider.OSRunner{}
	}
	selected, err := Plugins(options.Profile)
	if err != nil {
		return Receipt{}, false, err
	}
	providers, err := normalizeProviders(options.Providers)
	if err != nil {
		return Receipt{}, false, err
	}
	installation, source, err := resolveInstallation(options.Root, true)
	if err != nil {
		return Receipt{}, false, err
	}

	existing, present, err := readReceipt(options.Root)
	if err != nil {
		return Receipt{}, false, err
	}
	if present {
		if existing.Phase == PhaseManualCleanup {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-MANUAL-CLEANUP: unresolved provider changes require cleanup before initialization")
		}
		if existing.InstallationID != installation.InstallationID || existing.Profile != options.Profile || !sameProviders(existing.Providers, providers) {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-CONFLICT: existing initialization receipt has a different Installation, profile, or provider set")
		}
		if problems := verifyReceipt(ctx, existing, source, runner); len(problems) > 0 {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-DRIFT: %s", strings.Join(problems, "; "))
		}
		return existing, true, nil
	}

	targets := make([]target, 0, len(providers))
	for _, name := range providers {
		inventory, err := provider.Inspect(ctx, name, runner)
		if err != nil {
			return Receipt{}, false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-SOURCE-CONFLICT: %s Marketplace %q is already bound to a different source", name, provider.MarketplaceName)
		}
		item := target{
			name:   name,
			before: inventory,
			receipt: ProviderReceipt{
				Name:             name,
				MarketplaceAdded: !inventory.Marketplace.Present,
				SelectedPlugins:  append([]string(nil), selected...),
			},
		}
		for _, pluginName := range selected {
			plugin, present := inventory.Plugin(pluginName)
			if present && !plugin.Enabled {
				return Receipt{}, false, fmt.Errorf("AGX-INIT-PLUGIN-DISABLED: %s plugin %q already exists but is disabled", name, pluginName)
			}
			if !present {
				item.toInstall = append(item.toInstall, pluginName)
			}
		}
		targets = append(targets, item)
	}

	receipt := Receipt{
		SchemaVersion:  receiptSchema,
		InstallationID: installation.InstallationID,
		Phase:          PhaseInitialized,
		Profile:        options.Profile,
	}
	for index := range targets {
		item := &targets[index]
		if item.receipt.MarketplaceAdded {
			if err := provider.AddMarketplace(ctx, item.name, source, runner); err != nil {
				receipt.Providers = candidateReceipts(targets, index, "")
				return failedInitialization(ctx, options.Root, receipt, source, runner, err)
			}
		}
		for _, pluginName := range item.toInstall {
			if err := provider.InstallPlugin(ctx, item.name, pluginName, runner); err != nil {
				receipt.Providers = candidateReceipts(targets, index, pluginName)
				return failedInitialization(ctx, options.Root, receipt, source, runner, err)
			}
			item.receipt.AddedPlugins = append(item.receipt.AddedPlugins, pluginName)
		}
		receipt.Providers = append(receipt.Providers, item.receipt)
	}

	if problems := verifyReceipt(ctx, receipt, source, runner); len(problems) > 0 {
		return failedInitialization(ctx, options.Root, receipt, source, runner, fmt.Errorf("AGX-INIT-READBACK: %s", strings.Join(problems, "; ")))
	}
	if err := writeReceipt(options.Root, receipt); err != nil {
		return failedInitialization(ctx, options.Root, receipt, source, runner, err)
	}
	return receipt, false, nil
}

func Status(ctx context.Context, root string, runner provider.Runner) (State, error) {
	receipt, present, err := readReceipt(root)
	if err != nil {
		return State{}, err
	}
	if !present {
		return State{Status: StatusAbsent}, nil
	}
	state := State{Status: receipt.Phase, Profile: receipt.Profile}
	for _, item := range receipt.Providers {
		state.Providers = append(state.Providers, item.Name)
	}
	if receipt.Phase == PhaseManualCleanup {
		return state, nil
	}
	installation, source, err := resolveInstallation(root, false)
	if err != nil {
		state.Status = StatusDrifted
		state.Problems = append(state.Problems, "installed agent-plugins component is unavailable")
		return state, nil
	}
	if receipt.InstallationID != installation.InstallationID {
		state.Status = StatusDrifted
		state.Problems = append(state.Problems, "initialization receipt belongs to a different Installation")
		return state, nil
	}
	if runner == nil {
		runner = provider.OSRunner{}
	}
	state.Problems = verifyReceipt(ctx, receipt, source, runner)
	if len(state.Problems) > 0 {
		state.Status = StatusDrifted
	}
	return state, nil
}

func Uninitialize(ctx context.Context, root string, runner provider.Runner) (bool, error) {
	receipt, present, err := readReceipt(root)
	if err != nil || !present {
		return false, err
	}
	if runner == nil {
		runner = provider.OSRunner{}
	}
	installation, source, err := resolveInstallation(root, false)
	if err != nil {
		return false, err
	}
	if receipt.InstallationID != installation.InstallationID {
		return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-OWNERSHIP: initialization receipt belongs to a different Installation")
	}

	// Complete every read-only source check before the first mutation. A
	// pre-existing Marketplace that still references this Installation blocks
	// Bundle removal, but it must not block cleanup of plugins AGX added through
	// that Marketplace.
	for _, item := range receipt.Providers {
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed; provider cleanup stopped", item.Name)
		}
	}

	var retainedMarketplaces []string
	for index := len(receipt.Providers) - 1; index >= 0; index-- {
		item := receipt.Providers[index]
		for pluginIndex := len(item.AddedPlugins) - 1; pluginIndex >= 0; pluginIndex-- {
			pluginName := item.AddedPlugins[pluginIndex]
			inventory, err := provider.Inspect(ctx, item.Name, runner)
			if err != nil {
				return false, err
			}
			if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
				return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed during provider cleanup", item.Name)
			}
			if _, present := inventory.Plugin(pluginName); !present {
				continue
			}
			if err := provider.RemovePlugin(ctx, item.Name, pluginName, runner); err != nil {
				return false, err
			}
		}
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed during provider cleanup", item.Name)
		}
		if item.MarketplaceAdded && inventory.Marketplace.Present {
			if err := provider.RemoveMarketplace(ctx, item.Name, runner); err != nil {
				return false, err
			}
		}
		inventory, err = provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed during provider cleanup", item.Name)
		}
		if item.MarketplaceAdded && inventory.Marketplace.Present {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-READBACK: %s Marketplace is still present", item.Name)
		}
		for _, pluginName := range item.AddedPlugins {
			if _, present := inventory.Plugin(pluginName); present {
				return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-READBACK: %s plugin %q is still present", item.Name, pluginName)
			}
		}
		if !item.MarketplaceAdded && inventory.Marketplace.Present {
			retainedMarketplaces = append(retainedMarketplaces, string(item.Name))
		}
	}

	if len(retainedMarketplaces) > 0 {
		return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-OWNERSHIP: %s Marketplace predates AGX initialization and still references this Installation", strings.Join(retainedMarketplaces, ", "))
	}

	safeReceiptPath, present, _, err := inspectReceiptPath(root)
	if err != nil {
		return false, err
	}
	if !present {
		return false, fmt.Errorf("AGX-INIT-RECEIPT-READ: initialization receipt disappeared before removal")
	}
	if err := os.Remove(safeReceiptPath); err != nil {
		return false, fmt.Errorf("AGX-INIT-RECEIPT-REMOVE: %w", err)
	}
	return true, nil
}

func failedInitialization(ctx context.Context, root string, receipt Receipt, source string, runner provider.Runner, original error) (Receipt, bool, error) {
	cleanupErr := compensate(ctx, receipt.Providers, source, runner)
	if cleanupErr == nil {
		return Receipt{}, false, original
	}
	receipt.Phase = PhaseManualCleanup
	if writeErr := writeReceipt(root, receipt); writeErr != nil {
		return Receipt{}, false, fmt.Errorf("%v; compensation failed: %v; manual-cleanup receipt failed: %v", original, cleanupErr, writeErr)
	}
	return receipt, false, fmt.Errorf("%v; compensation failed: %v", original, cleanupErr)
}

func compensate(ctx context.Context, receipts []ProviderReceipt, source string, runner provider.Runner) error {
	var failures []string
	for index := len(receipts) - 1; index >= 0; index-- {
		item := receipts[index]
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s inventory unavailable", item.Name))
			continue
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			failures = append(failures, fmt.Sprintf("%s source changed", item.Name))
			continue
		}
		for pluginIndex := len(item.AddedPlugins) - 1; pluginIndex >= 0; pluginIndex-- {
			pluginName := item.AddedPlugins[pluginIndex]
			if _, present := inventory.Plugin(pluginName); !present {
				continue
			}
			if err := provider.RemovePlugin(ctx, item.Name, pluginName, runner); err != nil {
				failures = append(failures, fmt.Sprintf("%s plugin cleanup failed", item.Name))
			}
		}
		inventory, err = provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s readback unavailable", item.Name))
			continue
		}
		if item.MarketplaceAdded && inventory.Marketplace.Present {
			if err := provider.RemoveMarketplace(ctx, item.Name, runner); err != nil {
				failures = append(failures, fmt.Sprintf("%s Marketplace cleanup failed", item.Name))
			}
		}
		if inventory, err = provider.Inspect(ctx, item.Name, runner); err != nil {
			failures = append(failures, fmt.Sprintf("%s final readback unavailable", item.Name))
		} else {
			if item.MarketplaceAdded && inventory.Marketplace.Present {
				failures = append(failures, fmt.Sprintf("%s Marketplace remains after cleanup", item.Name))
			}
			for _, pluginName := range item.AddedPlugins {
				if _, present := inventory.Plugin(pluginName); present {
					failures = append(failures, fmt.Sprintf("%s plugin remains after cleanup", item.Name))
				}
			}
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func candidateReceipts(targets []target, failedIndex int, attemptedPlugin string) []ProviderReceipt {
	receipts := make([]ProviderReceipt, 0, failedIndex+1)
	for index := 0; index <= failedIndex; index++ {
		item := targets[index].receipt
		if index == failedIndex && attemptedPlugin != "" && !contains(item.AddedPlugins, attemptedPlugin) {
			item.AddedPlugins = append(item.AddedPlugins, attemptedPlugin)
		}
		receipts = append(receipts, item)
	}
	return receipts
}

func verifyReceipt(ctx context.Context, receipt Receipt, source string, runner provider.Runner) []string {
	var problems []string
	for _, item := range receipt.Providers {
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s inventory unavailable", item.Name))
			continue
		}
		if !inventory.Marketplace.Present || !provider.SameSource(inventory.Marketplace.Source, source) {
			problems = append(problems, fmt.Sprintf("%s Marketplace does not reference the installed Bundle", item.Name))
			continue
		}
		for _, pluginName := range item.SelectedPlugins {
			plugin, present := inventory.Plugin(pluginName)
			if !present || !plugin.Enabled {
				problems = append(problems, fmt.Sprintf("%s plugin %s is not enabled", item.Name, pluginName))
			}
		}
	}
	return problems
}

func resolveInstallation(root string, requireConfigured bool) (installer.Receipt, string, error) {
	state, err := installer.Status(root)
	if err != nil {
		return installer.Receipt{}, "", err
	}
	if state.Receipt == nil || (requireConfigured && state.Phase != "configured") {
		return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: Installation must be intact and configured")
	}
	for _, component := range state.Receipt.Components {
		if component.Name != "agent-plugins" {
			continue
		}
		expectedPath := filepath.Join("components", "agent-plugins")
		if filepath.Clean(filepath.FromSlash(component.Path)) != expectedPath {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: unexpected agent-plugins component path")
		}
		absoluteRoot, err := filepath.Abs(root)
		if err != nil {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: invalid Installation root")
		}
		source := filepath.Join(absoluteRoot, filepath.FromSlash(component.Path))
		relative, err := filepath.Rel(absoluteRoot, source)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: unsafe agent-plugins component path")
		}
		info, err := os.Lstat(source)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsDir() {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: agent-plugins component is unavailable")
		}
		return *state.Receipt, source, nil
	}
	return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: receipt has no agent-plugins component")
}

func normalizeProviders(values []provider.Name) ([]provider.Name, error) {
	seen := map[provider.Name]bool{}
	for _, name := range values {
		if name != provider.Codex && name != provider.Claude {
			return nil, fmt.Errorf("AGX-INIT-PROVIDER: unsupported provider %q", name)
		}
		seen[name] = true
	}
	if len(seen) == 0 {
		return nil, fmt.Errorf("AGX-INIT-PROVIDER: at least one provider is required")
	}
	var providers []provider.Name
	for _, name := range []provider.Name{provider.Codex, provider.Claude} {
		if seen[name] {
			providers = append(providers, name)
		}
	}
	return providers, nil
}

func sameProviders(receipts []ProviderReceipt, providers []provider.Name) bool {
	if len(receipts) != len(providers) {
		return false
	}
	for index, item := range receipts {
		if item.Name != providers[index] {
			return false
		}
	}
	return true
}

func receiptPath(root string) string {
	return filepath.Join(root, ".agx", initializationFile)
}

func readReceipt(root string) (Receipt, bool, error) {
	path, present, expectedInfo, err := inspectReceiptPath(root)
	if err != nil {
		return Receipt{}, false, err
	}
	if !present {
		return Receipt{}, false, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot open initialization receipt: %w", err)
	}
	openedInfo, statErr := file.Stat()
	if statErr != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(expectedInfo, openedInfo) {
		file.Close()
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: initialization receipt changed during read")
	}
	data, readErr := io.ReadAll(file)
	closeErr := file.Close()
	if readErr != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot read initialization receipt: %w", readErr)
	}
	if closeErr != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot close initialization receipt: %w", closeErr)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var receipt Receipt
	if err := decoder.Decode(&receipt); err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: trailing data")
	}
	if receipt.SchemaVersion != receiptSchema || receipt.InstallationID == "" || (receipt.Phase != PhaseInitialized && receipt.Phase != PhaseManualCleanup) {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: required fields are missing")
	}
	if err := validateReceipt(receipt); err != nil {
		return Receipt{}, false, err
	}
	return receipt, true, nil
}

func inspectReceiptPath(root string) (string, bool, os.FileInfo, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: invalid Installation root: %w", err)
	}
	rootInfo, err := os.Lstat(absoluteRoot)
	if os.IsNotExist(err) {
		return filepath.Join(absoluteRoot, ".agx", initializationFile), false, nil, nil
	}
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect Installation root: %w", err)
	}
	if err := requireRealMetadataEntry(absoluteRoot, rootInfo, true, "Installation root"); err != nil {
		return "", false, nil, err
	}

	directory := filepath.Join(absoluteRoot, ".agx")
	directoryInfo, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		return filepath.Join(directory, initializationFile), false, nil, nil
	}
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect metadata directory: %w", err)
	}
	if err := requireRealMetadataEntry(directory, directoryInfo, true, "metadata directory"); err != nil {
		return "", false, nil, err
	}

	path := filepath.Join(directory, initializationFile)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return path, false, nil, nil
	}
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect initialization receipt: %w", err)
	}
	if err := requireRealMetadataEntry(path, info, false, "initialization receipt"); err != nil {
		return "", false, nil, err
	}
	return path, true, info, nil
}

func requireRealMetadataEntry(path string, info os.FileInfo, directory bool, label string) error {
	reparse, err := metadataPathIsReparsePoint(path)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect %s attributes: %w", label, err)
	}
	validType := info.Mode().IsRegular()
	if directory {
		validType = info.Mode().IsDir()
	}
	if reparse || info.Mode()&os.ModeSymlink != 0 || !validType {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: %s must be a real %s", label, map[bool]string{true: "directory", false: "regular file"}[directory])
	}
	return nil
}

func validateReceipt(receipt Receipt) error {
	selected, err := Plugins(receipt.Profile)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: unsupported profile")
	}
	providers := make([]provider.Name, 0, len(receipt.Providers))
	for _, item := range receipt.Providers {
		providers = append(providers, item.Name)
		if !sameStrings(item.SelectedPlugins, selected) {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: selected plugins do not match profile")
		}
		seenAdded := map[string]bool{}
		for _, pluginName := range item.AddedPlugins {
			if seenAdded[pluginName] || !contains(item.SelectedPlugins, pluginName) {
				return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: added plugins are inconsistent")
			}
			seenAdded[pluginName] = true
		}
	}
	normalized, err := normalizeProviders(providers)
	if err != nil || !sameProviders(receipt.Providers, normalized) {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: provider list is inconsistent")
	}
	return nil
}

func writeReceipt(root string, receipt Receipt) error {
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	data = append(data, '\n')
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: invalid Installation root: %w", err)
	}
	rootInfo, err := os.Lstat(absoluteRoot)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: cannot inspect Installation root: %w", err)
	}
	if err := requireRealMetadataEntry(absoluteRoot, rootInfo, true, "Installation root"); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: unsafe Installation root: %w", err)
	}
	directory := filepath.Join(absoluteRoot, ".agx")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: cannot inspect metadata directory: %w", err)
	}
	if err := requireRealMetadataEntry(directory, directoryInfo, true, "metadata directory"); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: unsafe metadata directory: %w", err)
	}
	target := filepath.Join(directory, initializationFile)
	if targetInfo, targetErr := os.Lstat(target); targetErr == nil {
		if err := requireRealMetadataEntry(target, targetInfo, false, "initialization receipt"); err != nil {
			return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: unsafe initialization receipt: %w", err)
		}
	} else if !os.IsNotExist(targetErr) {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: cannot inspect initialization receipt: %w", targetErr)
	}
	temporary, err := os.CreateTemp(directory, ".initialization-*.tmp")
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	if err := os.Rename(temporaryName, target); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	return nil
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

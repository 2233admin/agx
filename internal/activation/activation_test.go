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
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/provider"
)

type providerState struct {
	available         bool
	marketplaceSource string
	plugins           map[string]bool
}

type statefulRunner struct {
	states              map[provider.Name]*providerState
	mutations           []string
	fail                map[string]bool
	failRemove          map[string]bool
	malformedInventory  map[string]bool
	omitStateChange     map[string]bool
	disableAddedPlugin  map[string]bool
	afterNextPluginList map[provider.Name]func()
	afterMutation       map[string]func()
}

func newRunner() *statefulRunner {
	return &statefulRunner{
		states: map[provider.Name]*providerState{
			provider.Codex:  {available: true, plugins: map[string]bool{}},
			provider.Claude: {available: true, plugins: map[string]bool{}},
		},
		fail:                map[string]bool{},
		failRemove:          map[string]bool{},
		malformedInventory:  map[string]bool{},
		omitStateChange:     map[string]bool{},
		disableAddedPlugin:  map[string]bool{},
		afterNextPluginList: map[provider.Name]func(){},
		afterMutation:       map[string]func(){},
	}
}

func (runner *statefulRunner) LookPath(name string) (string, error) {
	state := runner.states[provider.Name(name)]
	if state == nil || !state.available {
		return "", errors.New("not found")
	}
	return "/bin/" + name, nil
}

func (runner *statefulRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	state := runner.states[provider.Name(name)]
	joined := strings.Join(args, " ")
	if runner.malformedInventory[name+":"+joined] {
		return []byte(`{"unclosed":`), nil
	}
	if joined == "plugin marketplace list --json" {
		if provider.Name(name) == provider.Codex {
			marketplaces := []map[string]any{}
			if state.marketplaceSource != "" {
				marketplaces = append(marketplaces, map[string]any{"name": "agent-plugins", "root": state.marketplaceSource})
			}
			return json.Marshal(map[string]any{"marketplaces": marketplaces})
		}
		marketplaces := []map[string]any{}
		if state.marketplaceSource != "" {
			marketplaces = append(marketplaces, map[string]any{"name": "agent-plugins", "source": "directory", "path": state.marketplaceSource})
		}
		return json.Marshal(marketplaces)
	}
	if joined == "plugin list --json" {
		if provider.Name(name) == provider.Codex {
			var installed []map[string]any
			for pluginName, enabled := range state.plugins {
				installed = append(installed, map[string]any{
					"pluginId": pluginName + "@agent-plugins", "name": pluginName, "marketplaceName": "agent-plugins",
					"version": "test", "installed": true, "enabled": enabled,
				})
			}
			output, err := json.Marshal(map[string]any{"installed": installed})
			runner.runAfterPluginList(provider.Name(name))
			return output, err
		}
		var installed []map[string]any
		for pluginName, enabled := range state.plugins {
			installed = append(installed, map[string]any{
				"id": pluginName + "@agent-plugins", "version": "test", "scope": "user", "enabled": enabled,
			})
		}
		output, err := json.Marshal(installed)
		runner.runAfterPluginList(provider.Name(name))
		return output, err
	}

	operation, pluginName := mutation(joined)
	key := name + ":" + operation + ":" + pluginName
	if runner.fail[key] || runner.failRemove[key] {
		return nil, errors.New("injected failure")
	}
	runner.mutations = append(runner.mutations, key)
	if runner.omitStateChange[key] {
		return []byte(`{}`), nil
	}
	switch operation {
	case "marketplace-add":
		for _, argument := range args {
			if filepath.IsAbs(argument) {
				state.marketplaceSource = argument
				break
			}
		}
	case "marketplace-remove":
		state.marketplaceSource = ""
	case "plugin-add":
		state.plugins[pluginName] = !runner.disableAddedPlugin[key]
	case "plugin-remove":
		delete(state.plugins, pluginName)
	default:
		return nil, errors.New("unexpected command: " + joined)
	}
	if hook := runner.afterMutation[key]; hook != nil {
		delete(runner.afterMutation, key)
		hook()
	}
	return []byte(`{}`), nil
}

func (runner *statefulRunner) runAfterPluginList(name provider.Name) {
	hook := runner.afterNextPluginList[name]
	if hook == nil {
		return
	}
	delete(runner.afterNextPluginList, name)
	hook()
}

func mutation(joined string) (string, string) {
	fields := strings.Fields(joined)
	if strings.Contains(joined, "marketplace add") {
		return "marketplace-add", ""
	}
	if strings.Contains(joined, "marketplace remove") {
		return "marketplace-remove", ""
	}
	for _, field := range fields {
		if strings.HasSuffix(field, "@agent-plugins") {
			name := strings.TrimSuffix(field, "@agent-plugins")
			if strings.Contains(joined, " uninstall ") || strings.Contains(joined, " remove ") {
				return "plugin-remove", name
			}
			return "plugin-add", name
		}
	}
	return "unknown", ""
}

func TestInitializeReadbackReentryAndOwnedUninstall(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	options := activation.Options{Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner}
	receipt, unchanged, err := activation.Initialize(context.Background(), options)
	if err != nil || unchanged {
		t.Fatalf("Initialize() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if receipt.Phase != activation.PhaseInitialized || !receipt.Providers[0].MarketplaceAdded || len(receipt.Providers[0].AddedPlugins) != 4 {
		t.Fatalf("receipt = %+v", receipt)
	}
	mutations := len(runner.mutations)
	_, unchanged, err = activation.Initialize(context.Background(), options)
	if err != nil || !unchanged || len(runner.mutations) != mutations {
		t.Fatalf("repeat Initialize() unchanged=%v mutations=%d err=%v", unchanged, len(runner.mutations), err)
	}
	state, err := activation.Status(context.Background(), root, runner)
	if err != nil || state.Status != activation.PhaseInitialized {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err != nil || !removed {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if runner.states[provider.Codex].marketplaceSource != "" || len(runner.states[provider.Codex].plugins) != 0 {
		t.Fatalf("provider state retained AGX-owned objects: %+v", runner.states[provider.Codex])
	}
}

func TestInitializePreflightBlocksSourceConflictBeforeWrites(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	runner.states[provider.Codex].marketplaceSource = filepath.Join(t.TempDir(), "other")
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-INIT-SOURCE-CONFLICT") {
		t.Fatalf("Initialize() err=%v", err)
	}
	if len(runner.mutations) != 0 {
		t.Fatalf("preflight wrote mutations: %#v", runner.mutations)
	}
}

func TestInitializePreflightBlocksMissingProviderBeforeWrites(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	runner.states[provider.Claude].available = false
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex, provider.Claude}, Runner: runner,
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-INIT-PROVIDER-MISSING") {
		t.Fatalf("Initialize() err=%v", err)
	}
	if len(runner.mutations) != 0 {
		t.Fatalf("preflight wrote mutations: %#v", runner.mutations)
	}
}

func TestInitializePreflightBlocksDisabledPluginBeforeWrites(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	runner.states[provider.Codex].plugins["knowledge-maintenance"] = false
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-INIT-PLUGIN-DISABLED") {
		t.Fatalf("Initialize() err=%v", err)
	}
	if len(runner.mutations) != 0 {
		t.Fatalf("disabled-plugin preflight wrote mutations: %#v", runner.mutations)
	}
}

func TestInitializePreflightBlocksUnreadableInventoryBeforeWrites(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	runner.malformedInventory["claude:plugin list --json"] = true
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex, provider.Claude}, Runner: runner,
	})
	if err == nil || !strings.Contains(err.Error(), "AGX-INIT-INVENTORY") {
		t.Fatalf("Initialize() err=%v", err)
	}
	if len(runner.mutations) != 0 {
		t.Fatalf("unreadable-inventory preflight wrote mutations: %#v", runner.mutations)
	}
}

func TestInitializeRejectsUnexpectedComponentPath(t *testing.T) {
	root := makeInstallation(t)
	receiptPath := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt installer.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Components[1].Path = "."
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receiptPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := newRunner()
	_, _, err = activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err == nil || (!strings.Contains(err.Error(), "unexpected agent-plugins component path") && !strings.Contains(err.Error(), "AGX-RECEIPT-INVALID")) {
		t.Fatalf("Initialize() err=%v", err)
	}
	if len(runner.mutations) != 0 {
		t.Fatalf("invalid component path caused provider writes: %#v", runner.mutations)
	}
}

func TestProviderLifecycleRejectsSymlinkedPluginComponent(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}

	component := filepath.Join(root, "components", "agent-plugins")
	sibling := filepath.Join(filepath.Dir(root), "sibling-agent-plugins")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sibling, "README.md"), []byte("sibling checkout\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(component); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, component); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}

	state, err := activation.Status(context.Background(), root, runner)
	if err != nil || state.Status != activation.StatusDrifted {
		t.Fatalf("Status() followed linked component: state=%+v err=%v", state, err)
	}
	mutationsBeforeCleanup := len(runner.mutations)
	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-INIT-INSTALLATION") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if len(runner.mutations) != mutationsBeforeCleanup {
		t.Fatalf("linked component caused provider mutations: %#v", runner.mutations[mutationsBeforeCleanup:])
	}
	contents, err := os.ReadFile(filepath.Join(sibling, "README.md"))
	if err != nil || string(contents) != "sibling checkout\n" {
		t.Fatalf("sibling checkout was changed: contents=%q err=%v", contents, err)
	}
}

func TestProviderLifecycleRejectsLinkedMetadataDirectoryBeforeMutation(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	options := activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	}
	_, _, err := activation.Initialize(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}

	metadata := filepath.Join(root, ".agx")
	sibling := filepath.Join(filepath.Dir(root), "sibling-metadata")
	if err := os.Rename(metadata, sibling); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, metadata); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}
	installReceiptBefore, err := os.ReadFile(filepath.Join(sibling, "receipt.json"))
	if err != nil {
		t.Fatal(err)
	}
	initializationReceiptBefore, err := os.ReadFile(filepath.Join(sibling, "initialization.json"))
	if err != nil {
		t.Fatal(err)
	}
	mutationsBefore := len(runner.mutations)

	if _, err := activation.Status(context.Background(), root, runner); err == nil {
		t.Fatal("Status() accepted linked metadata directory")
	}
	if _, _, err := activation.Initialize(context.Background(), options); err == nil {
		t.Fatal("Initialize() accepted linked metadata directory")
	}
	if removed, err := activation.Uninitialize(context.Background(), root, runner); err == nil || removed {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if len(runner.mutations) != mutationsBefore {
		t.Fatalf("linked metadata caused provider mutations: %#v", runner.mutations[mutationsBefore:])
	}
	installReceiptAfter, err := os.ReadFile(filepath.Join(sibling, "receipt.json"))
	if err != nil || string(installReceiptAfter) != string(installReceiptBefore) {
		t.Fatalf("sibling install receipt changed: err=%v", err)
	}
	initializationReceiptAfter, err := os.ReadFile(filepath.Join(sibling, "initialization.json"))
	if err != nil || string(initializationReceiptAfter) != string(initializationReceiptBefore) {
		t.Fatalf("sibling initialization receipt changed: err=%v", err)
	}
}

func TestInitializeBothProvidersWithFullProfile(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	receipt, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileFull, Providers: []provider.Name{provider.Claude, provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantPlugins := mustPlugins(t, activation.ProfileFull)
	if len(receipt.Providers) != 2 || receipt.Providers[0].Name != provider.Codex || receipt.Providers[1].Name != provider.Claude {
		t.Fatalf("providers = %+v", receipt.Providers)
	}
	for _, name := range []provider.Name{provider.Codex, provider.Claude} {
		state := runner.states[name]
		if len(state.plugins) != len(wantPlugins) {
			t.Fatalf("%s plugins = %#v", name, state.plugins)
		}
		for _, pluginName := range wantPlugins {
			if !state.plugins[pluginName] {
				t.Fatalf("%s plugin %q was not enabled", name, pluginName)
			}
		}
	}
}

func TestProfilePluginSetsAreExact(t *testing.T) {
	tests := []struct {
		profile activation.Profile
		want    []string
	}{
		{
			profile: activation.ProfileGitHub,
			want: []string{
				"grilling", "self-improvement", "knowledge-maintenance", "adaptive-problem-solving",
				"github-collaboration",
			},
		},
		{
			profile: activation.ProfileTeam,
			want: []string{
				"grilling", "self-improvement", "knowledge-maintenance", "adaptive-problem-solving",
				"github-collaboration", "orchestrated-collaboration",
			},
		},
	}
	for _, test := range tests {
		t.Run(string(test.profile), func(t *testing.T) {
			got := mustPlugins(t, test.profile)
			if strings.Join(got, "\x00") != strings.Join(test.want, "\x00") {
				t.Fatalf("Plugins(%q) = %#v, want %#v", test.profile, got, test.want)
			}
		})
	}
}

func TestInitializeCompensatesPartialFailureWithoutReceipt(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	runner.fail["codex:plugin-add:knowledge-maintenance"] = true
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err == nil {
		t.Fatal("Initialize() succeeded with injected failure")
	}
	if runner.states[provider.Codex].marketplaceSource != "" || len(runner.states[provider.Codex].plugins) != 0 {
		t.Fatalf("compensation left state: %+v", runner.states[provider.Codex])
	}
	state, statusErr := activation.Status(context.Background(), root, runner)
	if statusErr != nil || state.Status != activation.StatusAbsent {
		t.Fatalf("Status() state=%+v err=%v", state, statusErr)
	}
}

func TestInitializeWritesManualCleanupReceiptWhenCompensationFails(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	runner.fail["codex:plugin-add:knowledge-maintenance"] = true
	runner.failRemove["codex:plugin-remove:self-improvement"] = true
	receipt, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err == nil || receipt.Phase != activation.PhaseManualCleanup {
		t.Fatalf("Initialize() receipt=%+v err=%v", receipt, err)
	}
	state, statusErr := activation.Status(context.Background(), root, runner)
	if statusErr != nil || state.Status != activation.PhaseManualCleanup {
		t.Fatalf("Status() state=%+v err=%v", state, statusErr)
	}
}

func TestInitializeCompensatesReadbackFailure(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*statefulRunner, string)
	}{
		{
			name: "missing",
			configure: func(runner *statefulRunner, key string) {
				runner.omitStateChange[key] = true
			},
		},
		{
			name: "disabled",
			configure: func(runner *statefulRunner, key string) {
				runner.disableAddedPlugin[key] = true
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := makeInstallation(t)
			runner := newRunner()
			test.configure(runner, "codex:plugin-add:knowledge-maintenance")
			_, _, err := activation.Initialize(context.Background(), activation.Options{
				Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
			})
			if err == nil || !strings.Contains(err.Error(), "AGX-INIT-READBACK") {
				t.Fatalf("Initialize() err=%v", err)
			}
			if runner.states[provider.Codex].marketplaceSource != "" || len(runner.states[provider.Codex].plugins) != 0 {
				t.Fatalf("compensation left state: %+v", runner.states[provider.Codex])
			}
			state, statusErr := activation.Status(context.Background(), root, runner)
			if statusErr != nil || state.Status != activation.StatusAbsent {
				t.Fatalf("Status() state=%+v err=%v", state, statusErr)
			}
		})
	}
}

func TestUninitializeRetainsPreexistingMarketplaceAndBlocksBundleRemoval(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	source := filepath.Join(root, "components", "agent-plugins")
	runner.states[provider.Codex].marketplaceSource = source
	for _, pluginName := range mustPlugins(t, activation.ProfileCore) {
		runner.states[provider.Codex].plugins[pluginName] = true
	}
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-UNINSTALL-PROVIDER-OWNERSHIP") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if runner.states[provider.Codex].marketplaceSource == "" || len(runner.states[provider.Codex].plugins) != 4 {
		t.Fatalf("preexisting provider objects changed: %+v", runner.states[provider.Codex])
	}
}

func TestUninitializeCleansOwnedPluginsBeforeBlockingOnPreexistingMarketplace(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	source := filepath.Join(root, "components", "agent-plugins")
	runner.states[provider.Codex].marketplaceSource = source
	receipt, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Providers[0].MarketplaceAdded || len(receipt.Providers[0].AddedPlugins) != 4 {
		t.Fatalf("initialization ownership = %+v", receipt.Providers[0])
	}

	mutationsBeforeCleanup := len(runner.mutations)
	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-UNINSTALL-PROVIDER-OWNERSHIP") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if runner.states[provider.Codex].marketplaceSource != source || len(runner.states[provider.Codex].plugins) != 0 {
		t.Fatalf("provider state after ownership block = %+v", runner.states[provider.Codex])
	}
	for _, mutation := range runner.mutations[mutationsBeforeCleanup:] {
		if strings.Contains(mutation, "marketplace-remove") {
			t.Fatalf("pre-existing Marketplace was removed: %#v", runner.mutations[mutationsBeforeCleanup:])
		}
	}
	initializationReceipt := filepath.Join(root, ".agx", "initialization.json")
	if _, statErr := os.Stat(initializationReceipt); statErr != nil {
		t.Fatalf("initialization receipt was not retained: %v", statErr)
	}

	// The user releases the reference. Retrying only verifies that owned plugins
	// are already absent, then removes the retained initialization receipt.
	runner.states[provider.Codex].marketplaceSource = ""
	removed, err = activation.Uninitialize(context.Background(), root, runner)
	if err != nil || !removed {
		t.Fatalf("retry Uninitialize() removed=%v err=%v", removed, err)
	}
	if _, statErr := os.Stat(initializationReceipt); !os.IsNotExist(statErr) {
		t.Fatalf("initialization receipt remains after retry: %v", statErr)
	}
}

func TestUninitializeRechecksSourceBeforeFirstMutation(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	otherSource := filepath.Join(t.TempDir(), "other-marketplace")
	runner.afterNextPluginList[provider.Codex] = func() {
		runner.states[provider.Codex].marketplaceSource = otherSource
	}
	mutationsBeforeCleanup := len(runner.mutations)

	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-UNINSTALL-PROVIDER-SOURCE") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if len(runner.mutations) != mutationsBeforeCleanup {
		t.Fatalf("source changed after preflight but cleanup mutated provider: %#v", runner.mutations[mutationsBeforeCleanup:])
	}
	if _, statErr := os.Stat(filepath.Join(root, ".agx", "initialization.json")); statErr != nil {
		t.Fatalf("initialization receipt was not retained: %v", statErr)
	}
}

func TestUninitializeRechecksReceiptPathBeforeRemoval(t *testing.T) {
	probeTarget := t.TempDir()
	probeLink := filepath.Join(t.TempDir(), "directory-link")
	if err := os.Symlink(probeTarget, probeLink); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}
	if err := os.Remove(probeLink); err != nil {
		t.Fatal(err)
	}

	root := makeInstallation(t)
	runner := newRunner()
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(root, ".agx")
	sibling := filepath.Join(filepath.Dir(root), "sibling-metadata-after-cleanup")
	initializationReceiptBefore, err := os.ReadFile(filepath.Join(metadata, "initialization.json"))
	if err != nil {
		t.Fatal(err)
	}
	var hookErr error
	runner.afterMutation["codex:marketplace-remove:"] = func() {
		if err := os.Rename(metadata, sibling); err != nil {
			hookErr = err
			return
		}
		hookErr = os.Symlink(sibling, metadata)
	}

	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if hookErr != nil {
		t.Fatalf("metadata swap hook failed: %v", hookErr)
	}
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	initializationReceiptAfter, err := os.ReadFile(filepath.Join(sibling, "initialization.json"))
	if err != nil || string(initializationReceiptAfter) != string(initializationReceiptBefore) {
		t.Fatalf("sibling initialization receipt changed: err=%v", err)
	}
}

func TestUninitializeRejectsTamperedOwnershipReceipt(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
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
	receipt.Providers[0].AddedPlugins = append(receipt.Providers[0].AddedPlugins, "not-selected")
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	mutations := len(runner.mutations)
	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if len(runner.mutations) != mutations {
		t.Fatalf("tampered receipt caused provider writes: %#v", runner.mutations[mutations:])
	}
}

func TestUninitializeRejectsInstallationIdentityMismatch(t *testing.T) {
	root := makeInstallation(t)
	runner := newRunner()
	_, _, err := activation.Initialize(context.Background(), activation.Options{
		Root: root, Profile: activation.ProfileCore, Providers: []provider.Name{provider.Codex}, Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(root, ".agx", "receipt.json")
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt installer.Receipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.InstallationID = "replacement-installation"
	data, err = json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receiptPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := activation.Status(context.Background(), root, runner)
	if err != nil || state.Status != activation.StatusDrifted {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
	mutations := len(runner.mutations)
	removed, err := activation.Uninitialize(context.Background(), root, runner)
	if err == nil || removed || !strings.Contains(err.Error(), "AGX-UNINSTALL-PROVIDER-OWNERSHIP") {
		t.Fatalf("Uninitialize() removed=%v err=%v", removed, err)
	}
	if len(runner.mutations) != mutations {
		t.Fatalf("identity mismatch caused provider writes: %#v", runner.mutations[mutations:])
	}
}

func makeInstallation(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "installation")
	pluginFile := filepath.Join(root, "components", "agent-plugins", "README.md")
	controlFile := filepath.Join(root, "components", "agent-control", "README.md")
	for _, path := range []string{pluginFile, controlFile} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	receipt := installer.Receipt{
		SchemaVersion: "agx.receipt/v1", InstallationID: "install-test", BundleID: "bundle-test",
		BundleSHA256: strings.Repeat("e", 64), Phase: "configured",
		Components: []installer.Component{
			{
				Name: "agent-control", Repository: "2233admin/agent-control", CommitSHA: strings.Repeat("a", 40),
				AssetSHA256: strings.Repeat("c", 64), Path: "components/agent-control",
			},
			{
				Name: "agent-plugins", Repository: "2233admin/agent-plugins", CommitSHA: strings.Repeat("b", 40),
				AssetSHA256: strings.Repeat("d", 64), Path: "components/agent-plugins",
			},
		},
		OwnedFiles: []string{"components/agent-control/README.md", "components/agent-plugins/README.md"},
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

func mustPlugins(t *testing.T, profile activation.Profile) []string {
	t.Helper()
	plugins, err := activation.Plugins(profile)
	if err != nil {
		t.Fatal(err)
	}
	return plugins
}

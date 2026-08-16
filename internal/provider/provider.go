// Package provider wraps the structured plugin-management surfaces exposed by
// Codex and Claude. It never reads credentials or provider configuration files.
package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const MarketplaceName = "agent-plugins"

type Name string

const (
	Codex  Name = "codex"
	Claude Name = "claude"
)

type Runner interface {
	LookPath(name string) (string, error)
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type OSRunner struct{}

func (OSRunner) LookPath(name string) (string, error) {
	return exec.LookPath(name)
}

func (OSRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("provider command %q failed: %w", name, err)
	}
	return output, nil
}

type Marketplace struct {
	Present    bool
	SourceType string
	Source     string
}

type Plugin struct {
	Name    string
	Version string
	Enabled bool
}

type Inventory struct {
	Provider    Name
	Marketplace Marketplace
	Plugins     map[string]Plugin
}

func (inventory Inventory) Plugin(name string) (Plugin, bool) {
	plugin, ok := inventory.Plugins[name]
	return plugin, ok
}

func ParseName(value string) (Name, error) {
	switch Name(strings.ToLower(strings.TrimSpace(value))) {
	case Codex:
		return Codex, nil
	case Claude:
		return Claude, nil
	default:
		return "", fmt.Errorf("AGX-INIT-PROVIDER: unsupported provider %q", value)
	}
}

func Inspect(ctx context.Context, name Name, runner Runner) (Inventory, error) {
	if runner == nil {
		runner = OSRunner{}
	}
	if _, err := runner.LookPath(string(name)); err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-PROVIDER-MISSING: %s CLI is unavailable", name)
	}
	marketplaceJSON, err := runner.Run(ctx, string(name), "plugin", "marketplace", "list", "--json")
	if err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-INVENTORY: cannot read %s Marketplace inventory: %w", name, err)
	}
	pluginJSON, err := runner.Run(ctx, string(name), "plugin", "list", "--json")
	if err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-INVENTORY: cannot read %s plugin inventory: %w", name, err)
	}
	if name == Codex {
		return parseCodex(marketplaceJSON, pluginJSON)
	}
	return parseClaude(marketplaceJSON, pluginJSON)
}

func AddMarketplace(ctx context.Context, name Name, source string, runner Runner) error {
	if name == Codex {
		_, err := runner.Run(ctx, string(name), "plugin", "marketplace", "add", source, "--json")
		return mutationError(name, "add Marketplace", err)
	}
	_, err := runner.Run(ctx, string(name), "plugin", "marketplace", "add", source, "--scope", "user")
	return mutationError(name, "add Marketplace", err)
}

func RemoveMarketplace(ctx context.Context, name Name, runner Runner) error {
	if name == Codex {
		_, err := runner.Run(ctx, string(name), "plugin", "marketplace", "remove", MarketplaceName, "--json")
		return mutationError(name, "remove Marketplace", err)
	}
	_, err := runner.Run(ctx, string(name), "plugin", "marketplace", "remove", MarketplaceName, "--scope", "user")
	return mutationError(name, "remove Marketplace", err)
}

func InstallPlugin(ctx context.Context, name Name, plugin string, runner Runner) error {
	id := plugin + "@" + MarketplaceName
	if name == Codex {
		_, err := runner.Run(ctx, string(name), "plugin", "add", id, "--json")
		return mutationError(name, "install plugin", err)
	}
	_, err := runner.Run(ctx, string(name), "plugin", "install", id, "--scope", "user", "--yes")
	return mutationError(name, "install plugin", err)
}

func RemovePlugin(ctx context.Context, name Name, plugin string, runner Runner) error {
	id := plugin + "@" + MarketplaceName
	if name == Codex {
		_, err := runner.Run(ctx, string(name), "plugin", "remove", id, "--json")
		return mutationError(name, "remove plugin", err)
	}
	_, err := runner.Run(ctx, string(name), "plugin", "uninstall", id, "--scope", "user", "--yes")
	return mutationError(name, "remove plugin", err)
}

func mutationError(name Name, operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("AGX-INIT-MUTATION: %s could not %s: %w", name, operation, err)
}

func SameSource(actual, expected string) bool {
	if actual == "" || expected == "" {
		return false
	}
	return canonicalPath(actual) == canonicalPath(expected)
}

func canonicalPath(value string) string {
	value = strings.TrimPrefix(value, `\\?\`)
	absolute, err := filepath.Abs(value)
	if err == nil {
		value = absolute
	}
	if resolved, err := filepath.EvalSymlinks(value); err == nil {
		value = resolved
	}
	value = filepath.Clean(value)
	if runtime.GOOS == "windows" {
		value = strings.ToLower(value)
	}
	return value
}

type codexMarketplaceList struct {
	Marketplaces []struct {
		Name              string `json:"name"`
		Root              string `json:"root"`
		MarketplaceSource *struct {
			SourceType string `json:"sourceType"`
			Source     string `json:"source"`
		} `json:"marketplaceSource"`
	} `json:"marketplaces"`
}

type codexPluginList struct {
	Installed []struct {
		PluginID    string `json:"pluginId"`
		Name        string `json:"name"`
		Marketplace string `json:"marketplaceName"`
		Version     string `json:"version"`
		Installed   bool   `json:"installed"`
		Enabled     bool   `json:"enabled"`
	} `json:"installed"`
}

func parseCodex(marketplaceJSON, pluginJSON []byte) (Inventory, error) {
	var marketplaces codexMarketplaceList
	if err := strictJSON(marketplaceJSON, &marketplaces); err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-INVENTORY: invalid Codex Marketplace JSON: %w", err)
	}
	var plugins codexPluginList
	if err := strictJSON(pluginJSON, &plugins); err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-INVENTORY: invalid Codex plugin JSON: %w", err)
	}
	inventory := Inventory{Provider: Codex, Plugins: map[string]Plugin{}}
	for _, marketplace := range marketplaces.Marketplaces {
		if marketplace.Name != MarketplaceName {
			continue
		}
		inventory.Marketplace = Marketplace{Present: true, SourceType: "local", Source: marketplace.Root}
		if marketplace.MarketplaceSource != nil {
			inventory.Marketplace.SourceType = marketplace.MarketplaceSource.SourceType
			inventory.Marketplace.Source = marketplace.MarketplaceSource.Source
		}
		break
	}
	for _, plugin := range plugins.Installed {
		if plugin.Marketplace != MarketplaceName || !plugin.Installed {
			continue
		}
		inventory.Plugins[plugin.Name] = Plugin{Name: plugin.Name, Version: plugin.Version, Enabled: plugin.Enabled}
	}
	return inventory, nil
}

type claudeMarketplace struct {
	Name            string `json:"name"`
	Source          string `json:"source"`
	Repo            string `json:"repo"`
	URL             string `json:"url"`
	Path            string `json:"path"`
	InstallLocation string `json:"installLocation"`
}

type claudePlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Scope   string `json:"scope"`
	Enabled bool   `json:"enabled"`
}

func parseClaude(marketplaceJSON, pluginJSON []byte) (Inventory, error) {
	var marketplaces []claudeMarketplace
	if err := strictJSON(marketplaceJSON, &marketplaces); err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-INVENTORY: invalid Claude Marketplace JSON: %w", err)
	}
	var plugins []claudePlugin
	if err := strictJSON(pluginJSON, &plugins); err != nil {
		return Inventory{}, fmt.Errorf("AGX-INIT-INVENTORY: invalid Claude plugin JSON: %w", err)
	}
	inventory := Inventory{Provider: Claude, Plugins: map[string]Plugin{}}
	for _, marketplace := range marketplaces {
		if marketplace.Name != MarketplaceName {
			continue
		}
		source := marketplace.Path
		if source == "" {
			source = marketplace.Repo
		}
		if source == "" {
			source = marketplace.URL
		}
		if source == "" {
			source = marketplace.InstallLocation
		}
		inventory.Marketplace = Marketplace{Present: true, SourceType: marketplace.Source, Source: source}
		break
	}
	for _, plugin := range plugins {
		if plugin.Scope != "user" || !strings.HasSuffix(plugin.ID, "@"+MarketplaceName) {
			continue
		}
		name := strings.TrimSuffix(plugin.ID, "@"+MarketplaceName)
		inventory.Plugins[name] = Plugin{Name: name, Version: plugin.Version, Enabled: plugin.Enabled}
	}
	return inventory, nil
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return fmt.Errorf("trailing JSON value")
	} else if err != io.EOF {
		return err
	}
	return nil
}

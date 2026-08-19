package activation_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/bundle"
)

func TestFullProfileCoversPinnedBundleMarketplace(t *testing.T) {
	document, err := bundle.Decode(bundle.Production())
	if err != nil {
		t.Fatalf("Decode(Production()) error = %v", err)
	}
	commit := document.Sources.AgentPlugins.CommitSHA
	data, err := os.ReadFile(marketplaceFixturePath(commit))
	if err != nil {
		t.Fatalf("offline marketplace fixture for production pin %s: %v", commit, err)
	}
	if err := fullProfileMustCoverMarketplace(data); err != nil {
		t.Fatal(err)
	}
}

func TestFullProfileMissingMarketplacePluginFails(t *testing.T) {
	err := fullProfileMustCoverMarketplace([]byte(`{
		"plugins": [
			{"name": "grilling"},
			{"name": "skill-maintenance"}
		]
	}`))
	if err == nil {
		t.Fatal("expected full profile to fail when marketplace has an uncovered plugin")
	}
	if want := `full profile does not cover marketplace plugin "skill-maintenance"`; err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}

func marketplaceFixturePath(commit string) string {
	return filepath.Join("..", "..", "testdata", "bundles", "marketplace", commit+".json")
}

func fullProfileMustCoverMarketplace(data []byte) error {
	names, err := marketplacePluginNames(data)
	if err != nil {
		return err
	}
	full, err := activation.Plugins(activation.ProfileFull)
	if err != nil {
		return err
	}
	for _, name := range names {
		if !slices.Contains(full, name) {
			return fmt.Errorf("full profile does not cover marketplace plugin %q", name)
		}
	}
	return nil
}

func marketplacePluginNames(data []byte) ([]string, error) {
	var document struct {
		Plugins []struct {
			Name string `json:"name"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	if len(document.Plugins) == 0 {
		return nil, fmt.Errorf("marketplace fixture contains no plugins")
	}
	names := make([]string, 0, len(document.Plugins))
	for _, plugin := range document.Plugins {
		if plugin.Name == "" {
			return nil, fmt.Errorf("marketplace fixture contains an unnamed plugin")
		}
		names = append(names, plugin.Name)
	}
	return names, nil
}

package bundle_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bundle"
)

func TestProductionMatchesRepositoryFixtureAndReturnsIsolatedCopies(t *testing.T) {
	want, err := os.ReadFile(filepath.Join("..", "..", "testdata", "bundles", "v2-production-agx-bootstrap-20260816.1.json"))
	if err != nil {
		t.Fatal(err)
	}

	first := bundle.Production()
	if !bytes.Equal(first, want) {
		t.Fatal("Production() does not byte-match the repository production fixture")
	}
	document, err := bundle.Decode(first)
	if err != nil {
		t.Fatalf("Decode(Production()) error = %v", err)
	}
	if document.Mode != bundle.ModeProduction || document.BundleID != "agx-bootstrap-20260816.1" {
		t.Fatalf("production document = %#v", document)
	}

	first[0] ^= 0xff
	second := bundle.Production()
	if !bytes.Equal(second, want) {
		t.Fatal("mutating a Production() result polluted the embedded Bundle")
	}
}

func TestDecodeAcceptsProductionBundleV2(t *testing.T) {
	document := decodeFixture(t, "production-valid.json")

	if document.SchemaVersion != bundle.SchemaVersionV2 {
		t.Fatalf("SchemaVersion = %q", document.SchemaVersion)
	}
	if document.BundleID != "agx-bootstrap-20260816.1" || document.Mode != bundle.ModeProduction {
		t.Fatalf("production document = %#v", document)
	}
	artifact := document.Sources.AgentPlugins
	if artifact.UpstreamRepository != "zaurakworks/agent-plugins" || artifact.DistributionRepository != "2233admin/agent-plugins" {
		t.Fatalf("agent_plugins source = %#v", artifact)
	}
	if document.Templates.Version != "bootstrap-20260817.1" || document.Templates.References.AgentContracts.CommitSHA != "5bb8ea0b54f063b0758c294b73ea270ba69322d2" {
		t.Fatalf("templates = %#v", document.Templates)
	}
}

func TestProductionFixturePinsSinglePluginRelease(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "bundles", "v2-production-agx-bootstrap-20260816.1.json"))
	if err != nil {
		t.Fatal(err)
	}
	document, err := bundle.Decode(data)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	artifact := document.Sources.AgentPlugins
	if artifact.ReleaseTag != "agx-bootstrap-20260816.1" || artifact.CommitSHA != "eb10f7f14cc05b70b6c27a121c6f72d1b3b9edb8" {
		t.Fatalf("release pin = %#v", artifact)
	}
	if artifact.AssetSHA256 != "ba8142548d7b055b4f6faba4587b12a9c6411815431042607436676437ae2de1" || artifact.ContentSHA256 != "d4f53c2d2d45f7efcb2884d8232248434bae44f071369cc938aface47e120002" {
		t.Fatalf("release digests = %#v", artifact)
	}
}

func TestDecodeAcceptsExplicitDevelopmentDowngrade(t *testing.T) {
	document := decodeFixture(t, "development-valid.json")

	if document.Mode != bundle.ModeDevelopment || !document.DevelopmentOverride {
		t.Fatalf("development document = %#v", document)
	}
}

func TestDecodeRejectsLegacyAndDualComponentContracts(t *testing.T) {
	legacyV1 := []byte(`{"schema_version":"agx.bundle/v1"}`)
	if _, err := bundle.Decode(legacyV1); err == nil || !strings.HasPrefix(err.Error(), "AGX-BUNDLE-SCHEMA") {
		t.Fatalf("legacy v1 error = %v", err)
	}

	dualComponent := mutateFixture(t, "production-valid.json", func(document map[string]any) {
		sources := document["sources"].(map[string]any)
		sources["agent_control"] = map[string]any{"repository": "2233admin/agent-control"}
	})
	if _, err := bundle.Decode(dualComponent); err == nil || !strings.HasPrefix(err.Error(), "AGX-BUNDLE-DECODE") {
		t.Fatalf("dual-component error = %v", err)
	}

	legacyArtifacts := mutateFixture(t, "production-valid.json", func(document map[string]any) {
		delete(document, "sources")
		document["artifacts"] = map[string]any{
			"agent_control": map[string]any{},
			"agent_plugins": map[string]any{},
		}
	})
	if _, err := bundle.Decode(legacyArtifacts); err == nil || !strings.HasPrefix(err.Error(), "AGX-BUNDLE-DECODE") {
		t.Fatalf("legacy artifacts error = %v", err)
	}
}

func TestDecodeRejectsWrongSourceAndTemplateProvenance(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(map[string]any)
		wantPrefix string
	}{
		{
			name: "wrong upstream repository",
			mutate: func(document map[string]any) {
				agentPlugins(document)["upstream_repository"] = "example/agent-plugins"
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "wrong distribution repository",
			mutate: func(document map[string]any) {
				agentPlugins(document)["distribution_repository"] = "zaurakworks/agent-plugins"
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "wrong reference repository",
			mutate: func(document map[string]any) {
				templateReference(document, "agent_control")["repository"] = "2233admin/agent-control"
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "wrong reference commit",
			mutate: func(document map[string]any) {
				templateReference(document, "agent_contracts")["commit_sha"] = "not-a-commit"
			},
			wantPrefix: "AGX-BUNDLE-VALIDATION",
		},
		{
			name: "different valid reference commit",
			mutate: func(document map[string]any) {
				templateReference(document, "agent_contracts")["commit_sha"] = strings.Repeat("a", 40)
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "wrong template digest",
			mutate: func(document map[string]any) {
				document["templates"].(map[string]any)["content_sha256"] = "not-a-digest"
			},
			wantPrefix: "AGX-BUNDLE-VALIDATION",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := bundle.Decode(mutateFixture(t, "production-valid.json", test.mutate))
			if err == nil || !strings.HasPrefix(err.Error(), test.wantPrefix) {
				t.Fatalf("Decode() error = %v, want prefix %q", err, test.wantPrefix)
			}
		})
	}
}

func TestDecodeRejectsUnsafeOrInvalidMetadata(t *testing.T) {
	tests := []struct {
		name       string
		data       func(*testing.T) []byte
		wantPrefix string
	}{
		{
			name: "unknown field",
			data: func(t *testing.T) []byte {
				return mutateFixture(t, "production-valid.json", func(document map[string]any) { document["unknown"] = true })
			},
			wantPrefix: "AGX-BUNDLE-DECODE",
		},
		{
			name: "duplicate field",
			data: func(*testing.T) []byte {
				return []byte(`{"schema_version":"agx.bundle/v2","schema_version":"agx.bundle/v2"}`)
			},
			wantPrefix: "AGX-BUNDLE-DECODE",
		},
		{
			name: "production override",
			data: func(t *testing.T) []byte {
				return mutateFixture(t, "production-valid.json", func(document map[string]any) { document["development_override"] = true })
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "mutable release URL",
			data: func(t *testing.T) []byte {
				return mutateFixture(t, "production-valid.json", func(document map[string]any) {
					agentPlugins(document)["download_url"] = "https://github.com/2233admin/agent-plugins/archive/main.tar.gz"
				})
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "local path",
			data: func(t *testing.T) []byte {
				return mutateFixture(t, "production-valid.json", func(document map[string]any) {
					agentPlugins(document)["download_url"] = "file:///workspace/agent-plugins.tar.gz"
				})
			},
			wantPrefix: "AGX-BUNDLE-PROVENANCE",
		},
		{
			name: "malformed digest",
			data: func(t *testing.T) []byte {
				return mutateFixture(t, "production-valid.json", func(document map[string]any) {
					agentPlugins(document)["asset_sha256"] = "not-a-digest"
				})
			},
			wantPrefix: "AGX-BUNDLE-VALIDATION",
		},
		{
			name: "Multica compatibility",
			data: func(t *testing.T) []byte {
				return mutateFixture(t, "production-valid.json", func(document map[string]any) {
					document["compatibility"].(map[string]any)["multica_cli"] = "unsupported"
				})
			},
			wantPrefix: "AGX-BUNDLE-DECODE",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := bundle.Decode(test.data(t))
			if err == nil || !strings.HasPrefix(err.Error(), test.wantPrefix) {
				t.Fatalf("Decode() error = %v, want prefix %q", err, test.wantPrefix)
			}
		})
	}
}

func TestDecodeRequiresExplicitDevelopmentOverride(t *testing.T) {
	data := mutateFixture(t, "production-valid.json", func(document map[string]any) {
		delete(document, "development_override")
	})

	_, err := bundle.Decode(data)
	if err == nil || !strings.HasPrefix(err.Error(), "AGX-BUNDLE-VALIDATION") {
		t.Fatalf("Decode() error = %v, want development_override validation error", err)
	}
}

func decodeFixture(t *testing.T, name string) bundle.Document {
	t.Helper()
	document, err := bundle.Decode(readFixture(t, name))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	return document
}

func mutateFixture(t *testing.T, name string, mutate func(map[string]any)) []byte {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(readFixture(t, name), &document); err != nil {
		t.Fatal(err)
	}
	mutate(document)
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func agentPlugins(document map[string]any) map[string]any {
	return document["sources"].(map[string]any)["agent_plugins"].(map[string]any)
}

func templateReference(document map[string]any, name string) map[string]any {
	return document["templates"].(map[string]any)["references"].(map[string]any)[name].(map[string]any)
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "bundle-runtime", name))
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", name, err)
	}
	return data
}

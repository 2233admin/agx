package bundle_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bundle"
)

func TestDecodeAcceptsProductionBundle(t *testing.T) {
	document := decodeFixture(t, "production-valid.json")

	if document.BundleID != "agx-bootstrap-20260816.1" {
		t.Fatalf("BundleID = %q", document.BundleID)
	}
	if document.Mode != bundle.ModeProduction {
		t.Fatalf("Mode = %q", document.Mode)
	}
	if document.Artifacts.AgentControl.Repository != "2233admin/agent-control" {
		t.Fatalf("agent_control repository = %q", document.Artifacts.AgentControl.Repository)
	}
}

func TestDecodeAcceptsExplicitDevelopmentDowngrade(t *testing.T) {
	document := decodeFixture(t, "development-valid.json")

	if document.Mode != bundle.ModeDevelopment || !document.DevelopmentOverride {
		t.Fatalf("development document = %#v", document)
	}
}

func TestDecodeRejectsUnsafeOrInvalidMetadata(t *testing.T) {
	tests := []struct {
		name       string
		fixture    string
		wantPrefix string
	}{
		{name: "unknown field", fixture: "unknown-field.json", wantPrefix: "AGX-BUNDLE-DECODE"},
		{name: "duplicate field", fixture: "duplicate-field.json", wantPrefix: "AGX-BUNDLE-DECODE"},
		{name: "production override", fixture: "production-override.json", wantPrefix: "AGX-BUNDLE-PROVENANCE"},
		{name: "mutable release URL", fixture: "mutable-url.json", wantPrefix: "AGX-BUNDLE-PROVENANCE"},
		{name: "local path", fixture: "local-path.json", wantPrefix: "AGX-BUNDLE-PROVENANCE"},
		{name: "malformed digest", fixture: "malformed-digest.json", wantPrefix: "AGX-BUNDLE-VALIDATION"},
		{name: "unsupported schema", fixture: "unsupported-schema.json", wantPrefix: "AGX-BUNDLE-SCHEMA"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := bundle.Decode(readFixture(t, test.fixture))
			if err == nil {
				t.Fatal("Decode() error = nil")
			}
			if !strings.HasPrefix(err.Error(), test.wantPrefix) {
				t.Fatalf("Decode() error = %q, want prefix %q", err, test.wantPrefix)
			}
		})
	}
}

func TestDecodeRequiresExplicitDevelopmentOverride(t *testing.T) {
	data := []byte(`{
  "schema_version": "agx.bundle/v1",
  "bundle_id": "bundle-001",
  "mode": "production",
  "provenance": "github_release",
  "compatibility": {"agx": "x", "multica_cli": "x"},
  "artifacts": {}
}`)

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

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "bundle-runtime", name))
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", name, err)
	}
	return data
}

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
)

func TestStatusSurfacesConfigsRuntimeInJSON(t *testing.T) {
	root := writeConfigTestInstallation(t)
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"status", "--root", root, "--output", "json"}, "test", stdout, stderr,
		runtimeDependencies{statusWithEvidence: func(context.Context, string, provider.Runner, activation.StatusOptions, ...repository.Runner) (activation.State, error) {
			return activation.State{Status: "configured"}, nil
		}},
	)
	if code != 0 {
		t.Fatalf("status code=%d stderr=%q", code, stderr.String())
	}
	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("status JSON: %v; stdout=%q", err, stdout.String())
	}
	runtime, ok := result["configs_runtime"].(map[string]any)
	if !ok || runtime["installed"] != true || runtime["path"] != "components/configs-runtime/configs.exe" || runtime["integrity"] != "matched" {
		t.Fatalf("configs_runtime=%#v result=%#v", runtime, result)
	}
}

func TestStatusSurfacesConfigsRuntimeInHumanOutput(t *testing.T) {
	root := writeConfigTestInstallation(t)
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"status", "--root", root}, "test", stdout, stderr,
		runtimeDependencies{statusWithEvidence: func(context.Context, string, provider.Runner, activation.StatusOptions, ...repository.Runner) (activation.State, error) {
			return activation.State{Status: "configured"}, nil
		}},
	)
	if code != 0 || !strings.Contains(stdout.String(), "Configs runtime: installed") ||
		!strings.Contains(stdout.String(), "configs-v0.synthetic") ||
		!strings.Contains(stdout.String(), "commit dddddddddddddddddddddddddddddddddddddddd") ||
		!strings.Contains(stdout.String(), "Asset SHA-256: ") ||
		!strings.Contains(stdout.String(), "Content SHA-256: ") {
		t.Fatalf("status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}
func TestStatusSurfacesRuntimeDrift(t *testing.T) {
	root := writeConfigTestInstallation(t)
	runtimePath := filepath.Join(root, filepath.FromSlash("components/configs-runtime/configs.exe"))
	if err := os.WriteFile(runtimePath, []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := runWithDependencies(
		[]string{"status", "--root", root, "--output", "json"}, "test", stdout, stderr,
		runtimeDependencies{statusWithEvidence: func(context.Context, string, provider.Runner, activation.StatusOptions, ...repository.Runner) (activation.State, error) {
			return activation.State{Status: "configured"}, nil
		}},
	)
	if code != 0 {
		t.Fatalf("status code=%d stderr=%q", code, stderr.String())
	}
	var result struct {
		ConfigsRuntime configsRuntimeStatus `json:"configs_runtime"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ConfigsRuntime.Integrity != "modified" {
		t.Fatalf("configs runtime status=%+v", result.ConfigsRuntime)
	}
}

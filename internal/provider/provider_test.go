package provider_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/2233admin/agx/internal/provider"
)

type fakeRunner struct {
	outputs map[string][]byte
	calls   []string
}

func (runner *fakeRunner) LookPath(name string) (string, error) {
	if name == "missing" {
		return "", errors.New("not found")
	}
	return "/bin/" + name, nil
}

func (runner *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	key := name
	for _, argument := range args {
		key += " " + argument
	}
	runner.calls = append(runner.calls, key)
	output, ok := runner.outputs[key]
	if !ok {
		return nil, errors.New("unexpected command")
	}
	return output, nil
}

func TestInspectCodexStructuredInventory(t *testing.T) {
	runner := &fakeRunner{outputs: map[string][]byte{
		"codex plugin marketplace list --json": []byte(`{"marketplaces":[{"name":"agent-plugins","root":"C:/agx/plugins"}]}`),
		"codex plugin list --json":             []byte(`{"installed":[{"pluginId":"grilling@agent-plugins","name":"grilling","marketplaceName":"agent-plugins","version":"0.1.2","installed":true,"enabled":true}],"available":[]}`),
	}}
	inventory, err := provider.Inspect(context.Background(), provider.Codex, runner)
	if err != nil {
		t.Fatal(err)
	}
	if !inventory.Marketplace.Present || inventory.Marketplace.Source != "C:/agx/plugins" {
		t.Fatalf("Marketplace = %+v", inventory.Marketplace)
	}
	plugin, ok := inventory.Plugin("grilling")
	if !ok || !plugin.Enabled || plugin.Version != "0.1.2" {
		t.Fatalf("plugin = %+v, present=%v", plugin, ok)
	}
}

func TestInspectClaudeUsesUserScope(t *testing.T) {
	runner := &fakeRunner{outputs: map[string][]byte{
		"claude plugin marketplace list --json": []byte(`[{"name":"agent-plugins","source":"directory","path":"/agx/plugins","installLocation":"/cache"}]`),
		"claude plugin list --json":             []byte(`[{"id":"grilling@agent-plugins","version":"0.1.2","scope":"project","enabled":false},{"id":"grilling@agent-plugins","version":"0.1.2","scope":"user","enabled":true}]`),
	}}
	inventory, err := provider.Inspect(context.Background(), provider.Claude, runner)
	if err != nil {
		t.Fatal(err)
	}
	plugin, ok := inventory.Plugin("grilling")
	if !ok || !plugin.Enabled {
		t.Fatalf("plugin = %+v, present=%v", plugin, ok)
	}
}

func TestInspectRejectsMalformedTrailingJSON(t *testing.T) {
	runner := &fakeRunner{outputs: map[string][]byte{
		"codex plugin marketplace list --json": []byte(`{"marketplaces":[]}`),
		"codex plugin list --json":             []byte(`{"installed":[]} trailing`),
	}}
	if _, err := provider.Inspect(context.Background(), provider.Codex, runner); err == nil {
		t.Fatal("Inspect() accepted malformed trailing JSON")
	}
}

func TestMutationCommandsAreProviderNative(t *testing.T) {
	runner := &fakeRunner{outputs: map[string][]byte{
		"codex plugin marketplace add C:/agx/plugins --json":              {},
		"codex plugin add grilling@agent-plugins --json":                  {},
		"claude plugin marketplace add C:/agx/plugins --scope user":       {},
		"claude plugin install grilling@agent-plugins --scope user --yes": {},
	}}
	for _, name := range []provider.Name{provider.Codex, provider.Claude} {
		if err := provider.AddMarketplace(context.Background(), name, "C:/agx/plugins", runner); err != nil {
			t.Fatal(err)
		}
		if err := provider.InstallPlugin(context.Background(), name, "grilling", runner); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{
		"codex plugin marketplace add C:/agx/plugins --json",
		"codex plugin add grilling@agent-plugins --json",
		"claude plugin marketplace add C:/agx/plugins --scope user",
		"claude plugin install grilling@agent-plugins --scope user --yes",
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("calls = %#v, want %#v", runner.calls, want)
	}
}

func TestSameSourceNormalizesPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plugins")
	if !provider.SameSource(path, filepath.Join(path, ".")) {
		t.Fatal("SameSource did not normalize an equivalent path")
	}
	if provider.SameSource(path, filepath.Join(t.TempDir(), "plugins")) {
		t.Fatal("SameSource accepted different paths")
	}
}

func TestOSRunnerLaunchesPlatformCommandWrappers(t *testing.T) {
	directory := t.TempDir()
	name := "agx-provider-wrapper-test"
	path := filepath.Join(directory, name)
	if runtime.GOOS == "windows" {
		path += ".cmd"
		if err := os.WriteFile(path, []byte("@echo off\r\necho %~1^|%~2\r\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s|%s\\n' \"$1\" \"$2\"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	output, err := (provider.OSRunner{}).Run(context.Background(), name, "hello world", "second")
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "hello world|second\r\n" && string(output) != "hello world|second\n" {
		t.Fatalf("output = %q", output)
	}
}

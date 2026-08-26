package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRunConfigForwardsRootAndArgsToInjectedRunner(t *testing.T) {
	root := writeConfigTestInstallation(t)
	var gotRoot string
	var gotArgs []string
	var stdout, stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"config", "--root", root, "list", "--value", "x y"},
		"test", &stdout, &stderr,
		runtimeDependencies{
			stdin: strings.NewReader("input"),
			configRun: func(_ context.Context, root string, _ installer.Receipt, args []string, stdin io.Reader, out, errOut io.Writer) int {
				gotRoot = root
				gotArgs = append([]string(nil), args...)
				_, _ = io.Copy(out, stdin)
				return 23
			},
		},
	)
	if code != 23 || gotRoot != root || !reflect.DeepEqual(gotArgs, []string{"list", "--value", "x y"}) {
		t.Fatalf("code=%d root=%q args=%v stdout=%q stderr=%q", code, gotRoot, gotArgs, stdout.String(), stderr.String())
	}
}

func TestRunConfigRejectsManagedRuntimeOverrides(t *testing.T) {
	for _, token := range []string{"--root", "--runtime-path", "--db-path"} {
		stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
		args := []string{"config", "--root", t.TempDir(), "list", token}
		code := runWithDependencies(args, "test", stdout, stderr, runtimeDependencies{})
		if code != exitcode.Usage || !strings.Contains(stderr.String(), "AGX-USAGE-CONFIG") {
			t.Fatalf("args=%v code=%d stderr=%q", args, code, stderr.String())
		}
	}
}

func writeConfigTestInstallation(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runtimeData := []byte("runtime")
	runtimePath := "components/configs-runtime/configs.exe"
	pluginPath := "components/agent-plugins/README.md"
	for relative, data := range map[string][]byte{runtimePath: runtimeData, pluginPath: []byte("plugin")} {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	runtimeDigest := sha256.Sum256(runtimeData)
	pluginDigest := sha256.Sum256([]byte("plugin"))
	runtimeHex := hex.EncodeToString(runtimeDigest[:])
	pluginHex := hex.EncodeToString(pluginDigest[:])
	receipt := installer.Receipt{
		SchemaVersion: "agx.receipt/v2", InstallationID: "test", BundleID: "test", BundleSHA256: strings.Repeat("a", 64), TemplateVersion: bootstrap.TemplateSetVersion, TemplateContentSHA256: bootstrap.TemplateSetContentSHA256, Phase: "configured",
		Components:     []installer.Component{{Name: "agent-plugins", Repository: "zaurakworks/agent-plugins", DistributionRepository: "2233admin/agent-plugins", CommitSHA: strings.Repeat("b", 40), AssetSHA256: strings.Repeat("c", 64), Path: "components/agent-plugins"}},
		ConfigsRuntime: &installer.ConfigsRuntimeReceipt{RuntimeID: "configs", Version: "configs-v0.synthetic", SourceRepository: "2233admin/agent-systemX", ReleaseTag: "configs-v0.synthetic", CommitSHA: strings.Repeat("d", 40), ContractVersion: "configs/v1", Platform: "windows", Architecture: "amd64", AssetSHA256: runtimeHex, ContentSHA256: runtimeHex, Path: runtimePath},
		OwnedFiles:     []string{pluginPath, runtimePath}, OwnedFileSHA256: map[string]string{pluginPath: pluginHex, runtimePath: runtimeHex},
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

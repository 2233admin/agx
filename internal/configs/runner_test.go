package configs_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/configs"
	installer "github.com/2233admin/agx/internal/install"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func init() {
	if os.Getenv("AGX_CONFIGS_HELPER") != "1" {
		return
	}
	fmt.Printf("ARGS=%q\n", os.Args[1:])
	fmt.Printf("DB=%s\n", os.Getenv("CONTROL_PLANE_DB_PATH"))
	payload, _ := io.ReadAll(os.Stdin)
	fmt.Printf("IN=%s\n", payload)
	fmt.Fprint(os.Stderr, "helper-stderr\n")
	if len(os.Args) > 1 && os.Args[1] == "sleep" {
		for {
			time.Sleep(time.Second)
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "exit7" {
		os.Exit(7)
	}
	os.Exit(0)
}

func TestRunForwardsArgvEnvironmentAndStdio(t *testing.T) {
	root, receipt := helperRuntime(t)
	var stdout, stderr bytes.Buffer
	code := configs.Run(context.Background(), root, receipt, []string{"list", "--value", "a b"}, strings.NewReader("input\n"), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("Run() code = %d, stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `ARGS=["list" "--value" "a b"]`) || !strings.Contains(stdout.String(), "IN=input\n") {
		t.Fatalf("stdout = %q", stdout.String())
	}
	dbPath := filepath.Join(root, ".agx", "configs", "control-plane.sqlite3")
	if !strings.Contains(stdout.String(), "DB="+dbPath) || !strings.Contains(stderr.String(), "helper-stderr") {
		t.Fatalf("stdio/env output stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("runner created database path: %v", err)
	}
}

func TestRunReturnsChildExitCode(t *testing.T) {
	root, receipt := helperRuntime(t)
	var stderr bytes.Buffer
	code := configs.Run(context.Background(), root, receipt, []string{"exit7"}, strings.NewReader(""), io.Discard, &stderr)
	if code != 7 {
		t.Fatalf("Run() code = %d, want child code 7; stderr=%q", code, stderr.String())
	}
}

func TestRunFailsClosedWithoutRuntimeBinding(t *testing.T) {
	root := t.TempDir()
	var stderr bytes.Buffer
	code := configs.Run(context.Background(), root, installer.Receipt{}, nil, nil, io.Discard, &stderr)
	if code == 0 || !strings.Contains(stderr.String(), "AGX-CONFIG-RUNTIME") {
		t.Fatalf("Run() code=%d stderr=%q", code, stderr.String())
	}
}

func TestRunMapsContextCancellationToSoftwareError(t *testing.T) {
	root, receipt := helperRuntime(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- configs.Run(ctx, root, receipt, []string{"sleep"}, strings.NewReader(""), io.Discard, &stderr)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case code := <-done:
		if code == 0 || !strings.Contains(stderr.String(), "AGX-CONFIG-RUNTIME") {
			t.Fatalf("Run() code=%d stderr=%q", code, stderr.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run() did not stop after cancellation")
	}
}

func helperRuntime(t *testing.T) (string, installer.Receipt) {
	t.Setenv("AGX_CONFIGS_HELPER", "1")
	root := t.TempDir()
	runtimePath := filepath.Join(root, "components", "configs-runtime", "configs.exe")
	if err := os.MkdirAll(filepath.Dir(runtimePath), 0o755); err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runtimePath, binary, 0o755); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(binary)
	digestHex := hex.EncodeToString(digest[:])
	pluginDigest := sha256.Sum256([]byte("owned\n"))
	pluginDigestHex := hex.EncodeToString(pluginDigest[:])
	receipt := installer.Receipt{
		SchemaVersion: "agx.receipt/v2", InstallationID: "test", BundleID: "test",
		BundleSHA256: strings.Repeat("a", 64), TemplateVersion: bootstrap.TemplateSetVersion,
		TemplateContentSHA256: bootstrap.TemplateSetContentSHA256, Phase: "configured",
		Components:      []installer.Component{{Name: "agent-plugins", Repository: "zaurakworks/agent-plugins", DistributionRepository: "2233admin/agent-plugins", CommitSHA: strings.Repeat("c", 40), AssetSHA256: strings.Repeat("d", 64), Path: "components/agent-plugins"}},
		ConfigsRuntime:  &installer.ConfigsRuntimeReceipt{RuntimeID: "configs", Version: "configs-v0.synthetic", SourceRepository: "2233admin/agent-systemX", ReleaseTag: "configs-v0.synthetic", CommitSHA: strings.Repeat("e", 40), ContractVersion: "configs/v1", Platform: "windows", Architecture: "amd64", AssetSHA256: digestHex, ContentSHA256: digestHex, Path: "components/configs-runtime/configs.exe"},
		OwnedFiles:      []string{"components/agent-plugins/README.md", "components/configs-runtime/configs.exe"},
		OwnedFileSHA256: map[string]string{"components/agent-plugins/README.md": pluginDigestHex, "components/configs-runtime/configs.exe": digestHex},
	}
	pluginPath := filepath.Join(root, "components", "agent-plugins", "README.md")
	if err := os.MkdirAll(filepath.Dir(pluginPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pluginPath, []byte("owned\n"), 0o600); err != nil {
		t.Fatal(err)
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
	return root, receipt
}

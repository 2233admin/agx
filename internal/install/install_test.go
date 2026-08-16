package install_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	installer "github.com/2233admin/agx/internal/install"
)

func TestApplyStatusRepeatDriftAndSafeUninstall(t *testing.T) {
	archive := makeArchive(t, "source/README.md", []byte("hello\n"), tar.TypeReg)
	digest := sha256.Sum256(archive)
	digestHex := hex.EncodeToString(digest[:])
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write(archive)
	}))
	defer server.Close()

	temporary := t.TempDir()
	bundlePath := filepath.Join(temporary, "bundle.json")
	bundleJSON := fmt.Sprintf(`{
  "schema_version":"agx.bundle/v1","bundle_id":"test-bundle","mode":"development",
  "provenance":"synthetic_test_only","development_override":true,
  "compatibility":{"agx":"test","multica_cli":"test"},
  "artifacts":{
    "agent_control":{"repository":"2233admin/agent-control","release_tag":"test","commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","asset_name":"control.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
    "agent_plugins":{"repository":"2233admin/agent-plugins","release_tag":"test","commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","asset_name":"plugins.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
  }
}`, server.URL+"/control", digestHex, server.URL+"/plugins", digestHex)
	if err := os.WriteFile(bundlePath, []byte(bundleJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(temporary, "installation")
	receipt, unchanged, err := installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: root, Client: server.Client()})
	if err != nil || unchanged {
		t.Fatalf("Apply() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	state, err := installer.Status(root)
	if err != nil || state.Phase != "configured" {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
	_, unchanged, err = installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: root, Client: server.Client()})
	if err != nil || !unchanged {
		t.Fatalf("repeat Apply() unchanged=%v err=%v", unchanged, err)
	}
	if err := os.Remove(filepath.Join(root, "components", "agent-control", "README.md")); err != nil {
		t.Fatal(err)
	}
	state, err = installer.Status(root)
	if err != nil || state.Phase != "drifted" || len(state.Missing) != 1 {
		t.Fatalf("drift Status() state=%+v err=%v", state, err)
	}
	unknown := filepath.Join(root, "user-note.txt")
	if err := os.WriteFile(unknown, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	retained, err := installer.Uninstall(root)
	if err != nil || len(retained) == 0 {
		t.Fatalf("Uninstall() retained=%v err=%v", retained, err)
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatalf("unknown file was removed: %v", err)
	}
}

func TestApplyRejectsSymlinkArchive(t *testing.T) {
	archive := makeArchive(t, "source/link", nil, tar.TypeSymlink)
	if err := applyTestArchive(t, archive); err == nil {
		t.Fatal("Apply() accepted symlink archive")
	}
}

func TestApplyRejectsArchiveWithoutOwnedFiles(t *testing.T) {
	archive := makeArchive(t, "source/", nil, tar.TypeDir)
	if err := applyTestArchive(t, archive); err == nil {
		t.Fatal("Apply() accepted an archive without regular files")
	}
}

func applyTestArchive(t *testing.T, archive []byte) error {
	t.Helper()
	digest := sha256.Sum256(archive)
	digestHex := hex.EncodeToString(digest[:])
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { writer.Write(archive) }))
	defer server.Close()
	temporary := t.TempDir()
	bundlePath := filepath.Join(temporary, "bundle.json")
	document := fmt.Sprintf(`{"schema_version":"agx.bundle/v1","bundle_id":"bad-bundle","mode":"development","provenance":"synthetic_test_only","development_override":true,"compatibility":{"agx":"x","multica_cli":"x"},"artifacts":{"agent_control":{"repository":"2233admin/agent-control","release_tag":"x","commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","asset_name":"a.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"agent_plugins":{"repository":"2233admin/agent-plugins","release_tag":"x","commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","asset_name":"b.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}}}`, server.URL, digestHex, server.URL, digestHex)
	if err := os.WriteFile(bundlePath, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: filepath.Join(temporary, "install"), Client: server.Client()})
	return err
}

func TestStatusRejectsInvalidReceiptContracts(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*installer.Receipt)
	}{
		{
			name: "phase is not configured",
			mutate: func(receipt *installer.Receipt) {
				receipt.Phase = "verified"
			},
		},
		{
			name: "bundle SHA256 is empty",
			mutate: func(receipt *installer.Receipt) {
				receipt.BundleSHA256 = ""
			},
		},
		{
			name: "bundle SHA256 is not 64 hexadecimal characters",
			mutate: func(receipt *installer.Receipt) {
				receipt.BundleSHA256 = string(bytes.Repeat([]byte{'z'}, 64))
			},
		},
		{
			name: "component is missing",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components = receipt.Components[:1]
			},
		},
		{
			name: "component is duplicated",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[1] = receipt.Components[0]
			},
		},
		{
			name: "component is unknown",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].Name = "agent-other"
			},
		},
		{
			name: "component path is not fixed",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].Path = "sibling/agent-control"
			},
		},
		{
			name: "repository is empty",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].Repository = " "
			},
		},
		{
			name: "repository basename mismatches component",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].Repository = "zaurakworks/agent-plugins"
			},
		},
		{
			name: "commit SHA is not 40 hexadecimal characters",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].CommitSHA = "not-a-commit"
			},
		},
		{
			name: "asset SHA256 is not 64 hexadecimal characters",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].AssetSHA256 = "not-a-digest"
			},
		},
		{
			name: "agent-control has no owned file",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = receipt.OwnedFiles[1:]
			},
		},
		{
			name: "agent-plugins has no owned file",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = receipt.OwnedFiles[:1]
			},
		},
		{
			name: "owned files are empty",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = nil
			},
		},
		{
			name: "owned file is duplicated",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = append(receipt.OwnedFiles, receipt.OwnedFiles[0])
			},
		},
		{
			name: "owned file is outside known components",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = append(receipt.OwnedFiles, "user-note.txt")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			receipt := validReceipt()
			test.mutate(&receipt)
			root := writeTestInstallation(t, receipt)
			if _, err := installer.Status(root); err == nil {
				t.Fatal("Status() accepted an invalid receipt contract")
			}
		})
	}
}

func TestStatusAcceptsComponentRepositoryBasenamesAcrossOwners(t *testing.T) {
	root := writeTestInstallation(t, validReceipt())
	state, err := installer.Status(root)
	if err != nil || state.Phase != "configured" {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
}

func TestStatusRequiresOwnedRegularFiles(t *testing.T) {
	receipt := validReceipt()
	root := writeTestInstallation(t, receipt)
	target := filepath.Join(root, "components", "agent-control", "README.md")
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}

	state, err := installer.Status(root)
	if err != nil || state.Phase != "drifted" || len(state.Missing) != 1 || state.Missing[0] != receipt.OwnedFiles[0] {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
}

func TestStatusRejectsSymlinkedComponentWithoutFollowingIt(t *testing.T) {
	receipt := validReceipt()
	root := writeTestInstallation(t, receipt)
	component := filepath.Join(root, "components", "agent-control")
	sibling := filepath.Join(filepath.Dir(root), "sibling-agent-control")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	siblingFile := filepath.Join(sibling, "README.md")
	if err := os.WriteFile(siblingFile, []byte("sibling checkout\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(component); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, component); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}

	state, err := installer.Status(root)
	if err != nil || state.Phase != "drifted" || len(state.Missing) != 1 || state.Missing[0] != receipt.OwnedFiles[0] {
		t.Fatalf("Status() followed a linked component: state=%+v err=%v", state, err)
	}
	contents, err := os.ReadFile(siblingFile)
	if err != nil || string(contents) != "sibling checkout\n" {
		t.Fatalf("sibling checkout was changed: contents=%q err=%v", contents, err)
	}
}

func TestUninstallRejectsSymlinkedComponentBeforeRemovingOwnedFiles(t *testing.T) {
	receipt := validReceipt()
	root := writeTestInstallation(t, receipt)
	component := filepath.Join(root, "components", "agent-plugins")
	sibling := filepath.Join(filepath.Dir(root), "sibling-agent-plugins")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	siblingFile := filepath.Join(sibling, "README.md")
	if err := os.WriteFile(siblingFile, []byte("sibling checkout\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(component); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, component); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}

	if _, err := installer.Uninstall(root); err == nil {
		t.Fatal("Uninstall() followed a linked component")
	}
	contents, err := os.ReadFile(siblingFile)
	if err != nil || string(contents) != "sibling checkout\n" {
		t.Fatalf("sibling checkout was changed: contents=%q err=%v", contents, err)
	}
	controlFile := filepath.Join(root, filepath.FromSlash(receipt.OwnedFiles[0]))
	if _, err := os.Stat(controlFile); err != nil {
		t.Fatalf("owned file was removed before unsafe path detection: %v", err)
	}
}

func TestStatusAndUninstallRejectSymlinkedMetadataDirectory(t *testing.T) {
	receipt := validReceipt()
	root := writeTestInstallation(t, receipt)
	metadata := filepath.Join(root, ".agx")
	siblingMetadata := filepath.Join(filepath.Dir(root), "sibling-metadata")
	if err := os.Rename(metadata, siblingMetadata); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(siblingMetadata, metadata); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}
	siblingReceipt := filepath.Join(siblingMetadata, "receipt.json")
	before, err := os.ReadFile(siblingReceipt)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := installer.Status(root); err == nil {
		t.Fatal("Status() followed a linked metadata directory")
	}
	if _, err := installer.Uninstall(root); err == nil {
		t.Fatal("Uninstall() followed a linked metadata directory")
	}
	after, err := os.ReadFile(siblingReceipt)
	if err != nil || !bytes.Equal(after, before) {
		t.Fatalf("sibling receipt was changed: before=%q after=%q err=%v", before, after, err)
	}
	for _, relative := range receipt.OwnedFiles {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(relative))); err != nil {
			t.Fatalf("owned component file %q changed: %v", relative, err)
		}
	}
}

func validReceipt() installer.Receipt {
	return installer.Receipt{
		SchemaVersion:  "agx.receipt/v1",
		InstallationID: "install-test",
		BundleID:       "bundle-test",
		BundleSHA256:   string(bytes.Repeat([]byte{'c'}, 64)),
		Phase:          "configured",
		Components: []installer.Component{
			{
				Name:        "agent-control",
				Repository:  "zaurakworks/agent-control",
				CommitSHA:   string(bytes.Repeat([]byte{'a'}, 40)),
				AssetSHA256: string(bytes.Repeat([]byte{'c'}, 64)),
				Path:        "components/agent-control",
			},
			{
				Name:        "agent-plugins",
				Repository:  "2233admin/agent-plugins",
				CommitSHA:   string(bytes.Repeat([]byte{'b'}, 40)),
				AssetSHA256: string(bytes.Repeat([]byte{'d'}, 64)),
				Path:        "components/agent-plugins",
			},
		},
		OwnedFiles: []string{
			"components/agent-control/README.md",
			"components/agent-plugins/README.md",
		},
	}
}

func writeTestInstallation(t *testing.T, receipt installer.Receipt) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "installation")
	for _, relative := range receipt.OwnedFiles {
		target := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte("owned\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(root, ".agx", "receipt.json")
	if err := os.MkdirAll(filepath.Dir(receiptPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receiptPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func makeArchive(t *testing.T, name string, contents []byte, entryType byte) []byte {
	t.Helper()
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(contents)), Typeflag: entryType}
	if entryType == tar.TypeSymlink {
		header.Linkname = "../outside"
		header.Size = 0
	}
	if err := tarWriter.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if len(contents) > 0 {
		if _, err := tarWriter.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	tarWriter.Close()
	gzipWriter.Close()
	return output.Bytes()
}

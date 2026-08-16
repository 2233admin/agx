package install_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	digest := sha256.Sum256(archive)
	digestHex := hex.EncodeToString(digest[:])
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { writer.Write(archive) }))
	defer server.Close()
	temporary := t.TempDir()
	bundlePath := filepath.Join(temporary, "bundle.json")
	document := fmt.Sprintf(`{"schema_version":"agx.bundle/v1","bundle_id":"bad-bundle","mode":"development","provenance":"synthetic_test_only","development_override":true,"compatibility":{"agx":"x","multica_cli":"x"},"artifacts":{"agent_control":{"repository":"2233admin/agent-control","release_tag":"x","commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","asset_name":"a.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"agent_plugins":{"repository":"2233admin/agent-plugins","release_tag":"x","commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","asset_name":"b.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}}}`, server.URL, digestHex, server.URL, digestHex)
	os.WriteFile(bundlePath, []byte(document), 0o600)
	_, _, err := installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: filepath.Join(temporary, "install"), Client: server.Client()})
	if err == nil {
		t.Fatal("Apply() accepted symlink archive")
	}
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

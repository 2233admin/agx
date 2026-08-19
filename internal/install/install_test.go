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
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/bundle"
	installer "github.com/2233admin/agx/internal/install"
)

func TestApplyRequiresExactlyOneBundleSource(t *testing.T) {
	tests := []struct {
		name    string
		options installer.Options
	}{
		{name: "zero inputs", options: installer.Options{Root: filepath.Join(t.TempDir(), "zero")}},
		{name: "both inputs", options: installer.Options{BundlePath: "bundle.json", BundleData: []byte(`{}`), Root: filepath.Join(t.TempDir(), "both")}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := installer.Apply(context.Background(), test.options)
			if err == nil || !strings.HasPrefix(err.Error(), "AGX-APPLY-BUNDLE-INPUT:") {
				t.Fatalf("Apply() error = %v, want Bundle input error", err)
			}
		})
	}
}

func TestApplyAcceptsInlineBundleAndPreservesReceiptBehavior(t *testing.T) {
	archive := makeArchive(t, "source/README.md", []byte("inline\n"), tar.TypeReg)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Write(archive)
	}))
	defer server.Close()

	bundleData := developmentBundle(t, server.URL, archive)
	root := filepath.Join(t.TempDir(), "installation")
	options := installer.Options{BundleData: bundleData, Root: root, Client: server.Client()}
	receipt, unchanged, err := installer.Apply(context.Background(), options)
	if err != nil || unchanged {
		t.Fatalf("Apply() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	wantBundleDigest := sha256Hex(bundleData)
	if receipt.BundleSHA256 != wantBundleDigest || receipt.OwnedFileSHA256["components/agent-plugins/README.md"] != sha256Hex([]byte("inline\n")) {
		t.Fatalf("inline receipt = %+v", receipt)
	}
	state, err := installer.Status(root)
	if err != nil || state.Phase != "configured" {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
	_, unchanged, err = installer.Apply(context.Background(), options)
	if err != nil || !unchanged {
		t.Fatalf("repeat inline Apply() unchanged=%v err=%v", unchanged, err)
	}
}

func TestApplyUsesEmbeddedProductionBundleAndKeepsDownloadChecks(t *testing.T) {
	var requestedURL string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requestedURL = request.URL.String()
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("not the pinned release asset")),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}
	root := filepath.Join(t.TempDir(), "production")
	_, _, err := installer.Apply(context.Background(), installer.Options{
		BundleData: bundle.Production(),
		Root:       root,
		Client:     client,
	})
	if err == nil || !strings.Contains(err.Error(), "asset digest mismatch") {
		t.Fatalf("Apply() error = %v, want production asset digest rejection", err)
	}
	wantURL := "https://github.com/2233admin/agent-plugins/releases/download/agx-plugins-20260819.1/agent-plugins-agx-plugins-20260819.1.tar.gz"
	if requestedURL != wantURL {
		t.Fatalf("download URL = %q, want %q", requestedURL, wantURL)
	}
	if _, statErr := os.Lstat(root); !os.IsNotExist(statErr) {
		t.Fatalf("failed production Apply() left target behind: %v", statErr)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func templateMetadataJSON() string {
	return fmt.Sprintf(
		`"templates":{"version":%q,"content_sha256":%q,"references":{"agent_plugins":{"repository":%q,"commit_sha":%q},"agent_control":{"repository":%q,"commit_sha":%q},"agent_contracts":{"repository":%q,"commit_sha":%q}}}`,
		bootstrap.TemplateSetVersion,
		bootstrap.TemplateSetContentSHA256,
		bootstrap.AgentPluginsReferenceRepository,
		bootstrap.AgentPluginsReferenceCommit,
		bootstrap.AgentControlReferenceRepository,
		bootstrap.AgentControlReferenceCommit,
		bootstrap.AgentContractsReferenceRepository,
		bootstrap.AgentContractsReferenceCommit,
	)
}

func developmentBundle(t *testing.T, downloadURL string, archive []byte) []byte {
	t.Helper()
	document := fmt.Sprintf(`{
  "schema_version":"agx.bundle/v2","bundle_id":"inline-test-bundle","mode":"development",
  "provenance":"synthetic_test_only","development_override":true,
  "compatibility":{"agx":"test"},
  "sources":{"agent_plugins":{"upstream_repository":"zaurakworks/agent-plugins","distribution_repository":"2233admin/agent-plugins","release_tag":"test","commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","asset_name":"plugins.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":%q}},
  %s
}`,
		downloadURL,
		sha256Hex(archive),
		uncompressedSHA256(t, archive),
		templateMetadataJSON(),
	)
	return []byte(document)
}

func TestApplyStatusRepeatDriftAndSafeUninstall(t *testing.T) {
	archive := makeArchive(t, "source/README.md", []byte("hello\n"), tar.TypeReg)
	digest := sha256.Sum256(archive)
	digestHex := hex.EncodeToString(digest[:])
	contentDigestHex := uncompressedSHA256(t, archive)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/plugins" {
			t.Errorf("unexpected download path %q", request.URL.Path)
		}
		writer.Write(archive)
	}))
	defer server.Close()

	temporary := t.TempDir()
	bundlePath := filepath.Join(temporary, "bundle.json")
	bundleJSON := fmt.Sprintf(`{
	  "schema_version":"agx.bundle/v2","bundle_id":"test-bundle","mode":"development",
	  "provenance":"synthetic_test_only","development_override":true,
	  "compatibility":{"agx":"test"},
	  "sources":{"agent_plugins":{"upstream_repository":"zaurakworks/agent-plugins","distribution_repository":"2233admin/agent-plugins","release_tag":"test","commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","asset_name":"plugins.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":%q}},
	  %s
}`, server.URL+"/plugins", digestHex, contentDigestHex, templateMetadataJSON())
	if err := os.WriteFile(bundlePath, []byte(bundleJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(temporary, "installation")
	receipt, unchanged, err := installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: root, Client: server.Client()})
	if err != nil || unchanged {
		t.Fatalf("Apply() receipt=%+v unchanged=%v err=%v", receipt, unchanged, err)
	}
	if receipt.SchemaVersion != "agx.receipt/v2" || len(receipt.Components) != 1 || receipt.Components[0].Name != "agent-plugins" {
		t.Fatalf("single-source receipt = %+v", receipt)
	}
	if receipt.TemplateVersion != bootstrap.TemplateSetVersion || receipt.TemplateContentSHA256 != bootstrap.TemplateSetContentSHA256 {
		t.Fatalf("template receipt metadata = %+v", receipt)
	}
	if receipt.OwnedFileSHA256["components/agent-plugins/README.md"] != sha256Hex([]byte("hello\n")) {
		t.Fatalf("owned file digest = %+v", receipt.OwnedFileSHA256)
	}
	state, err := installer.Status(root)
	if err != nil || state.Phase != "configured" {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
	_, unchanged, err = installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: root, Client: server.Client()})
	if err != nil || !unchanged {
		t.Fatalf("repeat Apply() unchanged=%v err=%v", unchanged, err)
	}
	pluginReadme := filepath.Join(root, "components", "agent-plugins", "README.md")
	if err := os.WriteFile(pluginReadme, []byte("tampered\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err = installer.Status(root)
	if err != nil || state.Phase != "drifted" || len(state.Modified) != 1 || state.Modified[0] != "components/agent-plugins/README.md" {
		t.Fatalf("modified Status() state=%+v err=%v", state, err)
	}
	_, unchanged, err = installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: root, Client: server.Client()})
	if err == nil || unchanged {
		t.Fatalf("repeat Apply() accepted modified content: unchanged=%v err=%v", unchanged, err)
	}
	if err := os.WriteFile(pluginReadme, []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(pluginReadme); err != nil {
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

func TestApplyRejectsUncompressedContentDigestMismatch(t *testing.T) {
	archive := makeArchive(t, "source/README.md", []byte("hello\n"), tar.TypeReg)
	if err := applyTestArchiveWithContentDigest(t, archive, strings.Repeat("a", 64)); err == nil || !strings.Contains(err.Error(), "uncompressed content digest mismatch") {
		t.Fatalf("Apply() content digest error = %v", err)
	}
}

func applyTestArchive(t *testing.T, archive []byte) error {
	t.Helper()
	return applyTestArchiveWithContentDigest(t, archive, uncompressedSHA256(t, archive))
}

func applyTestArchiveWithContentDigest(t *testing.T, archive []byte, contentDigest string) error {
	t.Helper()
	digest := sha256.Sum256(archive)
	digestHex := hex.EncodeToString(digest[:])
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { writer.Write(archive) }))
	defer server.Close()
	temporary := t.TempDir()
	bundlePath := filepath.Join(temporary, "bundle.json")
	document := fmt.Sprintf(`{"schema_version":"agx.bundle/v2","bundle_id":"bad-bundle","mode":"development","provenance":"synthetic_test_only","development_override":true,"compatibility":{"agx":"x"},"sources":{"agent_plugins":{"upstream_repository":"zaurakworks/agent-plugins","distribution_repository":"2233admin/agent-plugins","release_tag":"x","commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","asset_name":"b.tar.gz","download_url":%q,"asset_sha256":%q,"content_sha256":%q}},%s}`, server.URL, digestHex, contentDigest, templateMetadataJSON())
	if err := os.WriteFile(bundlePath, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := installer.Apply(context.Background(), installer.Options{BundlePath: bundlePath, Root: filepath.Join(temporary, "install"), Client: server.Client()})
	return err
}

func uncompressedSHA256(t *testing.T, archive []byte) string {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, reader); err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func TestStatusRejectsInvalidReceiptContracts(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*installer.Receipt)
	}{
		{
			name: "legacy receipt schema",
			mutate: func(receipt *installer.Receipt) {
				receipt.SchemaVersion = "agx.receipt/v1"
			},
		},
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
			name: "template version is empty",
			mutate: func(receipt *installer.Receipt) {
				receipt.TemplateVersion = ""
			},
		},
		{
			name: "template version is unsupported",
			mutate: func(receipt *installer.Receipt) {
				receipt.TemplateVersion = "bootstrap-other"
			},
		},
		{
			name: "template content SHA256 is malformed",
			mutate: func(receipt *installer.Receipt) {
				receipt.TemplateContentSHA256 = "not-a-digest"
			},
		},
		{
			name: "template content SHA256 is not embedded template",
			mutate: func(receipt *installer.Receipt) {
				receipt.TemplateContentSHA256 = strings.Repeat("a", 64)
			},
		},
		{
			name: "component is missing",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components = nil
			},
		},
		{
			name: "component is duplicated",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components = append(receipt.Components, receipt.Components[0])
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
			name: "upstream repository is wrong",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].Repository = "2233admin/agent-plugins"
			},
		},
		{
			name: "distribution repository is wrong",
			mutate: func(receipt *installer.Receipt) {
				receipt.Components[0].DistributionRepository = "zaurakworks/agent-plugins"
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
			name: "legacy agent-control owned file",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = []string{"components/agent-control/README.md"}
			},
		},
		{
			name: "owned files are empty",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFiles = nil
			},
		},
		{
			name: "owned file digest map is empty",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFileSHA256 = nil
			},
		},
		{
			name: "owned file digest is malformed",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFileSHA256[receipt.OwnedFiles[0]] = "not-a-digest"
			},
		},
		{
			name: "owned file digest is not canonical lowercase",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFileSHA256[receipt.OwnedFiles[0]] = strings.ToUpper(receipt.OwnedFileSHA256[receipt.OwnedFiles[0]])
			},
		},
		{
			name: "owned file digest has an extra path",
			mutate: func(receipt *installer.Receipt) {
				receipt.OwnedFileSHA256["components/agent-plugins/extra"] = string(bytes.Repeat([]byte{'a'}, 64))
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

func TestStatusAcceptsSinglePinnedPluginSource(t *testing.T) {
	root := writeTestInstallation(t, validReceipt())
	state, err := installer.Status(root)
	if err != nil || state.Phase != "configured" {
		t.Fatalf("Status() state=%+v err=%v", state, err)
	}
}

func TestStatusRequiresOwnedRegularFiles(t *testing.T) {
	receipt := validReceipt()
	root := writeTestInstallation(t, receipt)
	target := filepath.Join(root, "components", "agent-plugins", "README.md")
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
	pluginFile := filepath.Join(root, filepath.FromSlash(receipt.OwnedFiles[0]))
	if _, err := os.Stat(pluginFile); err != nil {
		t.Fatalf("owned file was removed before unsafe path detection: %v", err)
	}
}

func TestUninstallRejectsModifiedOwnedFileBeforeRemoval(t *testing.T) {
	receipt := validReceipt()
	root := writeTestInstallation(t, receipt)
	target := filepath.Join(root, filepath.FromSlash(receipt.OwnedFiles[0]))
	if err := os.WriteFile(target, []byte("user modification\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := installer.Uninstall(root); err == nil {
		t.Fatal("Uninstall() removed a modified owned file")
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != "user modification\n" {
		t.Fatalf("modified file changed: contents=%q err=%v", contents, err)
	}
}

func TestUninstallRetainsUnknownEmptyDirectory(t *testing.T) {
	root := writeTestInstallation(t, validReceipt())
	userState := filepath.Join(root, "user-state")
	if err := os.Mkdir(userState, 0o755); err != nil {
		t.Fatal(err)
	}

	retained, err := installer.Uninstall(root)
	if err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if len(retained) != 1 || retained[0] != "user-state" {
		t.Fatalf("Uninstall() retained = %v", retained)
	}
	info, err := os.Stat(userState)
	if err != nil || !info.IsDir() {
		t.Fatalf("unknown empty directory was removed: info=%v err=%v", info, err)
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
		SchemaVersion:         "agx.receipt/v2",
		InstallationID:        "install-test",
		BundleID:              "bundle-test",
		BundleSHA256:          string(bytes.Repeat([]byte{'c'}, 64)),
		TemplateVersion:       bootstrap.TemplateSetVersion,
		TemplateContentSHA256: bootstrap.TemplateSetContentSHA256,
		Phase:                 "configured",
		Components: []installer.Component{
			{
				Name:                   "agent-plugins",
				Repository:             "zaurakworks/agent-plugins",
				DistributionRepository: "2233admin/agent-plugins",
				CommitSHA:              string(bytes.Repeat([]byte{'b'}, 40)),
				AssetSHA256:            string(bytes.Repeat([]byte{'d'}, 64)),
				Path:                   "components/agent-plugins",
			},
		},
		OwnedFiles: []string{
			"components/agent-plugins/README.md",
		},
		OwnedFileSHA256: map[string]string{
			"components/agent-plugins/README.md": sha256Hex([]byte("owned\n")),
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

func sha256Hex(contents []byte) string {
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:])
}

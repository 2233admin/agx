package activation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadReceiptRejectsUnsafeReceiptEntry(t *testing.T) {
	t.Run("non-regular", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, ".agx", initializationFile)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, _, err := readReceipt(root); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
			t.Fatalf("readReceipt() err=%v", err)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		root := t.TempDir()
		directory := filepath.Join(root, ".agx")
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		sibling := filepath.Join(t.TempDir(), "sibling-initialization.json")
		contents := []byte("sibling receipt\n")
		if err := os.WriteFile(sibling, contents, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(sibling, filepath.Join(directory, initializationFile)); err != nil {
			t.Skipf("file symlinks are unavailable on this platform: %v", err)
		}
		if _, _, err := readReceipt(root); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-INVALID") {
			t.Fatalf("readReceipt() err=%v", err)
		}
		after, err := os.ReadFile(sibling)
		if err != nil || string(after) != string(contents) {
			t.Fatalf("sibling receipt changed: contents=%q err=%v", after, err)
		}
	})
}

func TestReadReceiptRejectsDuplicateRequiredKey(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".agx")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"schema_version":"agx.initialization/v3","installation_id":"install-test","phase":"needs_resume","phase":"initialized","profile":"core","providers":[]}`)
	if err := os.WriteFile(filepath.Join(directory, initializationFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readReceipt(root); err == nil || !strings.Contains(err.Error(), "duplicate object key") {
		t.Fatalf("readReceipt() err=%v, want duplicate-key rejection", err)
	}
}

func TestWriteReceiptRejectsLinkedMetadataDirectory(t *testing.T) {
	root := t.TempDir()
	sibling := t.TempDir()
	metadata := filepath.Join(root, ".agx")
	if err := os.Symlink(sibling, metadata); err != nil {
		t.Skipf("directory symlinks are unavailable on this platform: %v", err)
	}
	receipt := Receipt{
		SchemaVersion: receiptSchema, InstallationID: "install-test", Phase: PhaseInitialized, Profile: ProfileCore,
		Providers: []ProviderReceipt{{Name: "codex", SelectedPlugins: append([]string(nil), corePlugins...)}},
	}
	if err := writeReceipt(root, receipt); err == nil || !strings.Contains(err.Error(), "AGX-INIT-RECEIPT-WRITE") {
		t.Fatalf("writeReceipt() err=%v", err)
	}
	entries, err := os.ReadDir(sibling)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("linked metadata directory was modified: %+v", entries)
	}
}

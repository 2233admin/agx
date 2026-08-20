package metadatafile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenValidatedRootRejectsIdentityPreservingLink(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	moved := filepath.Join(base, "root-moved")
	if err := os.Mkdir(rootPath, 0o700); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(rootPath, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, rootPath); err != nil {
		t.Skipf("symlink replacement unavailable: %v", err)
	}
	if opened, err := OpenValidatedRoot(rootPath, info, "root", "TEST"); err == nil {
		_ = opened.Close()
		t.Fatal("OpenValidatedRoot accepted an identity-preserving link")
	}
}

func TestOpenChildRootRejectsIdentityPreservingLink(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	childPath := filepath.Join(rootPath, ".agx")
	moved := filepath.Join(rootPath, ".agx-moved")
	if err := os.MkdirAll(childPath, 0o700); err != nil {
		t.Fatal(err)
	}
	parent, err := os.OpenRoot(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	info, err := os.Lstat(childPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(childPath, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, childPath); err != nil {
		t.Skipf("symlink replacement unavailable: %v", err)
	}
	if opened, err := OpenChildRoot(parent, ".agx", info, "metadata directory", "TEST"); err == nil {
		_ = opened.Close()
		t.Fatal("OpenChildRoot accepted an identity-preserving link")
	}
}

func TestOpenedFileRejectsIdentityPreservingLink(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	metadataPath := filepath.Join(rootPath, ".agx", "metadata.json")
	moved := filepath.Join(rootPath, ".agx", "metadata-moved.json")
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metadataPath, []byte("metadata"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	directory, err := root.OpenRoot(".agx")
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	info, err := directory.Lstat("metadata.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(metadataPath, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, metadataPath); err != nil {
		t.Skipf("symlink replacement unavailable: %v", err)
	}
	if file, err := OpenCheckedFile(directory, "metadata.json", info, "metadata file", "TEST"); err == nil {
		_ = file.Close()
		t.Fatal("OpenCheckedFile accepted an identity-preserving link")
	}
}

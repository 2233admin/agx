package metadatafile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenValidatedRootRejectsReplacement(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	sibling := filepath.Join(base, "sibling")
	if err := os.Mkdir(rootPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(sibling, 0o700); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(rootPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, rootPath); err != nil {
		t.Skipf("symlink replacement unavailable: %v", err)
	}
	if opened, err := OpenValidatedRoot(rootPath, info, "root", "TEST"); err == nil {
		_ = opened.Close()
		t.Fatal("OpenValidatedRoot accepted a replaced root")
	}
}

func TestOpenChildRootRejectsReplacement(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	childPath := filepath.Join(rootPath, ".agx")
	sibling := filepath.Join(base, "sibling")
	if err := os.MkdirAll(childPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(sibling, 0o700); err != nil {
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
	if err := os.Remove(childPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, childPath); err != nil {
		t.Skipf("symlink replacement unavailable: %v", err)
	}
	if opened, err := OpenChildRoot(parent, ".agx", info, "metadata directory", "TEST"); err == nil {
		_ = opened.Close()
		t.Fatal("OpenChildRoot accepted a replaced metadata directory")
	}
}

func TestOpenedFileIdentityRejectsReplacement(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	if err := os.MkdirAll(filepath.Join(rootPath, ".agx"), 0o700); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(rootPath, ".agx", "metadata.json")
	sibling := filepath.Join(rootPath, "sibling.json")
	if err := os.WriteFile(original, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sibling, []byte("sibling"), 0o600); err != nil {
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
	if err := os.Rename(original, original+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(sibling, original); err != nil {
		t.Fatal(err)
	}
	if file, err := OpenCheckedFile(directory, "metadata.json", info, "metadata file", "TEST"); err == nil {
		_ = file.Close()
		t.Fatal("OpenCheckedFile accepted a replaced metadata file")
	}
}

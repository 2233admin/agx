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
	parent, err := OpenDir(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = parent.Close() }()
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
	root, err := OpenDir(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	directory, err := root.OpenChild(".agx")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = directory.Close() }()
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

// TestDirOpenFileRejectsSymlinkAtName covers the write-path primitive
// directly: a plain os.O_CREATE|os.O_EXCL open of a name that has been
// replaced with a symlink must fail, not silently create the file at the
// symlink's target.
func TestDirOpenFileRejectsSymlinkAtName(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "escape.tmp")
	linkName := filepath.Join(base, "receipt.tmp")
	if err := os.Symlink(target, linkName); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	dir, err := OpenDir(base)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dir.Close() }()
	if file, err := dir.OpenFile("receipt.tmp", os.O_WRONLY|os.O_CREATE, 0o600); err == nil {
		_ = file.Close()
		t.Fatal("OpenFile followed a symlink at name")
	}
	if _, err := os.Lstat(target); err == nil {
		t.Fatal("OpenFile created the symlink's target")
	}
}

// TestDirLinkFailsWhenTargetExists covers the create-only semantics
// publishProfile relies on: Link must fail (not silently succeed or
// overwrite) when newname already exists.
func TestDirLinkFailsWhenTargetExists(t *testing.T) {
	base := t.TempDir()
	dir, err := OpenDir(base)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dir.Close() }()
	if f, err := dir.OpenFile("source.tmp", os.O_WRONLY|os.O_CREATE, 0o600); err != nil {
		t.Fatal(err)
	} else {
		_ = f.Close()
	}
	if f, err := dir.OpenFile("existing.tmp", os.O_WRONLY|os.O_CREATE, 0o600); err != nil {
		t.Fatal(err)
	} else {
		_ = f.Close()
	}
	if err := dir.Link("source.tmp", "existing.tmp"); err == nil {
		t.Fatal("Link overwrote an existing target")
	}
}

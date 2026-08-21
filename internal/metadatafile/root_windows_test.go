//go:build windows

package metadatafile

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// createJunction creates a Windows directory junction at link pointing to
// target, using mklink /J. Unlike symlinks, junctions need no elevation and
// no Developer Mode — they are the attack vector issue #77's acceptance
// criteria name explicitly for non-elevated Windows runners. Skips (not
// fails) if mklink is unavailable for some other reason.
func createJunction(t *testing.T, link, target string) {
	t.Helper()
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, target)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("junction creation unavailable: %v (%s)", err, output)
	}
}

// TestOpenChildRootRejectsJunction covers the same identity-preserving
// replacement as TestOpenChildRootRejectsIdentityPreservingLink, but via a
// junction rather than a symlink — the attack surface issue #77's
// acceptance criteria specifically calls out as requiring no elevation.
func TestOpenChildRootRejectsJunction(t *testing.T) {
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
	defer parent.Close()
	info, err := os.Lstat(childPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(childPath, moved); err != nil {
		t.Fatal(err)
	}
	createJunction(t, childPath, moved)
	if opened, err := OpenChildRoot(parent, ".agx", info, "metadata directory", "TEST"); err == nil {
		_ = opened.Close()
		t.Fatal("OpenChildRoot accepted an identity-preserving junction")
	}
}

// TestOpenDirRejectsJunctionAtName covers OpenDir's own no-follow guarantee
// at the installation-root level via a junction.
func TestOpenDirRejectsJunctionAtName(t *testing.T) {
	base := t.TempDir()
	rootPath := filepath.Join(base, "root")
	moved := filepath.Join(base, "root-moved")
	if err := os.Mkdir(rootPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(rootPath, moved); err != nil {
		t.Fatal(err)
	}
	createJunction(t, rootPath, moved)
	if dir, err := OpenDir(rootPath); err == nil {
		_ = dir.Close()
		t.Fatal("OpenDir accepted a junction at its final path component")
	}
}

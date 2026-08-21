package metadatafile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestWriteFileAtomicDetectsSwapDuringWrite covers the one new safety
// property WriteFileAtomic adds beyond a plain temp-file-then-rename: a
// replacement of the target that happens after the temporary file is
// written but before the final rename/link is rejected, not silently
// accepted. The actual race window is a handful of syscalls wide and not
// reproducible on demand, so this test uses the beforeFinalCheck hook to
// deterministically land the replacement inside that window instead of
// racing two goroutines against it.
func TestWriteFileAtomicDetectsSwapDuringWrite(t *testing.T) {
	root := t.TempDir()
	if err := WriteFileAtomic(root, ".agx", "target.json", []byte("original"), false, "TEST"); err != nil {
		t.Fatal(err)
	}

	original := beforeFinalCheck
	t.Cleanup(func() { beforeFinalCheck = original })
	beforeFinalCheck = func(directory *Dir, name string) {
		if err := directory.Remove(name); err != nil {
			t.Fatalf("swap setup: remove: %v", err)
		}
		replacement, err := directory.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			t.Fatalf("swap setup: create replacement: %v", err)
		}
		if _, err := replacement.Write([]byte("attacker-controlled")); err != nil {
			t.Fatalf("swap setup: write replacement: %v", err)
		}
		if err := replacement.Close(); err != nil {
			t.Fatalf("swap setup: close replacement: %v", err)
		}
	}

	err := WriteFileAtomic(root, ".agx", "target.json", []byte("updated"), false, "TEST")
	if err == nil {
		t.Fatal("WriteFileAtomic silently accepted a target swapped mid-write")
	}
	if !errors.Is(err, ErrTargetChanged) {
		t.Fatalf("WriteFileAtomic err=%v, want ErrTargetChanged", err)
	}

	data, err := os.ReadFile(filepath.Join(root, ".agx", "target.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "attacker-controlled" {
		t.Fatalf("WriteFileAtomic overwrote the swapped-in file: %q", data)
	}
}

// TestWriteFileAtomicRequireAbsentDetectsSwapDuringWrite covers the same
// window for the create-only (Link) path publishProfile relies on.
func TestWriteFileAtomicRequireAbsentDetectsSwapDuringWrite(t *testing.T) {
	root := t.TempDir()

	original := beforeFinalCheck
	t.Cleanup(func() { beforeFinalCheck = original })
	beforeFinalCheck = func(directory *Dir, name string) {
		replacement, err := directory.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			t.Fatalf("swap setup: create replacement: %v", err)
		}
		if err := replacement.Close(); err != nil {
			t.Fatalf("swap setup: close replacement: %v", err)
		}
	}

	err := WriteFileAtomic(root, ".agx", "target.json", []byte("updated"), true, "TEST")
	if err == nil {
		t.Fatal("WriteFileAtomic (requireAbsent) silently accepted a target created mid-write")
	}
	if !errors.Is(err, ErrTargetChanged) {
		t.Fatalf("WriteFileAtomic err=%v, want ErrTargetChanged", err)
	}
}

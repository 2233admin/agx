package metadatafile

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// ErrTargetChanged reports that a metadata file's identity changed between
// the start and the end of an atomic write — the target was replaced while
// the write was in flight.
var ErrTargetChanged = errors.New("metadata target changed during write")

// ErrUnsafeEntry reports that an entry was refused because it is a
// symlink/reparse point, not because of an unrelated I/O failure. Callers
// use this to distinguish "this metadata is tampered/unsafe" from a generic
// I/O error when choosing their own error code.
var ErrUnsafeEntry = errors.New("metadata entry is a symlink or reparse point")

var tempSequence atomic.Uint64

// beforeFinalCheck runs immediately after the temporary file is closed and
// immediately before WriteFileAtomic re-inspects name to detect a mid-write
// replacement. It is a no-op in production; tests overwrite it to
// deterministically inject a replacement into that window, which is
// otherwise a genuine timing race and not reproducible on demand.
var beforeFinalCheck = func(directory *Dir, name string) {}

// ReadFile safely reads name (a single path component) inside subdir (a
// single path component) inside root, refusing to follow a symlink/reparse
// point at root, subdir, or name. It reports (nil, false, nil) — not an
// error — if root, subdir, or name does not exist; every other failure,
// including name existing as a symlink or as a non-regular entry, is
// reported as an error wrapped with errorCode.
func ReadFile(root, subdir, name, errorCode string) ([]byte, bool, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, false, fmt.Errorf("%s: invalid root: %w", errorCode, err)
	}
	installation, err := OpenDir(absoluteRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("%s: cannot open installation root: %w", errorCode, err)
	}
	defer installation.Close()
	directory, err := installation.OpenChild(subdir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("%s: cannot open metadata directory: %w", errorCode, err)
	}
	defer directory.Close()
	file, err := directory.OpenFile(name, os.O_RDONLY, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("%s: cannot open %s: %w", errorCode, name, err)
	}
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, false, fmt.Errorf("%s: %s must be a real regular file", errorCode, name)
	}
	data, readErr := io.ReadAll(file)
	closeErr := file.Close()
	if readErr != nil {
		return nil, false, fmt.Errorf("%s: cannot read %s: %w", errorCode, name, readErr)
	}
	if closeErr != nil {
		return nil, false, fmt.Errorf("%s: cannot close %s: %w", errorCode, name, closeErr)
	}
	return data, true, nil
}

// WriteFileAtomic safely writes data as name (a single path component)
// inside subdir (a single path component) inside root, refusing to follow a
// symlink/reparse point at root, subdir, or name, and creating subdir if
// needed. It detects and rejects (returning an error wrapping
// ErrTargetChanged) a replacement of name that happens while the write is
// in flight. If requireAbsent is true, the write fails if name already
// exists — via a create-only hard link rather than an unconditional
// rename — and the returned error wraps fs.ErrExist.
func WriteFileAtomic(root, subdir, name string, data []byte, requireAbsent bool, errorCode string) error {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("%s: invalid root: %w", errorCode, err)
	}
	installation, err := OpenDir(absoluteRoot)
	if err != nil {
		return fmt.Errorf("%s: cannot open installation root: %w", errorCode, err)
	}
	defer installation.Close()
	if err := installation.MkdirAll(subdir, 0o700); err != nil {
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	directory, err := installation.OpenChild(subdir)
	if err != nil {
		return fmt.Errorf("%s: cannot open metadata directory: %w", errorCode, err)
	}
	defer directory.Close()

	initialTarget, initialTargetPresent, err := lstatPresent(directory, name)
	if err != nil {
		return fmt.Errorf("%s: cannot inspect %s: %w", errorCode, name, err)
	}
	if requireAbsent && initialTargetPresent {
		return fmt.Errorf("%s: %s: %w", errorCode, name, fs.ErrExist)
	}

	temporaryName := fmt.Sprintf(".%s-%d-%d.tmp", name, time.Now().UnixNano(), tempSequence.Add(1))
	temporary, err := directory.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	defer directory.Remove(temporaryName)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	beforeFinalCheck(directory, name)

	current, currentPresent, err := lstatPresent(directory, name)
	if err != nil {
		return fmt.Errorf("%s: cannot inspect %s: %w", errorCode, name, err)
	}
	if currentPresent != initialTargetPresent || (currentPresent && !os.SameFile(initialTarget, current)) {
		return fmt.Errorf("%s: %s: %w", errorCode, name, ErrTargetChanged)
	}

	if requireAbsent {
		if err := directory.Link(temporaryName, name); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return fmt.Errorf("%s: %s: %w", errorCode, name, fs.ErrExist)
			}
			return fmt.Errorf("%s: %w", errorCode, err)
		}
		return nil
	}
	if err := directory.Rename(temporaryName, name); err != nil {
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	return nil
}

// RemoveFile safely removes name (a single path component) inside subdir
// (a single path component) inside root, refusing to follow a
// symlink/reparse point at root, subdir, or name.
func RemoveFile(root, subdir, name, errorCode string) error {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("%s: invalid root: %w", errorCode, err)
	}
	installation, err := OpenDir(absoluteRoot)
	if err != nil {
		return fmt.Errorf("%s: cannot open installation root: %w", errorCode, err)
	}
	defer installation.Close()
	directory, err := installation.OpenChild(subdir)
	if err != nil {
		return fmt.Errorf("%s: cannot open metadata directory: %w", errorCode, err)
	}
	defer directory.Close()
	if err := directory.Remove(name); err != nil {
		return fmt.Errorf("%s: %w", errorCode, err)
	}
	return nil
}

func lstatPresent(directory *Dir, name string) (os.FileInfo, bool, error) {
	info, err := directory.Lstat(name)
	if err == nil {
		return info, true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	return nil, false, err
}

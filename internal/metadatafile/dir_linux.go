//go:build linux

package metadatafile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// Dir is a directory handle opened without following a symlink at its own
// final path component. Every subsequent operation on an entry within it is
// performed relative to the held file descriptor (openat/mkdirat/renameat/
// unlinkat), so no operation re-resolves a path string from scratch: a
// concurrent replacement of an entry cannot redirect it once opened.
//
// Linux-only: this implementation uses O_PATH (for Lstat), which
// golang.org/x/sys does not define on Darwin/BSD. AGX's supported
// non-Windows platform is Ubuntu 24.04 x64 only (see docs/spec/PRD.md);
// this package intentionally does not build on other Unix platforms rather
// than silently degrading their safety guarantees.
type Dir struct {
	f *os.File
}

// OpenDir opens path as a directory, refusing to follow a symlink at path's
// final component. Intermediate path components (path's parent directories)
// are walked normally — AGX's threat model only requires the named entry
// itself (installation root, .agx, or a tracked file) to be race-safe, not
// every ancestor directory above it.
func OpenDir(path string) (*Dir, error) {
	parent, base := filepath.Split(filepath.Clean(path))
	if base == "" {
		return nil, fmt.Errorf("metadatafile: %q has no final path component to open safely", path)
	}
	if parent == "" {
		parent = "."
	}
	parentFile, err := os.OpenFile(parent, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = parentFile.Close() }()
	return openChildAt(parentFile, base, path)
}

// OpenChild opens name — a single path component, not a path — as a
// subdirectory of d, refusing to follow a symlink at name.
func (d *Dir) OpenChild(name string) (*Dir, error) {
	return openChildAt(d.f, name, filepath.Join(d.f.Name(), name))
}

func openChildAt(parent *os.File, name, displayName string) (*Dir, error) {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "openat", Path: displayName, Err: wrapUnsafe(err)}
	}
	return &Dir{f: os.NewFile(uintptr(fd), displayName)}, nil
}

// OpenFile opens name — a single path component — within d with the given
// flags, refusing to follow a symlink at name.
func (d *Dir) OpenFile(name string, flag int, perm os.FileMode) (*os.File, error) {
	fd, err := unix.Openat(int(d.f.Fd()), name, flag|unix.O_NOFOLLOW|unix.O_CLOEXEC, uint32(perm.Perm()))
	if err != nil {
		return nil, &os.PathError{Op: "openat", Path: filepath.Join(d.f.Name(), name), Err: wrapUnsafe(err)}
	}
	return os.NewFile(uintptr(fd), filepath.Join(d.f.Name(), name)), nil
}

// wrapUnsafe joins ErrUnsafeEntry onto err when err is one of the errnos
// O_NOFOLLOW (optionally combined with O_DIRECTORY) produces on a symlink,
// so callers can distinguish a deliberate safety rejection from an
// unrelated I/O failure via errors.Is. O_NOFOLLOW alone on a symlink
// yields ELOOP; combined with O_DIRECTORY, Linux instead yields ENOTDIR
// for the same symlink (the kernel reports "not a directory" for the
// unresolved symlink object rather than following it far enough to
// discover the loop) — both are the same rejection, just different
// errnos depending on which flags were set.
func wrapUnsafe(err error) error {
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return errors.Join(err, ErrUnsafeEntry)
	}
	return err
}

// Lstat describes name — a single path component — within d without
// following a final symlink, using d's own file descriptor rather than a
// fresh path walk. Unlike OpenFile/OpenChild, this never fails merely
// because name is a symlink: the returned FileInfo describes the symlink
// itself, exactly like the standard library's os.Lstat.
func (d *Dir) Lstat(name string) (os.FileInfo, error) {
	fd, err := unix.Openat(int(d.f.Fd()), name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "openat", Path: filepath.Join(d.f.Name(), name), Err: err}
	}
	file := os.NewFile(uintptr(fd), filepath.Join(d.f.Name(), name))
	defer func() { _ = file.Close() }()
	return file.Stat()
}

// Stat describes d itself, using d's own file descriptor.
func (d *Dir) Stat() (os.FileInfo, error) {
	return d.f.Stat()
}

// MkdirAll ensures name — a single path component — exists as a directory
// within d.
func (d *Dir) MkdirAll(name string, perm os.FileMode) error {
	err := unix.Mkdirat(int(d.f.Fd()), name, uint32(perm.Perm()))
	if err != nil && err != unix.EEXIST {
		return &os.PathError{Op: "mkdirat", Path: filepath.Join(d.f.Name(), name), Err: err}
	}
	return nil
}

// Rename renames oldname to newname, both single path components within d.
func (d *Dir) Rename(oldname, newname string) error {
	fd := int(d.f.Fd())
	if err := unix.Renameat(fd, oldname, fd, newname); err != nil {
		return &os.LinkError{Op: "renameat", Old: filepath.Join(d.f.Name(), oldname), New: filepath.Join(d.f.Name(), newname), Err: err}
	}
	return nil
}

// Link creates newname as a hard link to oldname, both single path
// components within d. Unlike Rename, this fails if newname already exists —
// callers rely on that to implement create-only semantics.
func (d *Dir) Link(oldname, newname string) error {
	fd := int(d.f.Fd())
	if err := unix.Linkat(fd, oldname, fd, newname, 0); err != nil {
		return &os.LinkError{Op: "linkat", Old: filepath.Join(d.f.Name(), oldname), New: filepath.Join(d.f.Name(), newname), Err: err}
	}
	return nil
}

// Remove removes name — a single path component — within d.
func (d *Dir) Remove(name string) error {
	if err := unix.Unlinkat(int(d.f.Fd()), name, 0); err != nil {
		return &os.PathError{Op: "unlinkat", Path: filepath.Join(d.f.Name(), name), Err: err}
	}
	return nil
}

// Name returns the display path this Dir was opened with, for error
// messages only — it is never re-resolved.
func (d *Dir) Name() string {
	return d.f.Name()
}

// Close closes the directory handle.
func (d *Dir) Close() error {
	return d.f.Close()
}

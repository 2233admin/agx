// Package metadatafile is the symlink/reparse-point-safe defense used before
// reading or writing any AGX-owned metadata path (installation receipts,
// Deployment Profiles, and similar per-installation artifacts under .agx/).
// Every operation is performed relative to an already-open, no-follow-opened
// directory handle (Dir) rather than by re-resolving a path string, so a
// hostile or drifted filesystem entry replacing root, .agx, or a tracked
// file cannot redirect a read, write, or delete outside the intended
// directory or into an entry the caller never observed.
package metadatafile

import (
	"fmt"
	"os"
)

// OpenValidatedRoot opens path as a directory handle that refuses to follow
// a symlink/reparse point at path's final component (see Dir), and verifies
// that the opened handle still names the entry the caller observed before
// calling this function.
func OpenValidatedRoot(path string, expected os.FileInfo, label, errorCode string) (*Dir, error) {
	dir, err := OpenDir(path)
	if err != nil {
		return nil, fmt.Errorf("%s: cannot open %s: %w", errorCode, label, err)
	}
	actual, statErr := dir.Stat()
	if statErr != nil || !os.SameFile(expected, actual) {
		_ = dir.Close()
		return nil, fmt.Errorf("%s: %s changed during open", errorCode, label)
	}
	return dir, nil
}

// OpenChildRoot opens a validated real child directory through the held
// parent (see Dir) and verifies that the opened handle still names the
// entry the caller observed before calling this function.
func OpenChildRoot(parent *Dir, name string, expected os.FileInfo, label, errorCode string) (*Dir, error) {
	child, err := parent.OpenChild(name)
	if err != nil {
		return nil, fmt.Errorf("%s: cannot open %s: %w", errorCode, label, err)
	}
	actual, statErr := child.Stat()
	if statErr != nil || !os.SameFile(expected, actual) {
		_ = child.Close()
		return nil, fmt.Errorf("%s: %s changed during open", errorCode, label)
	}
	return child, nil
}

// OpenFile opens a metadata file relative to a held metadata directory,
// refusing to follow a symlink/reparse point at name.
func OpenFile(dir *Dir, name string, flag int, perm os.FileMode) (*os.File, error) {
	return dir.OpenFile(name, flag, perm)
}

// OpenCheckedFile opens a file relative to a held directory, refusing to
// follow a symlink/reparse point at name, and verifies that the opened
// handle still names the file identity the caller observed before calling
// this function.
func OpenCheckedFile(dir *Dir, name string, expected os.FileInfo, label, errorCode string) (*os.File, error) {
	file, err := dir.OpenFile(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, fmt.Errorf("%s: cannot open %s: %w", errorCode, label, err)
	}
	actual, statErr := file.Stat()
	if statErr != nil || !os.SameFile(expected, actual) || !actual.Mode().IsRegular() {
		_ = file.Close()
		return nil, fmt.Errorf("%s: %s changed during open", errorCode, label)
	}
	return file, nil
}

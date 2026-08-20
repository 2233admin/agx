package metadatafile

import (
	"fmt"
	"os"
	"path/filepath"
)

// OpenValidatedRoot opens path and verifies that the resulting handle still
// names the entry observed by the caller before opening it.
func OpenValidatedRoot(path string, expected os.FileInfo, label, errorCode string) (*os.Root, error) {
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	if err := rejectNamedReparse(path, true, label, errorCode); err != nil {
		_ = root.Close()
		return nil, err
	}
	actual, statErr := root.Stat(".")
	if statErr != nil || !os.SameFile(expected, actual) {
		_ = root.Close()
		return nil, fmt.Errorf("%s: %s changed during open", errorCode, label)
	}
	return root, nil
}

func rejectNamedReparse(path string, directory bool, label, errorCode string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("%s: cannot inspect %s: %w", errorCode, label, err)
	}
	return RequireRealEntry(path, info, directory, label, errorCode)
}

// OpenRoot opens a directory for callers that have no prior path validation.
func OpenRoot(path string) (*os.Root, error) {
	return os.OpenRoot(path)
}

// OpenChildRoot opens a validated real child directory through the held root
// and verifies that the opened handle still names the checked directory.
func OpenChildRoot(parent *os.Root, name string, expected os.FileInfo, label, errorCode string) (*os.Root, error) {
	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	if err := rejectNamedReparse(filepath.Join(parent.Name(), name), true, label, errorCode); err != nil {
		_ = child.Close()
		return nil, err
	}
	actual, statErr := child.Stat(".")
	if statErr != nil || !os.SameFile(expected, actual) {
		_ = child.Close()
		return nil, fmt.Errorf("%s: %s changed during open", errorCode, label)
	}
	return child, nil
}

// OpenFile opens a metadata file relative to a held metadata directory.
func OpenFile(root *os.Root, name string, flag int, perm os.FileMode) (*os.File, error) {
	return root.OpenFile(name, flag, perm)
}

// OpenCheckedFile opens a file and verifies that the opened handle still
// names the file identity observed before the open.
func OpenCheckedFile(root *os.Root, name string, expected os.FileInfo, label, errorCode string) (*os.File, error) {
	path := filepath.Join(root.Name(), name)
	if err := rejectNamedReparse(path, false, label, errorCode); err != nil {
		return nil, err
	}
	file, err := OpenFile(root, name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	if err := rejectNamedReparse(path, false, label, errorCode); err != nil {
		_ = file.Close()
		return nil, err
	}
	actual, statErr := file.Stat()
	if statErr != nil || !os.SameFile(expected, actual) || !actual.Mode().IsRegular() {
		_ = file.Close()
		return nil, fmt.Errorf("%s: %s changed during open", errorCode, label)
	}
	return file, nil
}

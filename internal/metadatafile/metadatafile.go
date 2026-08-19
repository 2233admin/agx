// Package metadatafile provides the symlink/reparse-point defense used before
// reading or writing any AGX-owned metadata path (installation receipts,
// Deployment Profiles, and similar per-installation artifacts under .agx/).
// It refuses to treat a reparse point, a symlink, or a path of the wrong
// type as a real metadata entry, so a hostile or drifted filesystem entry
// cannot redirect a read or write outside the intended directory.
package metadatafile

import (
	"fmt"
	"os"
)

// RequireRealEntry validates that info describes a real, non-reparse,
// RequireRealEntry validates that info describes a real, non-reparse,
// non-symlink entry of the expected type (directory or regular file) at
// path. label is used only to compose the error message; errorCode is the
// caller's own stable error code, prefixed onto any returned error so each
// caller keeps its own error-code namespace.
func RequireRealEntry(path string, info os.FileInfo, directory bool, label, errorCode string) error {
	reparse, err := pathIsReparsePoint(path)
	if err != nil {
		return fmt.Errorf("%s: cannot inspect %s attributes: %w", errorCode, label, err)
	}
	validType := info.Mode().IsRegular()
	if directory {
		validType = info.Mode().IsDir()
	}
	if reparse || info.Mode()&os.ModeSymlink != 0 || !validType {
		return fmt.Errorf("%s: %s must be a real %s", errorCode, label, map[bool]string{true: "directory", false: "regular file"}[directory])
	}
	return nil
}

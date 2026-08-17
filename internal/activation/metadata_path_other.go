//go:build !windows

package activation

func metadataPathIsReparsePoint(string) (bool, error) {
	return false, nil
}

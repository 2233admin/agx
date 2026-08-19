//go:build !windows

package metadatafile

func pathIsReparsePoint(string) (bool, error) {
	return false, nil
}

package install

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/2233admin/agx/internal/bundle"
)

const receiptSchema = "agx.receipt/v1"
const maxAssetBytes = 128 << 20

var (
	commitSHAPattern = regexp.MustCompile(`(?i)^[0-9a-f]{40}$`)
	sha256Pattern    = regexp.MustCompile(`(?i)^[0-9a-f]{64}$`)
)

type Component struct {
	Name        string `json:"name"`
	Repository  string `json:"repository"`
	CommitSHA   string `json:"commit_sha"`
	AssetSHA256 string `json:"asset_sha256"`
	Path        string `json:"path"`
}

type Receipt struct {
	SchemaVersion  string      `json:"schema_version"`
	InstallationID string      `json:"installation_id"`
	BundleID       string      `json:"bundle_id"`
	BundleSHA256   string      `json:"bundle_sha256"`
	Phase          string      `json:"phase"`
	Components     []Component `json:"components"`
	OwnedFiles     []string    `json:"owned_files"`
}

type State struct {
	Phase   string   `json:"phase"`
	Receipt *Receipt `json:"receipt,omitempty"`
	Missing []string `json:"missing,omitempty"`
}

type Options struct {
	BundlePath string
	Root       string
	Client     *http.Client
}

type ownedFileState uint8

const (
	ownedFileMissing ownedFileState = iota
	ownedFileRegular
	ownedFileUnsafe
)

func Apply(ctx context.Context, options Options) (Receipt, bool, error) {
	data, err := os.ReadFile(options.BundlePath)
	if err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-BUNDLE-READ: %w", err)
	}
	document, err := bundle.Decode(data)
	if err != nil {
		return Receipt{}, false, err
	}
	bundleDigest := sha256.Sum256(data)
	bundleHex := hex.EncodeToString(bundleDigest[:])
	root, err := cleanRoot(options.Root)
	if err != nil {
		return Receipt{}, false, err
	}

	if _, err := os.Stat(root); err == nil {
		existing, readErr := readReceipt(root)
		if readErr != nil {
			return Receipt{}, false, fmt.Errorf("AGX-APPLY-CONFLICT: target exists without a valid AGX receipt: %w", readErr)
		}
		if existing.BundleID == document.BundleID && existing.BundleSHA256 == bundleHex {
			state, statusErr := Status(root)
			if statusErr != nil || state.Phase != "configured" {
				return Receipt{}, false, fmt.Errorf("AGX-APPLY-DRIFT: existing installation is not intact")
			}
			return existing, true, nil
		}
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-CONFLICT: target contains Bundle %q", existing.BundleID)
	} else if !os.IsNotExist(err) {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-ROOT: %w", err)
	}

	parent := filepath.Dir(root)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-ROOT: %w", err)
	}
	stage, err := os.MkdirTemp(parent, ".agx-staging-")
	if err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-STAGING: %w", err)
	}
	defer os.RemoveAll(stage)

	client := options.Client
	if client == nil {
		client = &http.Client{}
	}
	artifacts := []struct {
		name     string
		artifact bundle.Artifact
	}{
		{name: "agent-control", artifact: document.Artifacts.AgentControl},
		{name: "agent-plugins", artifact: document.Artifacts.AgentPlugins},
	}
	receipt := Receipt{
		SchemaVersion:  receiptSchema,
		InstallationID: "install-" + bundleHex[:16],
		BundleID:       document.BundleID,
		BundleSHA256:   bundleHex,
		Phase:          "configured",
	}
	for _, item := range artifacts {
		archive, err := download(ctx, client, item.artifact)
		if err != nil {
			return Receipt{}, false, err
		}
		componentRoot := filepath.Join(stage, "components", item.name)
		files, err := extract(archive, componentRoot, stage)
		if err != nil {
			return Receipt{}, false, fmt.Errorf("AGX-APPLY-ARCHIVE: %s: %w", item.name, err)
		}
		if len(files) == 0 {
			return Receipt{}, false, fmt.Errorf("AGX-APPLY-ARCHIVE: %s: archive contains no regular files", item.name)
		}
		receipt.OwnedFiles = append(receipt.OwnedFiles, files...)
		receipt.Components = append(receipt.Components, Component{
			Name: item.name, Repository: item.artifact.Repository, CommitSHA: item.artifact.CommitSHA,
			AssetSHA256: item.artifact.AssetSHA256, Path: filepath.ToSlash(filepath.Join("components", item.name)),
		})
	}
	sort.Strings(receipt.OwnedFiles)
	if err := writeReceipt(stage, receipt); err != nil {
		return Receipt{}, false, err
	}
	if err := os.Rename(stage, root); err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-COMMIT: %w", err)
	}
	return receipt, false, nil
}

func Status(rootPath string) (State, error) {
	root, err := cleanRoot(rootPath)
	if err != nil {
		return State{}, err
	}
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return State{Phase: "absent"}, nil
	} else if err != nil {
		return State{}, fmt.Errorf("AGX-STATUS-ROOT: %w", err)
	}
	receipt, err := readReceipt(root)
	if err != nil {
		return State{}, err
	}
	state := State{Phase: "configured", Receipt: &receipt}
	for _, relative := range receipt.OwnedFiles {
		fileState, err := inspectOwnedFile(root, relative)
		if err != nil || fileState != ownedFileRegular {
			state.Missing = append(state.Missing, relative)
		}
	}
	if len(state.Missing) > 0 {
		state.Phase = "drifted"
	}
	return state, nil
}

func Uninstall(rootPath string) ([]string, error) {
	root, err := cleanRoot(rootPath)
	if err != nil {
		return nil, err
	}
	receipt, err := readReceipt(root)
	if err != nil {
		return nil, err
	}
	type removal struct {
		relative string
		absolute string
	}
	removals := make([]removal, 0, len(receipt.OwnedFiles))
	for _, relative := range receipt.OwnedFiles {
		absolute, err := ownedPath(root, relative)
		if err != nil {
			return nil, err
		}
		fileState, err := inspectOwnedFile(root, relative)
		if err != nil {
			return nil, fmt.Errorf("AGX-UNINSTALL-INSPECT: %s: %w", relative, err)
		}
		switch fileState {
		case ownedFileMissing:
			continue
		case ownedFileUnsafe:
			return nil, fmt.Errorf("AGX-UNINSTALL-UNSAFE: owned path %q is not a regular file under real directories", relative)
		case ownedFileRegular:
			removals = append(removals, removal{relative: relative, absolute: absolute})
		}
	}
	for _, item := range removals {
		fileState, err := inspectOwnedFile(root, item.relative)
		if err != nil {
			return nil, fmt.Errorf("AGX-UNINSTALL-INSPECT: %s: %w", item.relative, err)
		}
		if fileState == ownedFileMissing {
			continue
		}
		if fileState != ownedFileRegular {
			return nil, fmt.Errorf("AGX-UNINSTALL-UNSAFE: owned path %q changed before removal", item.relative)
		}
		if err := os.Remove(item.absolute); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("AGX-UNINSTALL-REMOVE: %s: %w", item.relative, err)
		}
	}
	_ = os.Remove(filepath.Join(root, ".agx", "receipt.json"))
	var dirs []string
	_ = filepath.Walk(root, func(current string, info os.FileInfo, walkErr error) error {
		if walkErr == nil && info.IsDir() {
			dirs = append(dirs, current)
		}
		return nil
	})
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, dir := range dirs {
		_ = os.Remove(dir)
	}
	var retained []string
	_ = filepath.Walk(root, func(current string, info os.FileInfo, walkErr error) error {
		if walkErr == nil && current != root {
			relative, _ := filepath.Rel(root, current)
			retained = append(retained, filepath.ToSlash(relative))
		}
		return nil
	})
	return retained, nil
}

func download(ctx context.Context, client *http.Client, artifact bundle.Artifact) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.DownloadURL, nil)
	if err != nil {
		return nil, fmt.Errorf("AGX-APPLY-DOWNLOAD: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("AGX-APPLY-DOWNLOAD: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("AGX-APPLY-DOWNLOAD: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxAssetBytes+1))
	if err != nil || len(data) > maxAssetBytes {
		return nil, fmt.Errorf("AGX-APPLY-DOWNLOAD: asset read failed or exceeded limit")
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != artifact.AssetSHA256 {
		return nil, fmt.Errorf("AGX-APPLY-DIGEST: asset digest mismatch for %s", artifact.AssetName)
	}
	return data, nil
}

func extract(data []byte, destination, stage string) ([]string, error) {
	gzipReader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	var files []string
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.Typeflag == tar.TypeXGlobalHeader || header.Typeflag == tar.TypeXHeader {
			continue
		}
		clean := path.Clean(strings.ReplaceAll(header.Name, "\\", "/"))
		parts := strings.Split(clean, "/")
		if clean == "." || path.IsAbs(clean) || strings.HasPrefix(clean, "../") {
			return nil, fmt.Errorf("unsafe archive path %q", header.Name)
		}
		if len(parts) == 1 {
			if header.Typeflag == tar.TypeDir {
				continue
			}
			return nil, fmt.Errorf("archive entry has no component root %q", header.Name)
		}
		relative := filepath.FromSlash(strings.Join(parts[1:], "/"))
		target := filepath.Join(destination, relative)
		if _, err := ownedPath(destination, filepath.ToSlash(relative)); err != nil {
			return nil, err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return nil, err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > maxAssetBytes {
				return nil, fmt.Errorf("archive entry %q exceeds size limit", header.Name)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, err
			}
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return nil, err
			}
			_, copyErr := io.Copy(file, io.LimitReader(tarReader, maxAssetBytes+1))
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil {
				return nil, fmt.Errorf("extract %q failed", header.Name)
			}
			relativeToStage, _ := filepath.Rel(stage, target)
			files = append(files, filepath.ToSlash(relativeToStage))
		default:
			return nil, fmt.Errorf("unsupported archive entry %q", header.Name)
		}
	}
	return files, nil
}

func cleanRoot(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("AGX-PATH: --root is required")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("AGX-PATH: %w", err)
	}
	volumeRoot := filepath.VolumeName(absolute) + string(filepath.Separator)
	if filepath.Clean(absolute) == filepath.Clean(volumeRoot) {
		return "", fmt.Errorf("AGX-PATH: filesystem root is not an installation target")
	}
	return filepath.Clean(absolute), nil
}

func ownedPath(root, relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) {
		return "", fmt.Errorf("AGX-RECEIPT-PATH: unsafe owned path %q", relative)
	}
	absolute := filepath.Join(root, filepath.FromSlash(relative))
	back, err := filepath.Rel(root, absolute)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("AGX-RECEIPT-PATH: unsafe owned path %q", relative)
	}
	return absolute, nil
}

// inspectOwnedFile checks every path segment without following links. An
// intermediate segment must be a real directory, and an existing target must
// be a regular file. On Windows, junctions and other name-surrogate reparse
// points are reported by Lstat as symlinks or irregular files, so neither can
// satisfy the directory requirement.
func inspectOwnedFile(root, relative string) (ownedFileState, error) {
	absolute, err := ownedPath(root, relative)
	if err != nil {
		return ownedFileUnsafe, err
	}
	back, err := filepath.Rel(root, absolute)
	if err != nil || back == "." {
		return ownedFileUnsafe, fmt.Errorf("AGX-RECEIPT-PATH: unsafe owned path %q", relative)
	}

	info, err := os.Lstat(root)
	if err != nil {
		if os.IsNotExist(err) {
			return ownedFileMissing, nil
		}
		return ownedFileUnsafe, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ownedFileUnsafe, nil
	}

	current := root
	parts := strings.Split(back, string(filepath.Separator))
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err = os.Lstat(current)
		if err != nil {
			if os.IsNotExist(err) {
				return ownedFileMissing, nil
			}
			return ownedFileUnsafe, err
		}
		if index == len(parts)-1 {
			if info.Mode().IsRegular() {
				return ownedFileRegular, nil
			}
			return ownedFileUnsafe, nil
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ownedFileUnsafe, nil
		}
	}
	return ownedFileUnsafe, nil
}

func writeReceipt(root string, receipt Receipt) error {
	directory := filepath.Join(root, ".agx")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("AGX-RECEIPT-WRITE: %w", err)
	}
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return fmt.Errorf("AGX-RECEIPT-WRITE: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(filepath.Join(directory, "receipt.json"), data, 0o600); err != nil {
		return fmt.Errorf("AGX-RECEIPT-WRITE: %w", err)
	}
	return nil
}

func readReceipt(root string) (Receipt, error) {
	data, err := os.ReadFile(filepath.Join(root, ".agx", "receipt.json"))
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-READ: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var receipt Receipt
	if err := decoder.Decode(&receipt); err != nil || receipt.SchemaVersion != receiptSchema || receipt.InstallationID == "" || receipt.BundleID == "" || receipt.Phase != "configured" {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid receipt")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: trailing receipt data")
	}
	if !sha256Pattern.MatchString(receipt.BundleSHA256) || len(receipt.OwnedFiles) == 0 {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid receipt")
	}
	componentOwnedFiles := map[string]int{
		"agent-control": 0,
		"agent-plugins": 0,
	}
	seenOwnedFiles := make(map[string]struct{}, len(receipt.OwnedFiles))
	for _, relative := range receipt.OwnedFiles {
		absolute, err := ownedPath(root, relative)
		if err != nil {
			return Receipt{}, err
		}
		canonical, err := filepath.Rel(root, absolute)
		if err != nil {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-PATH: unsafe owned path %q", relative)
		}
		canonical = filepath.ToSlash(canonical)
		if _, duplicate := seenOwnedFiles[canonical]; duplicate {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: duplicate owned path")
		}
		seenOwnedFiles[canonical] = struct{}{}
		matchedComponent := false
		for name := range componentOwnedFiles {
			if strings.HasPrefix(canonical, "components/"+name+"/") {
				componentOwnedFiles[name]++
				matchedComponent = true
			}
		}
		if !matchedComponent {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: owned path is outside known components")
		}
	}

	if len(receipt.Components) != len(componentOwnedFiles) {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
	}
	seen := make(map[string]struct{}, len(receipt.Components))
	for _, component := range receipt.Components {
		expectedPath, known := map[string]string{
			"agent-control": "components/agent-control",
			"agent-plugins": "components/agent-plugins",
		}[component.Name]
		if !known {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
		}
		if _, duplicate := seen[component.Name]; duplicate {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
		}
		seen[component.Name] = struct{}{}
		repository := strings.TrimSpace(component.Repository)
		repositoryBase := path.Base(strings.TrimSuffix(repository, "/"))
		if component.Path != expectedPath || repository == "" || repositoryBase != component.Name ||
			!commitSHAPattern.MatchString(component.CommitSHA) || !sha256Pattern.MatchString(component.AssetSHA256) ||
			componentOwnedFiles[component.Name] == 0 {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
		}
	}
	return receipt, nil
}

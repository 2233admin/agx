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

	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/bundle"
)

const receiptSchema = "agx.receipt/v2"
const maxAssetBytes = 128 << 20

var (
	commitSHAPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Pattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Component struct {
	Name                   string `json:"name"`
	Repository             string `json:"repository"`
	DistributionRepository string `json:"distribution_repository"`
	CommitSHA              string `json:"commit_sha"`
	AssetSHA256            string `json:"asset_sha256"`
	Path                   string `json:"path"`
}

type Receipt struct {
	SchemaVersion         string            `json:"schema_version"`
	InstallationID        string            `json:"installation_id"`
	BundleID              string            `json:"bundle_id"`
	BundleSHA256          string            `json:"bundle_sha256"`
	TemplateVersion       string            `json:"template_version"`
	TemplateContentSHA256 string            `json:"template_content_sha256"`
	Phase                 string            `json:"phase"`
	Components            []Component       `json:"components"`
	OwnedFiles            []string          `json:"owned_files"`
	OwnedFileSHA256       map[string]string `json:"owned_file_sha256"`
}

type State struct {
	Phase    string   `json:"phase"`
	Receipt  *Receipt `json:"receipt,omitempty"`
	Missing  []string `json:"missing,omitempty"`
	Modified []string `json:"modified,omitempty"`
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

	if _, err := os.Lstat(root); err == nil {
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
	artifact := document.Sources.AgentPlugins
	receipt := Receipt{
		SchemaVersion:         receiptSchema,
		InstallationID:        "install-" + bundleHex[:16],
		BundleID:              document.BundleID,
		BundleSHA256:          bundleHex,
		TemplateVersion:       document.Templates.Version,
		TemplateContentSHA256: document.Templates.ContentSHA256,
		Phase:                 "configured",
		OwnedFileSHA256:       make(map[string]string),
	}
	archive, err := download(ctx, client, artifact)
	if err != nil {
		return Receipt{}, false, err
	}
	const componentName = "agent-plugins"
	componentRoot := filepath.Join(stage, "components", componentName)
	files, err := extract(archive, componentRoot, stage)
	if err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-ARCHIVE: %s: %w", componentName, err)
	}
	if len(files) == 0 {
		return Receipt{}, false, fmt.Errorf("AGX-APPLY-ARCHIVE: %s: archive contains no regular files", componentName)
	}
	receipt.OwnedFiles = append(receipt.OwnedFiles, files...)
	for _, relative := range files {
		digest, err := digestOwnedFile(stage, relative)
		if err != nil {
			return Receipt{}, false, fmt.Errorf("AGX-APPLY-CONTENT-DIGEST: %s: %w", relative, err)
		}
		receipt.OwnedFileSHA256[relative] = digest
	}
	receipt.Components = append(receipt.Components, Component{
		Name: componentName, Repository: artifact.UpstreamRepository,
		DistributionRepository: artifact.DistributionRepository, CommitSHA: artifact.CommitSHA,
		AssetSHA256: artifact.AssetSHA256, Path: filepath.ToSlash(filepath.Join("components", componentName)),
	})
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
	if _, err := os.Lstat(root); os.IsNotExist(err) {
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
			continue
		}
		digest, err := digestOwnedFile(root, relative)
		if err != nil || digest != receipt.OwnedFileSHA256[relative] {
			state.Modified = append(state.Modified, relative)
		}
	}
	if len(state.Missing) > 0 || len(state.Modified) > 0 {
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
			digest, err := digestOwnedFile(root, relative)
			if err != nil {
				return nil, fmt.Errorf("AGX-UNINSTALL-INSPECT: %s: %w", relative, err)
			}
			if digest != receipt.OwnedFileSHA256[relative] {
				return nil, fmt.Errorf("AGX-UNINSTALL-DRIFT: owned path %q content changed", relative)
			}
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
		digest, err := digestOwnedFile(root, item.relative)
		if err != nil {
			return nil, fmt.Errorf("AGX-UNINSTALL-INSPECT: %s: %w", item.relative, err)
		}
		if digest != receipt.OwnedFileSHA256[item.relative] {
			return nil, fmt.Errorf("AGX-UNINSTALL-UNSAFE: owned path %q content changed before removal", item.relative)
		}
		if err := os.Remove(item.absolute); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("AGX-UNINSTALL-REMOVE: %s: %w", item.relative, err)
		}
	}
	metadataState, err := inspectOwnedFile(root, ".agx/receipt.json")
	if err != nil {
		return nil, fmt.Errorf("AGX-UNINSTALL-INSPECT: receipt metadata: %w", err)
	}
	if metadataState == ownedFileUnsafe {
		return nil, fmt.Errorf("AGX-UNINSTALL-UNSAFE: receipt metadata path changed before removal")
	}
	if metadataState == ownedFileRegular {
		if err := os.Remove(filepath.Join(root, ".agx", "receipt.json")); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("AGX-UNINSTALL-REMOVE: receipt metadata: %w", err)
		}
	}
	for _, relative := range ownedDirectoryCandidates(receipt) {
		real, err := ownedRealDirectory(root, relative)
		if err != nil || !real {
			continue
		}
		absolute, err := ownedPath(root, relative)
		if err != nil {
			continue
		}
		_ = os.Remove(absolute)
	}
	_ = os.Remove(root)
	var retained []string
	_ = filepath.Walk(root, func(current string, info os.FileInfo, walkErr error) error {
		if walkErr == nil && current != root {
			relative, _ := filepath.Rel(root, current)
			retained = append(retained, filepath.ToSlash(relative))
		}
		return nil
	})
	sort.Strings(retained)
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
	gzipReader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("AGX-APPLY-DIGEST: cannot read compressed content for %s", artifact.AssetName)
	}
	contentHash := sha256.New()
	uncompressedBytes, copyErr := io.Copy(contentHash, io.LimitReader(gzipReader, maxAssetBytes+1))
	closeErr := gzipReader.Close()
	if copyErr != nil || closeErr != nil || uncompressedBytes > maxAssetBytes {
		return nil, fmt.Errorf("AGX-APPLY-DIGEST: uncompressed content read failed or exceeded limit for %s", artifact.AssetName)
	}
	if hex.EncodeToString(contentHash.Sum(nil)) != artifact.ContentSHA256 {
		return nil, fmt.Errorf("AGX-APPLY-DIGEST: uncompressed content digest mismatch for %s", artifact.AssetName)
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

func ownedRealDirectory(root, relative string) (bool, error) {
	absolute, err := ownedPath(root, relative)
	if err != nil {
		return false, err
	}
	back, err := filepath.Rel(root, absolute)
	if err != nil || back == "." {
		return false, fmt.Errorf("AGX-RECEIPT-PATH: unsafe directory path %q", relative)
	}

	info, err := os.Lstat(root)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, nil
	}

	current := root
	for _, part := range strings.Split(back, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err = os.Lstat(current)
		if err != nil {
			if os.IsNotExist(err) {
				return false, nil
			}
			return false, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false, nil
		}
	}
	return true, nil
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

func digestOwnedFile(root, relative string) (string, error) {
	fileState, err := inspectOwnedFile(root, relative)
	if err != nil {
		return "", err
	}
	if fileState != ownedFileRegular {
		return "", fmt.Errorf("owned path is not a regular file under real directories")
	}
	absolute, err := ownedPath(root, relative)
	if err != nil {
		return "", err
	}
	file, err := os.Open(absolute)
	if err != nil {
		return "", err
	}
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return "", fmt.Errorf("owned path changed before content read")
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return "", fmt.Errorf("owned file content read failed")
	}
	fileState, err = inspectOwnedFile(root, relative)
	if err != nil || fileState != ownedFileRegular {
		return "", fmt.Errorf("owned path changed during content read")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func ownedDirectoryCandidates(receipt Receipt) []string {
	seen := map[string]struct{}{`.agx`: {}}
	for _, relative := range receipt.OwnedFiles {
		directory := path.Dir(strings.ReplaceAll(relative, "\\", "/"))
		for directory != "." && directory != "/" {
			seen[directory] = struct{}{}
			directory = path.Dir(directory)
		}
	}
	directories := make([]string, 0, len(seen))
	for directory := range seen {
		directories = append(directories, directory)
	}
	sort.Slice(directories, func(i, j int) bool {
		leftDepth := strings.Count(directories[i], "/")
		rightDepth := strings.Count(directories[j], "/")
		if leftDepth == rightDepth {
			return directories[i] > directories[j]
		}
		return leftDepth > rightDepth
	})
	return directories
}

func writeReceipt(root string, receipt Receipt) error {
	directory := filepath.Join(root, ".agx")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("AGX-RECEIPT-WRITE: %w", err)
	}
	real, err := ownedRealDirectory(root, ".agx")
	if err != nil {
		return fmt.Errorf("AGX-RECEIPT-WRITE: %w", err)
	}
	if !real {
		return fmt.Errorf("AGX-RECEIPT-WRITE: metadata directory is not a real directory")
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
	metadataState, err := inspectOwnedFile(root, ".agx/receipt.json")
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-READ: %w", err)
	}
	if metadataState == ownedFileMissing {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-READ: receipt metadata is missing")
	}
	if metadataState != ownedFileRegular {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: receipt metadata path is unsafe")
	}
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
	if !sha256Pattern.MatchString(receipt.BundleSHA256) || receipt.TemplateVersion != bootstrap.TemplateSetVersion ||
		receipt.TemplateContentSHA256 != bootstrap.TemplateSetContentSHA256 || len(receipt.OwnedFiles) == 0 ||
		len(receipt.OwnedFileSHA256) != len(receipt.OwnedFiles) {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid receipt")
	}
	componentOwnedFiles := map[string]int{
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
		if relative != canonical {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: owned path is not canonical")
		}
		if _, duplicate := seenOwnedFiles[canonical]; duplicate {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: duplicate owned path")
		}
		seenOwnedFiles[canonical] = struct{}{}
		digest, found := receipt.OwnedFileSHA256[canonical]
		if !found || !sha256Pattern.MatchString(digest) {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: owned file digest is missing or malformed")
		}
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

	if len(receipt.Components) != 1 {
		return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
	}
	seen := make(map[string]struct{}, len(receipt.Components))
	for _, component := range receipt.Components {
		expectedPath, known := map[string]string{"agent-plugins": "components/agent-plugins"}[component.Name]
		if !known {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
		}
		if _, duplicate := seen[component.Name]; duplicate {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
		}
		seen[component.Name] = struct{}{}
		repository := strings.TrimSpace(component.Repository)
		distributionRepository := strings.TrimSpace(component.DistributionRepository)
		if component.Path != expectedPath || repository != bundle.AgentPluginsUpstreamRepository ||
			distributionRepository != bundle.AgentPluginsDistributionRepository || path.Base(repository) != component.Name ||
			path.Base(distributionRepository) != component.Name ||
			!commitSHAPattern.MatchString(component.CommitSHA) || !sha256Pattern.MatchString(component.AssetSHA256) ||
			componentOwnedFiles[component.Name] == 0 {
			return Receipt{}, fmt.Errorf("AGX-RECEIPT-INVALID: invalid component contract")
		}
	}
	return receipt, nil
}

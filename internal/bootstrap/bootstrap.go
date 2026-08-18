// Package bootstrap renders and writes the versioned repository baselines used
// when AGX provisions deployment-owned repositories.
package bootstrap

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Kind identifies a repository template.
type Kind string

const (
	KindAgentControl   Kind = "agent-control"
	KindAgentContracts Kind = "agent-contracts"

	// TemplateSetVersion identifies the immutable pair of repository templates.
	TemplateSetVersion = "bootstrap-20260817.1"
	// TemplateSetContentSHA256 is the canonical digest of the embedded,
	// unrendered template files, including their deployment placeholders.
	TemplateSetContentSHA256 = "0138d21986befe8f77f8d5e0621464b92b6fd4480c1fc5b9982964bd78a098ca"
	// AgentControlValidationWorkflowSHA256 binds first-use validation evidence
	// to the exact workflow shipped in the agent-control template.
	AgentControlValidationWorkflowSHA256 = "ee7c4c2f5c54f1d3670ed9016659463bf885d75a88a64a6549e3226e4e016870"

	AgentPluginsReferenceRepository   = "zaurakworks/agent-plugins"
	AgentPluginsReferenceCommit       = "ad07742ade0f0039ed1df1a9262e8f087117fca0"
	AgentControlReferenceRepository   = "zaurakworks/agent-control"
	AgentControlReferenceCommit       = "b0e6e0e8244ef518f671e2326745cd67c6d2307a"
	AgentContractsReferenceRepository = "zaurakworks/agent-contracts"
	AgentContractsReferenceCommit     = "5bb8ea0b54f063b0758c294b73ea270ba69322d2"

	AgentControlVersion   = "agent-control/v1"
	AgentContractsVersion = "agent-contracts/v1"
)

// Params supplies deployment-specific names without embedding credentials or
// mutable runtime state in a template.
type Params struct {
	Owner        string
	Repository   string
	PluginSource string
}

// File is one regular file in a rendered template. Path always uses forward
// slashes and Content always uses LF line endings.
type File struct {
	Path    string
	Content []byte
}

// Rendered is a complete, sorted repository tree and its canonical manifest
// digest. Digest is a lowercase SHA-256 over file paths and rendered bytes.
type Rendered struct {
	Kind    Kind
	Version string
	Digest  string
	Files   []File
}

const placeholderPrefix = "@@AGX_"

var (
	ownerPattern      = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	sourcePattern     = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$`)
)

//go:embed all:templates
var templates embed.FS

// Render returns a deterministic, deployment-specific repository tree.
func Render(kind Kind, params Params) (Rendered, error) {
	if err := validateParams(params); err != nil {
		return Rendered{}, err
	}

	version, templateRoot, err := templateInfo(kind)
	if err != nil {
		return Rendered{}, err
	}

	targetSlug := params.Owner + "/" + params.Repository
	targetURL := "https://github.com/" + targetSlug
	pluginURL := "https://github.com/" + params.PluginSource
	replacements := []struct {
		old string
		new string
	}{
		{"@@AGX_OWNER@@", params.Owner},
		{"@@AGX_REPOSITORY@@", params.Repository},
		{"@@AGX_TARGET_SLUG@@", targetSlug},
		{"@@AGX_TARGET_URL@@", targetURL},
		{"@@AGX_PLUGIN_SOURCE@@", params.PluginSource},
		{"@@AGX_PLUGIN_SOURCE_URL@@", pluginURL},
	}

	var files []File
	err = fs.WalkDir(templates, templateRoot, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("AGX-BOOTSTRAP-TEMPLATE: %q is not a regular file", name)
		}

		data, readErr := templates.ReadFile(name)
		if readErr != nil {
			return readErr
		}
		relative := strings.TrimPrefix(name, templateRoot+"/")
		normalizedPath, pathErr := normalizePath(relative)
		if pathErr != nil {
			return pathErr
		}
		content := strings.ReplaceAll(string(data), "\r\n", "\n")
		content = strings.ReplaceAll(content, "\r", "\n")
		for _, replacement := range replacements {
			content = strings.ReplaceAll(content, replacement.old, replacement.new)
		}
		if strings.Contains(content, placeholderPrefix) {
			return fmt.Errorf("AGX-BOOTSTRAP-TEMPLATE: unresolved placeholder in %q", normalizedPath)
		}
		if strings.IndexByte(content, 0) >= 0 {
			return fmt.Errorf("AGX-BOOTSTRAP-TEMPLATE: NUL byte in %q", normalizedPath)
		}
		files = append(files, File{Path: normalizedPath, Content: []byte(content)})
		return nil
	})
	if err != nil {
		return Rendered{}, err
	}

	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	if len(files) == 0 {
		return Rendered{}, fmt.Errorf("AGX-BOOTSTRAP-TEMPLATE: %q contains no files", kind)
	}
	rendered := Rendered{Kind: kind, Version: version, Files: files}
	rendered.Digest = manifestDigest(files)
	return rendered, nil
}

// Write materializes a rendered tree without following symlinks or overwriting
// drifted content. An exact existing tree is accepted, making retries safe.
func Write(root string, rendered Rendered) error {
	if strings.TrimSpace(root) == "" {
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: root is required")
	}
	if err := validateRendered(rendered); err != nil {
		return err
	}

	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: resolve root: %w", err)
	}
	if err := ensureRoot(absoluteRoot); err != nil {
		return err
	}

	// Complete the read-only collision check before adding any file.
	for _, file := range rendered.Files {
		target, err := safeTarget(absoluteRoot, file.Path)
		if err != nil {
			return err
		}
		if err := inspectAncestors(absoluteRoot, filepath.Dir(target)); err != nil {
			return err
		}
		info, statErr := os.Lstat(target)
		switch {
		case statErr == nil:
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
				return fmt.Errorf("AGX-BOOTSTRAP-WRITE: target %q is not a regular file", file.Path)
			}
			existing, readErr := os.ReadFile(target)
			if readErr != nil {
				return fmt.Errorf("AGX-BOOTSTRAP-WRITE: read %q: %w", file.Path, readErr)
			}
			if !bytes.Equal(existing, file.Content) {
				return fmt.Errorf("AGX-BOOTSTRAP-WRITE: target %q contains different content", file.Path)
			}
		case os.IsNotExist(statErr):
			// Safe to create after all files pass this preflight.
		default:
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: inspect %q: %w", file.Path, statErr)
		}
	}

	for _, file := range rendered.Files {
		target, err := safeTarget(absoluteRoot, file.Path)
		if err != nil {
			return err
		}
		if info, err := os.Lstat(target); err == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
				return fmt.Errorf("AGX-BOOTSTRAP-WRITE: target %q is not a regular file", file.Path)
			}
			existing, readErr := os.ReadFile(target)
			if readErr != nil {
				return fmt.Errorf("AGX-BOOTSTRAP-WRITE: read %q: %w", file.Path, readErr)
			}
			if !bytes.Equal(existing, file.Content) {
				return fmt.Errorf("AGX-BOOTSTRAP-WRITE: target %q changed after preflight", file.Path)
			}
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: inspect %q: %w", file.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: create directory for %q: %w", file.Path, err)
		}
		if err := inspectAncestors(absoluteRoot, filepath.Dir(target)); err != nil {
			return err
		}
		handle, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: create %q: %w", file.Path, err)
		}
		_, writeErr := handle.Write(file.Content)
		closeErr := handle.Close()
		if writeErr != nil {
			_ = os.Remove(target)
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: write %q: %w", file.Path, writeErr)
		}
		if closeErr != nil {
			_ = os.Remove(target)
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: close %q: %w", file.Path, closeErr)
		}
	}
	return nil
}

func validateParams(params Params) error {
	if !ownerPattern.MatchString(params.Owner) || strings.HasPrefix(params.Owner, "-") || strings.HasSuffix(params.Owner, "-") {
		return fmt.Errorf("AGX-BOOTSTRAP-PARAMS: invalid GitHub owner %q", params.Owner)
	}
	if !repositoryPattern.MatchString(params.Repository) || params.Repository == "." || params.Repository == ".." {
		return fmt.Errorf("AGX-BOOTSTRAP-PARAMS: invalid repository name %q", params.Repository)
	}
	sourceParts := strings.Split(params.PluginSource, "/")
	if !sourcePattern.MatchString(params.PluginSource) || len(sourceParts) != 2 || sourceParts[1] == "." || sourceParts[1] == ".." {
		return fmt.Errorf("AGX-BOOTSTRAP-PARAMS: plugin source must be an owner/repository slug")
	}
	return nil
}

func templateInfo(kind Kind) (version string, root string, err error) {
	switch kind {
	case KindAgentControl:
		return AgentControlVersion, "templates/agent-control/v1", nil
	case KindAgentContracts:
		return AgentContractsVersion, "templates/agent-contracts/v1", nil
	default:
		return "", "", fmt.Errorf("AGX-BOOTSTRAP-KIND: unsupported template %q", kind)
	}
}

func normalizePath(name string) (string, error) {
	if name == "" || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("AGX-BOOTSTRAP-PATH: invalid path %q", name)
	}
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || clean != name {
		return "", fmt.Errorf("AGX-BOOTSTRAP-PATH: invalid path %q", name)
	}
	return clean, nil
}

func validateRendered(rendered Rendered) error {
	version, _, err := templateInfo(rendered.Kind)
	if err != nil {
		return err
	}
	if rendered.Version != version {
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: version %q does not match %q", rendered.Version, version)
	}
	if len(rendered.Files) == 0 {
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: rendered tree is empty")
	}
	previous := ""
	for _, file := range rendered.Files {
		clean, err := normalizePath(file.Path)
		if err != nil {
			return err
		}
		if clean <= previous {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: file paths are not strictly sorted")
		}
		previous = clean
		if bytes.Contains(file.Content, []byte{'\r'}) || bytes.Contains(file.Content, []byte(placeholderPrefix)) || bytes.IndexByte(file.Content, 0) >= 0 {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: invalid content in %q", file.Path)
		}
	}
	if rendered.Digest != manifestDigest(rendered.Files) {
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: manifest digest mismatch")
	}
	return nil
}

func manifestDigest(files []File) string {
	hash := sha256.New()
	hash.Write([]byte("agx.bootstrap-manifest/v1\x00"))
	var length [8]byte
	for _, file := range files {
		binary.BigEndian.PutUint64(length[:], uint64(len(file.Path)))
		hash.Write(length[:])
		hash.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(length[:], uint64(len(file.Content)))
		hash.Write(length[:])
		hash.Write(file.Content)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func templateSetDigest() (string, error) {
	var files []File
	err := fs.WalkDir(templates, "templates", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("AGX-BOOTSTRAP-TEMPLATE: %q is not a regular file", name)
		}
		data, err := templates.ReadFile(name)
		if err != nil {
			return err
		}
		content := bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
		content = bytes.ReplaceAll(content, []byte{'\r'}, []byte{'\n'})
		files = append(files, File{Path: strings.TrimPrefix(name, "templates/"), Content: content})
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return manifestDigest(files), nil
}

func ensureRoot(root string) error {
	info, err := os.Lstat(root)
	switch {
	case err == nil:
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: root is not a real directory")
		}
		return nil
	case os.IsNotExist(err):
		if err := os.MkdirAll(root, 0o755); err != nil {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: create root: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: inspect root: %w", err)
	}
}

func safeTarget(root, slashPath string) (string, error) {
	clean, err := normalizePath(slashPath)
	if err != nil {
		return "", err
	}
	target := filepath.Join(root, filepath.FromSlash(clean))
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("AGX-BOOTSTRAP-WRITE: path %q escapes root", slashPath)
	}
	return target, nil
}

func inspectAncestors(root, directory string) error {
	relative, err := filepath.Rel(root, directory)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("AGX-BOOTSTRAP-WRITE: directory escapes root")
	}
	current := root
	if relative == "." {
		return nil
	}
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: inspect directory: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("AGX-BOOTSTRAP-WRITE: directory %q is not a real directory", current)
		}
	}
	return nil
}

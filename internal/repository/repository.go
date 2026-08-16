// Package repository provisions empty GitHub repositories from pinned,
// in-memory seeds. It never adopts, overwrites, or deletes a repository.
package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type Visibility string

type Verification string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityPublic  Visibility = "public"

	// VerificationReadback means a structured GitHub readback matched the
	// target repository, visibility, and locally created initial commit.
	VerificationReadback Verification = "readback_verified"
	// VerificationUncertain records that a remote mutation was attempted but
	// its outcome could not be established. It is recovery evidence, not a
	// claim that the repository was created.
	VerificationUncertain Verification = "uncertain"
)

type File struct {
	Path    string `json:"path"`
	Content []byte `json:"content"`
}

type Seed struct {
	Version string `json:"version"`
	Digest  string `json:"digest"`
	Files   []File `json:"files"`
}

type Target struct {
	Owner       string     `json:"owner"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Visibility  Visibility `json:"visibility"`
	Seed        Seed       `json:"seed"`
}

type Receipt struct {
	NameWithOwner   string       `json:"name_with_owner"`
	URL             string       `json:"url"`
	Visibility      Visibility   `json:"visibility"`
	InitialCommit   string       `json:"initial_commit"`
	Created         bool         `json:"created"`
	Verification    Verification `json:"verification"`
	TemplateVersion string       `json:"template_version"`
	TemplateDigest  string       `json:"template_digest"`
}

type Inspection struct {
	NameWithOwner   string     `json:"name_with_owner"`
	URL             string     `json:"url"`
	Visibility      Visibility `json:"visibility"`
	DefaultBranch   string     `json:"default_branch"`
	HeadCommit      string     `json:"head_commit"`
	ReachableCommit string     `json:"reachable_commit,omitempty"`
}

// Runner executes a program directly. Dir is passed to exec.Cmd.Dir; callers
// never construct a shell command string.
type Runner interface {
	LookPath(name string) (string, error)
	Run(ctx context.Context, dir, name string, args ...string) ([]byte, error)
}

type OSRunner struct{}

func (OSRunner) LookPath(name string) (string, error) {
	return exec.LookPath(name)
}

func (OSRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	output, err := command.Output()
	if err != nil {
		// gh returns useful structured stdout alongside a non-zero exit for a
		// GraphQL NOT_FOUND. Preserve stdout so callers can classify it safely.
		return output, fmt.Errorf("repository command %q failed: %w", name, err)
	}
	return output, nil
}

// Provision preflights every target before creating any local or remote state.
// Successful receipts preceding a later failure are returned for persistence.
func Provision(ctx context.Context, targets []Target, runner Runner) ([]Receipt, error) {
	runner = defaultRunner(runner)
	if err := Preflight(ctx, targets, runner); err != nil {
		return nil, err
	}
	receipts := make([]Receipt, 0, len(targets))
	for _, target := range targets {
		receipt, err := createPrepared(ctx, target, runner)
		if receipt.Verification == VerificationReadback || receipt.Verification == VerificationUncertain {
			receipts = append(receipts, receipt)
		}
		if err != nil {
			return receipts, err
		}
	}
	return receipts, nil
}

// Preflight validates all inputs, checks both required CLIs, authenticates gh,
// and confirms that every requested repository is absent for the current user.
func Preflight(ctx context.Context, targets []Target, runner Runner) error {
	runner = defaultRunner(runner)
	if len(targets) == 0 {
		return fmt.Errorf("AGX-REPOSITORY-TARGET: at least one repository target is required")
	}
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		if err := validateTarget(target); err != nil {
			return err
		}
		key := strings.ToLower(target.Owner + "/" + target.Name)
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("AGX-REPOSITORY-TARGET: duplicate target %q", target.Owner+"/"+target.Name)
		}
		seen[key] = struct{}{}
	}
	if _, err := runner.LookPath("git"); err != nil {
		return fmt.Errorf("AGX-REPOSITORY-CLI-MISSING: git is unavailable")
	}
	if _, err := runner.LookPath("gh"); err != nil {
		return fmt.Errorf("AGX-REPOSITORY-CLI-MISSING: gh is unavailable")
	}
	output, err := runner.Run(ctx, "", "gh", "api", "user")
	if err != nil {
		return fmt.Errorf("AGX-REPOSITORY-AUTH: cannot authenticate GitHub CLI: %w", err)
	}
	var user struct {
		Login string `json:"login"`
	}
	if err := decodeJSON(output, &user); err != nil || !validOwner(user.Login) {
		return fmt.Errorf("AGX-REPOSITORY-AUTH: GitHub CLI returned invalid user inventory")
	}
	for _, target := range targets {
		_, present, err := queryRepository(ctx, target.Owner, target.Name, "HEAD", preflightQuery, runner)
		if err != nil {
			return fmt.Errorf("AGX-REPOSITORY-INVENTORY: cannot inspect %s/%s: %w", target.Owner, target.Name, err)
		}
		if present {
			return fmt.Errorf("AGX-REPOSITORY-COLLISION: repository %s/%s already exists", target.Owner, target.Name)
		}
	}
	return nil
}

// Create safely preflights and provisions one target. Provision should be used
// when multiple targets must satisfy an all-preflight-before-write guarantee.
func Create(ctx context.Context, target Target, runner Runner) (Receipt, error) {
	runner = defaultRunner(runner)
	if err := Preflight(ctx, []Target{target}, runner); err != nil {
		return Receipt{}, err
	}
	return createPrepared(ctx, target, runner)
}

func createPrepared(ctx context.Context, target Target, runner Runner) (Receipt, error) {
	workspace, err := os.MkdirTemp("", "agx-repository-")
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-STAGING: cannot create temporary directory: %w", err)
	}
	defer os.RemoveAll(workspace)

	repositoryDir := filepath.Join(workspace, "repository")
	if err := os.Mkdir(repositoryDir, 0o700); err != nil {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-STAGING: cannot create repository directory: %w", err)
	}
	if err := writeSeed(repositoryDir, target.Seed); err != nil {
		return Receipt{}, err
	}
	if _, err := runner.Run(ctx, repositoryDir, "git", "init", "--initial-branch=main"); err != nil {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-GIT: cannot initialize repository: %w", err)
	}
	if _, err := runner.Run(ctx, repositoryDir, "git", "-c", "core.autocrlf=false", "add", "--all"); err != nil {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-GIT: cannot stage seed: %w", err)
	}
	message := "Initialize " + target.Name + " from AGX template " + target.Seed.Version
	if _, err := runner.Run(ctx, repositoryDir, "git",
		"-c", "user.name=AGX",
		"-c", "user.email=agx@users.noreply.github.com",
		"-c", "core.autocrlf=false",
		"-c", "core.hooksPath=",
		"-c", "commit.gpgsign=false",
		"commit", "-m", message,
	); err != nil {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-GIT: cannot commit seed: %w", err)
	}
	output, err := runner.Run(ctx, repositoryDir, "git", "rev-parse", "HEAD")
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-GIT: cannot read initial commit: %w", err)
	}
	commit := strings.TrimSpace(string(output))
	if !validCommit(commit) {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-GIT: git returned an invalid initial commit")
	}
	recoveryReceipt := uncertainReceipt(target, commit)

	visibilityFlag := "--" + string(target.Visibility)
	args := []string{"repo", "create", target.Owner + "/" + target.Name, visibilityFlag}
	if target.Description != "" {
		args = append(args, "--description", target.Description)
	}
	args = append(args, "--source", repositoryDir, "--remote", "origin", "--push")
	_, createErr := runner.Run(ctx, "", "gh", args...)

	// Exactly one readback follows the remote mutation attempt, including when
	// gh reports an error after the create or push has actually completed.
	inspection, present, readbackErr := queryRepository(ctx, target.Owner, target.Name, commit, readbackQuery, runner)
	if readbackErr != nil {
		if createErr != nil {
			return recoveryReceipt, fmt.Errorf("AGX-REPOSITORY-READBACK-UNCERTAIN: create failed and readback was inconclusive: %v; readback: %w", createErr, readbackErr)
		}
		return recoveryReceipt, fmt.Errorf("AGX-REPOSITORY-READBACK-UNCERTAIN: cannot verify repository after create: %w", readbackErr)
	}
	if !present {
		if createErr != nil {
			return Receipt{}, fmt.Errorf("AGX-REPOSITORY-CREATE: create failed and the repository is absent: %w", createErr)
		}
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-READBACK: repository is absent after create")
	}
	receipt, evidenceErr := receiptFromInspection(target, commit, inspection)
	if evidenceErr != nil {
		if createErr != nil {
			return recoveryReceipt, fmt.Errorf("AGX-REPOSITORY-READBACK-UNCERTAIN: create failed and repository readback did not match: %v; readback: %w", createErr, evidenceErr)
		}
		return recoveryReceipt, fmt.Errorf("AGX-REPOSITORY-READBACK-UNCERTAIN: repository readback did not match the local seed: %w", evidenceErr)
	}
	if createErr != nil {
		return receipt, fmt.Errorf("AGX-REPOSITORY-CREATE-PARTIAL: gh reported an error, but repository and initial commit were created: %w", createErr)
	}
	return receipt, nil
}

// Inspect reads repository/default-branch/head state without mutating it.
func Inspect(ctx context.Context, owner, name string, runner Runner) (Inspection, error) {
	runner = defaultRunner(runner)
	if !validOwner(owner) || !validRepositoryName(name) {
		return Inspection{}, fmt.Errorf("AGX-REPOSITORY-TARGET: invalid repository name")
	}
	if _, err := runner.LookPath("gh"); err != nil {
		return Inspection{}, fmt.Errorf("AGX-REPOSITORY-CLI-MISSING: gh is unavailable")
	}
	inspection, present, err := queryRepository(ctx, owner, name, "HEAD", readbackQuery, runner)
	if err != nil {
		return Inspection{}, fmt.Errorf("AGX-REPOSITORY-INVENTORY: cannot inspect %s/%s: %w", owner, name, err)
	}
	if !present {
		return Inspection{}, fmt.Errorf("AGX-REPOSITORY-ABSENT: repository %s/%s does not exist", owner, name)
	}
	return inspection, nil
}

// Verify confirms that a receipt still identifies the same repository and that
// its initialization commit remains reachable. Later commits are allowed.
func Verify(ctx context.Context, receipt Receipt, runner Runner) error {
	runner = defaultRunner(runner)
	owner, name, ok := strings.Cut(receipt.NameWithOwner, "/")
	validState := (receipt.Verification == VerificationReadback && receipt.Created) ||
		(receipt.Verification == VerificationUncertain && !receipt.Created)
	if !ok || !validOwner(owner) || !validRepositoryName(name) || !validCommit(receipt.InitialCommit) ||
		(receipt.Visibility != VisibilityPrivate && receipt.Visibility != VisibilityPublic) || !validState ||
		strings.TrimSpace(receipt.TemplateVersion) == "" || !validDigest(receipt.TemplateDigest) || !validHTTPSURL(receipt.URL) {
		return fmt.Errorf("AGX-REPOSITORY-RECEIPT: invalid repository receipt")
	}
	if _, err := runner.LookPath("gh"); err != nil {
		return fmt.Errorf("AGX-REPOSITORY-CLI-MISSING: gh is unavailable")
	}
	inspection, present, err := queryRepository(ctx, owner, name, receipt.InitialCommit, readbackQuery, runner)
	if err != nil {
		return fmt.Errorf("AGX-REPOSITORY-INVENTORY: cannot verify %s: %w", receipt.NameWithOwner, err)
	}
	if !present {
		return fmt.Errorf("AGX-REPOSITORY-DRIFT: repository %s is absent", receipt.NameWithOwner)
	}
	if !strings.EqualFold(inspection.NameWithOwner, receipt.NameWithOwner) || inspection.Visibility != receipt.Visibility ||
		!strings.EqualFold(inspection.URL, receipt.URL) || !strings.EqualFold(inspection.ReachableCommit, receipt.InitialCommit) {
		return fmt.Errorf("AGX-REPOSITORY-DRIFT: repository or initial commit no longer matches receipt")
	}
	return nil
}

func uncertainReceipt(target Target, commit string) Receipt {
	nameWithOwner := target.Owner + "/" + target.Name
	return Receipt{
		NameWithOwner:   nameWithOwner,
		URL:             "https://github.com/" + nameWithOwner,
		Visibility:      target.Visibility,
		InitialCommit:   commit,
		Created:         false,
		Verification:    VerificationUncertain,
		TemplateVersion: target.Seed.Version,
		TemplateDigest:  target.Seed.Digest,
	}
}

func receiptFromInspection(target Target, commit string, inspection Inspection) (Receipt, error) {
	nameWithOwner := target.Owner + "/" + target.Name
	if !strings.EqualFold(inspection.NameWithOwner, nameWithOwner) || inspection.Visibility != target.Visibility {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-READBACK: repository identity or visibility does not match target")
	}
	if inspection.DefaultBranch != "main" || !strings.EqualFold(inspection.HeadCommit, commit) ||
		!strings.EqualFold(inspection.ReachableCommit, commit) {
		return Receipt{}, fmt.Errorf("AGX-REPOSITORY-READBACK: default branch or initial commit does not match local seed")
	}
	return Receipt{
		NameWithOwner:   inspection.NameWithOwner,
		URL:             inspection.URL,
		Visibility:      inspection.Visibility,
		InitialCommit:   commit,
		Created:         true,
		Verification:    VerificationReadback,
		TemplateVersion: target.Seed.Version,
		TemplateDigest:  target.Seed.Digest,
	}, nil
}

func writeSeed(root string, seed Seed) error {
	for _, file := range seed.Files {
		destination := filepath.Join(root, filepath.FromSlash(file.Path))
		if err := ensureNoSymlinkTarget(root, destination); err != nil {
			return fmt.Errorf("AGX-REPOSITORY-SEED-PATH: %q: %w", file.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return fmt.Errorf("AGX-REPOSITORY-SEED-WRITE: cannot create parent for %q: %w", file.Path, err)
		}
		if err := ensureNoSymlinkTarget(root, destination); err != nil {
			return fmt.Errorf("AGX-REPOSITORY-SEED-PATH: %q: %w", file.Path, err)
		}
		handle, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return fmt.Errorf("AGX-REPOSITORY-SEED-WRITE: cannot create %q: %w", file.Path, err)
		}
		_, writeErr := handle.Write(file.Content)
		closeErr := handle.Close()
		if writeErr != nil {
			return fmt.Errorf("AGX-REPOSITORY-SEED-WRITE: cannot write %q: %w", file.Path, writeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("AGX-REPOSITORY-SEED-WRITE: cannot close %q: %w", file.Path, closeErr)
		}
	}
	return nil
}

func ensureNoSymlinkTarget(root, destination string) error {
	relative, err := filepath.Rel(root, destination)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return fmt.Errorf("path escapes staging directory")
	}
	current := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path traverses a symbolic link")
		}
	}
	return nil
}

func validateTarget(target Target) error {
	if !validOwner(target.Owner) || !validRepositoryName(target.Name) {
		return fmt.Errorf("AGX-REPOSITORY-TARGET: invalid owner or repository name")
	}
	if target.Visibility != VisibilityPrivate && target.Visibility != VisibilityPublic {
		return fmt.Errorf("AGX-REPOSITORY-TARGET: visibility must be private or public")
	}
	if utf8.RuneCountInString(target.Description) > 350 || !utf8.ValidString(target.Description) || hasControl(target.Description) {
		return fmt.Errorf("AGX-REPOSITORY-TARGET: invalid repository description")
	}
	if strings.TrimSpace(target.Seed.Version) != target.Seed.Version || target.Seed.Version == "" ||
		len(target.Seed.Version) > 128 || hasControl(target.Seed.Version) {
		return fmt.Errorf("AGX-REPOSITORY-SEED: invalid template version")
	}
	if !validDigest(target.Seed.Digest) {
		return fmt.Errorf("AGX-REPOSITORY-SEED: template digest must be SHA-256")
	}
	if len(target.Seed.Files) == 0 {
		return fmt.Errorf("AGX-REPOSITORY-SEED: template contains no files")
	}
	seen := make(map[string]struct{}, len(target.Seed.Files))
	for _, file := range target.Seed.Files {
		if !validSeedPath(file.Path) {
			return fmt.Errorf("AGX-REPOSITORY-SEED-PATH: unsafe seed path %q", file.Path)
		}
		key := strings.ToLower(file.Path)
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("AGX-REPOSITORY-SEED-PATH: duplicate seed path %q", file.Path)
		}
		seen[key] = struct{}{}
	}
	if normalizeDigest(target.Seed.Digest) != SeedDigest(target.Seed.Files) {
		return fmt.Errorf("AGX-REPOSITORY-SEED: manifest digest does not match files")
	}
	return nil
}

// SeedDigest returns the canonical AGX bootstrap-manifest/v1 SHA-256 for a
// repository seed. Paths are sorted on a copy so callers cannot accidentally
// make the digest depend on input enumeration order.
func SeedDigest(files []File) string {
	canonical := append([]File(nil), files...)
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].Path < canonical[j].Path })
	hash := sha256.New()
	_, _ = hash.Write([]byte("agx.bootstrap-manifest/v1\x00"))
	var length [8]byte
	for _, file := range canonical {
		binary.BigEndian.PutUint64(length[:], uint64(len(file.Path)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write([]byte(file.Path))
		binary.BigEndian.PutUint64(length[:], uint64(len(file.Content)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write(file.Content)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func validOwner(value string) bool {
	if len(value) == 0 || len(value) > 39 || value[0] == '-' || value[len(value)-1] == '-' || strings.Contains(value, "--") {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

func validRepositoryName(value string) bool {
	if len(value) == 0 || len(value) > 100 || value == "." || value == ".." || strings.HasSuffix(strings.ToLower(value), ".git") {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func validSeedPath(value string) bool {
	if value == "" || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) || path.IsAbs(value) || filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return false
	}
	cleaned := path.Clean(value)
	if cleaned != value || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func hasControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

func validCommit(value string) bool {
	return (len(value) == 40 || len(value) == 64) && isHex(value)
}

func validDigest(value string) bool {
	digest := normalizeDigest(value)
	return len(digest) == 64 && isHex(digest)
}

func normalizeDigest(value string) string {
	return strings.TrimPrefix(strings.ToLower(value), "sha256:")
}

func validHTTPSURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
}

func isHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') && (character < 'A' || character > 'F') {
			return false
		}
	}
	return true
}

func defaultRunner(runner Runner) Runner {
	if runner == nil {
		return OSRunner{}
	}
	return runner
}

const preflightQuery = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}`

const readbackQuery = `query($owner:String!,$name:String!,$commit:String!){repository(owner:$owner,name:$name){nameWithOwner url visibility defaultBranchRef{name target{... on Commit{oid}}} object(expression:$commit){... on Commit{oid}}}}`

type graphQLError struct {
	Type string   `json:"type"`
	Path []string `json:"path"`
}

func queryRepository(ctx context.Context, owner, name, commit, query string, runner Runner) (Inspection, bool, error) {
	args := []string{"api", "graphql", "-f", "query=" + query, "-F", "owner=" + owner, "-F", "name=" + name}
	if query == readbackQuery {
		args = append(args, "-F", "commit="+commit)
	}
	output, commandErr := runner.Run(ctx, "", "gh", args...)
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []graphQLError  `json:"errors"`
	}
	if err := decodeJSON(output, &envelope); err != nil {
		if commandErr != nil {
			return Inspection{}, false, commandErr
		}
		return Inspection{}, false, fmt.Errorf("invalid GraphQL response")
	}
	if len(envelope.Data) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Data), []byte("null")) {
		return Inspection{}, false, fmt.Errorf("GraphQL response contains errors or no data")
	}
	var data struct {
		Repository json.RawMessage `json:"repository"`
	}
	if err := decodeJSON(envelope.Data, &data); err != nil || len(data.Repository) == 0 {
		return Inspection{}, false, fmt.Errorf("GraphQL response has no repository field")
	}
	if bytes.Equal(bytes.TrimSpace(data.Repository), []byte("null")) {
		if len(envelope.Errors) == 0 || repositoryNotFound(envelope.Errors) {
			return Inspection{}, false, nil
		}
		return Inspection{}, false, fmt.Errorf("GraphQL response contains non-absence errors")
	}
	if commandErr != nil || len(envelope.Errors) != 0 {
		if commandErr != nil {
			return Inspection{}, false, commandErr
		}
		return Inspection{}, false, fmt.Errorf("GraphQL response contains errors")
	}
	var repository struct {
		NameWithOwner string `json:"nameWithOwner"`
		URL           string `json:"url"`
		Visibility    string `json:"visibility"`
		DefaultBranch *struct {
			Name   string `json:"name"`
			Target *struct {
				OID string `json:"oid"`
			} `json:"target"`
		} `json:"defaultBranchRef"`
		Object *struct {
			OID string `json:"oid"`
		} `json:"object"`
	}
	if err := decodeJSON(data.Repository, &repository); err != nil || repository.NameWithOwner == "" {
		return Inspection{}, false, fmt.Errorf("invalid repository inventory")
	}
	if query == preflightQuery {
		return Inspection{NameWithOwner: repository.NameWithOwner}, true, nil
	}
	visibility := Visibility(strings.ToLower(repository.Visibility))
	if !validHTTPSURL(repository.URL) || (visibility != VisibilityPrivate && visibility != VisibilityPublic) || repository.DefaultBranch == nil ||
		repository.DefaultBranch.Name == "" || repository.DefaultBranch.Target == nil || !validCommit(repository.DefaultBranch.Target.OID) {
		return Inspection{}, false, fmt.Errorf("invalid repository readback")
	}
	inspection := Inspection{
		NameWithOwner: repository.NameWithOwner,
		URL:           repository.URL,
		Visibility:    visibility,
		DefaultBranch: repository.DefaultBranch.Name,
		HeadCommit:    repository.DefaultBranch.Target.OID,
	}
	if repository.Object != nil {
		if !validCommit(repository.Object.OID) {
			return Inspection{}, false, fmt.Errorf("invalid reachable commit readback")
		}
		inspection.ReachableCommit = repository.Object.OID
	}
	return inspection, true, nil
}

func repositoryNotFound(graphQLErrors []graphQLError) bool {
	return len(graphQLErrors) == 1 && graphQLErrors[0].Type == "NOT_FOUND" &&
		len(graphQLErrors[0].Path) == 1 && graphQLErrors[0].Path[0] == "repository"
}

func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return fmt.Errorf("trailing JSON value")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

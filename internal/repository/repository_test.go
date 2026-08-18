package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bootstrap"
)

const testCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type recordedCall struct {
	dir  string
	name string
	args []string
}

type fakeRepository struct {
	nameWithOwner string
	visibility    Visibility
	defaultBranch string
	head          string
	reachable     map[string]bool
	issues        bool
	files         map[string]bool
}

type fakeRunner struct {
	missing          map[string]bool
	calls            []recordedCall
	authOutput       []byte
	authErr          error
	inventoryErrName string
	malformedName    string
	readbackErrName  string
	readbackBadName  string
	repositories     map[string]fakeRepository
	landOnCreate     bool
	createErr        error
	gitErrCommand    string
	absentReturnsErr bool
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{
		authOutput:   []byte(`{"login":"octocat"}`),
		repositories: map[string]fakeRepository{},
		landOnCreate: true,
	}
}

func (runner *fakeRunner) LookPath(name string) (string, error) {
	if runner.missing[name] {
		return "", errors.New("not found")
	}
	return filepath.Join("tools", name), nil
}

func (runner *fakeRunner) Run(_ context.Context, dir, name string, args ...string) ([]byte, error) {
	runner.calls = append(runner.calls, recordedCall{dir: dir, name: name, args: append([]string(nil), args...)})
	if name == "gh" && reflect.DeepEqual(args, []string{"api", "user"}) {
		return runner.authOutput, runner.authErr
	}
	if name == "gh" && len(args) >= 2 && args[0] == "api" && args[1] == "graphql" {
		owner := argumentValue(args, "owner")
		repositoryName := argumentValue(args, "name")
		commit := argumentValue(args, "commit")
		key := strings.ToLower(owner + "/" + repositoryName)
		if repositoryName == runner.inventoryErrName {
			return nil, errors.New("inventory unavailable")
		}
		if repositoryName == runner.malformedName {
			return []byte(`{"data":{"unexpected":null}}`), nil
		}
		if commit != "" && repositoryName == runner.readbackErrName {
			return nil, errors.New("readback timed out")
		}
		if commit != "" && repositoryName == runner.readbackBadName {
			return []byte(`{"data":{"unexpected":null}}`), nil
		}
		repository, present := runner.repositories[key]
		if !present {
			if runner.absentReturnsErr {
				return []byte(`{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"not found"}]}`), errors.New("gh exited 1")
			}
			return []byte(`{"data":{"repository":null}}`), nil
		}
		if commit == "" {
			return json.Marshal(map[string]any{"data": map[string]any{"repository": map[string]any{
				"nameWithOwner": repository.nameWithOwner,
			}}})
		}
		reachableCommit := ""
		if commit == "HEAD" {
			reachableCommit = repository.head
		} else if repository.reachable[commit] {
			reachableCommit = commit
		}
		var object any
		if reachableCommit != "" {
			object = map[string]any{"oid": reachableCommit}
		}
		return json.Marshal(map[string]any{"data": map[string]any{"repository": map[string]any{
			"nameWithOwner": repository.nameWithOwner,
			"url":           "https://github.com/" + repository.nameWithOwner,
			"visibility":    strings.ToUpper(string(repository.visibility)),
			"defaultBranchRef": map[string]any{
				"name":   repository.defaultBranch,
				"target": map[string]any{"oid": repository.head},
			},
			"object": object,
		}}})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "api" && strings.HasPrefix(args[1], "repos/") {
		parts := strings.Split(args[1], "/")
		if len(parts) < 4 {
			return nil, errors.New("invalid tree endpoint")
		}
		repository := runner.repositories[strings.ToLower(parts[1]+"/"+parts[2])]
		tree := []map[string]any{}
		for file := range repository.files {
			tree = append(tree, map[string]any{"path": file, "type": "blob"})
		}
		return json.Marshal(map[string]any{"tree": tree, "truncated": false})
	}
	if name == "gh" && len(args) >= 2 && args[0] == "repo" && args[1] == "view" {
		repository := runner.repositories[strings.ToLower(args[2])]
		return json.Marshal(map[string]any{"hasIssuesEnabled": repository.issues})
	}
	if name == "git" {
		command := gitCommand(args)
		if command == runner.gitErrCommand {
			return nil, errors.New("git failed")
		}
		if command == "rev-parse" {
			return []byte(testCommit + "\n"), nil
		}
		return nil, nil
	}
	if name == "gh" && len(args) >= 2 && args[0] == "repo" && args[1] == "create" {
		if runner.landOnCreate {
			nameWithOwner := args[2]
			visibility := VisibilityPrivate
			if contains(args, "--public") {
				visibility = VisibilityPublic
			}
			files := map[string]bool{}
			source := argumentAfter(args, "--source")
			_ = filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
				if err != nil || entry.IsDir() || strings.Contains(filepath.ToSlash(path), "/.git/") {
					return err
				}
				relative, relativeErr := filepath.Rel(source, path)
				if relativeErr == nil {
					files[filepath.ToSlash(relative)] = true
				}
				return relativeErr
			})
			runner.repositories[strings.ToLower(nameWithOwner)] = fakeRepository{
				nameWithOwner: nameWithOwner,
				visibility:    visibility,
				defaultBranch: "main",
				head:          testCommit,
				reachable:     map[string]bool{testCommit: true},
				issues:        true,
				files:         files,
			}
		}
		return nil, runner.createErr
	}
	return nil, errors.New("unexpected command")
}

func TestVerifyDetectsMissingTemplateEntriesAndDisabledIssues(t *testing.T) {
	runner := newFakeRunner()
	receipt, err := Create(context.Background(), testTarget("agent-control"), runner)
	if err != nil {
		t.Fatal(err)
	}
	repository := runner.repositories["zaurakworks/agent-control"]
	delete(repository.files, "README.md")
	runner.repositories["zaurakworks/agent-control"] = repository
	if err := Verify(context.Background(), receipt, runner); err == nil || !strings.Contains(err.Error(), "template path") {
		t.Fatalf("Verify() err = %v, want missing template path", err)
	}
	repository.files["README.md"] = true
	repository.issues = false
	runner.repositories["zaurakworks/agent-control"] = repository
	if err := Verify(context.Background(), receipt, runner); err == nil || !strings.Contains(err.Error(), "Issues are disabled") {
		t.Fatalf("Verify() err = %v, want disabled Issues", err)
	}
}

func TestProvisionPreflightsEveryTargetBeforeFirstWrite(t *testing.T) {
	runner := newFakeRunner()
	targets := []Target{testTarget("agent-control"), testTarget("agent-contracts")}
	receipts, err := Provision(context.Background(), targets, runner)
	if err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 2 || !receipts[0].Created || !receipts[1].Created {
		t.Fatalf("receipts = %+v", receipts)
	}
	firstGit := callIndex(runner.calls, func(call recordedCall) bool { return call.name == "git" })
	if firstGit < 0 {
		t.Fatal("git was not invoked")
	}
	preflightQueries := 0
	for _, call := range runner.calls[:firstGit] {
		if call.name == "gh" && len(call.args) > 1 && call.args[0] == "api" && call.args[1] == "graphql" {
			preflightQueries++
		}
	}
	if preflightQueries != len(targets) {
		t.Fatalf("preflight queries before first write = %d, want %d; calls=%+v", preflightQueries, len(targets), runner.calls)
	}
}

func TestProvisionDoesNotOpenStagingUntilAllPreflightsPass(t *testing.T) {
	blockedTemp := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockedTemp, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", blockedTemp)
	t.Setenv("TMP", blockedTemp)
	t.Setenv("TEMP", blockedTemp)
	runner := newFakeRunner()
	_, err := Provision(context.Background(), []Target{testTarget("agent-control"), testTarget("agent-contracts")}, runner)
	if err == nil || !strings.Contains(err.Error(), "STAGING") {
		t.Fatalf("Provision() err = %v, want staging failure after preflight", err)
	}
	preflightQueries := 0
	for _, call := range runner.calls {
		if call.name == "gh" && len(call.args) > 1 && call.args[0] == "api" && call.args[1] == "graphql" {
			preflightQueries++
		}
	}
	if preflightQueries != 2 {
		t.Fatalf("preflight queries = %d, want 2", preflightQueries)
	}
	assertNoWrites(t, runner.calls)
}

func TestPreflightAcceptsOnlyStructuredRepositoryNotFoundAsAbsent(t *testing.T) {
	runner := newFakeRunner()
	runner.absentReturnsErr = true
	if err := Preflight(context.Background(), []Target{testTarget("agent-control"), testTarget("agent-contracts")}, runner); err != nil {
		t.Fatalf("Preflight() rejected structured NOT_FOUND: %v", err)
	}

	runner = newFakeRunner()
	runner.malformedName = "agent-control"
	if err := Preflight(context.Background(), []Target{testTarget("agent-control")}, runner); err == nil {
		t.Fatal("Preflight() accepted structurally ambiguous inventory")
	}
}

func TestPreflightCollisionAndFailuresPerformNoWrites(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeRunner)
	}{
		{
			name: "collision",
			configure: func(runner *fakeRunner) {
				runner.repositories["zaurakworks/agent-contracts"] = fakeRepository{nameWithOwner: "zaurakworks/agent-contracts"}
			},
		},
		{name: "authentication", configure: func(runner *fakeRunner) { runner.authErr = errors.New("denied") }},
		{name: "authentication structure", configure: func(runner *fakeRunner) { runner.authOutput = []byte(`{"id":1}`) }},
		{name: "inventory", configure: func(runner *fakeRunner) { runner.inventoryErrName = "agent-contracts" }},
		{name: "inventory structure", configure: func(runner *fakeRunner) { runner.malformedName = "agent-contracts" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runner := newFakeRunner()
			test.configure(runner)
			_, err := Provision(context.Background(), []Target{testTarget("agent-control"), testTarget("agent-contracts")}, runner)
			if err == nil {
				t.Fatal("Provision() error = nil")
			}
			assertNoWrites(t, runner.calls)
		})
	}
}

func TestCreateCommandOrderAndLocalGitConfiguration(t *testing.T) {
	runner := newFakeRunner()
	_, err := Create(context.Background(), testTarget("agent-control"), runner)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(runner.calls))
	for _, call := range runner.calls {
		if call.name == "gh" && len(call.args) > 1 && call.args[0] == "api" && call.args[1] == "graphql" {
			if argumentValue(call.args, "commit") == "" {
				got = append(got, "preflight")
			} else {
				got = append(got, "readback")
			}
			continue
		}
		if call.name == "gh" && reflect.DeepEqual(call.args, []string{"api", "user"}) {
			got = append(got, "auth")
			continue
		}
		if call.name == "git" {
			got = append(got, "git "+gitCommand(call.args))
			if contains(call.args, "--global") || (len(call.args) > 0 && call.args[0] == "config") {
				t.Fatalf("global/persistent git configuration command: %#v", call.args)
			}
			continue
		}
		if call.name == "gh" && len(call.args) > 1 && call.args[0] == "repo" {
			got = append(got, call.args[1])
			continue
		}
		if call.name == "gh" && len(call.args) > 1 && call.args[0] == "api" && strings.Contains(call.args[1], "/git/trees/") {
			got = append(got, "tree readback")
		}
	}
	want := []string{"auth", "preflight", "git init", "git add", "git commit", "git rev-parse", "create", "readback", "view", "tree readback"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("command order = %#v, want %#v", got, want)
	}
	commitCall := runner.calls[callIndex(runner.calls, func(call recordedCall) bool {
		return call.name == "git" && gitCommand(call.args) == "commit"
	})]
	for _, setting := range []string{"user.name=AGX", "user.email=agx@users.noreply.github.com", "core.autocrlf=false", "core.hooksPath=", "commit.gpgsign=false"} {
		if !contains(commitCall.args, setting) {
			t.Fatalf("commit args %#v do not contain %q", commitCall.args, setting)
		}
	}
}

func TestCreatePassesWindowsStyleSpacedSourceAsOneArgument(t *testing.T) {
	base := filepath.Join(t.TempDir(), "temporary staging with spaces")
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", base)
	t.Setenv("TMP", base)
	t.Setenv("TEMP", base)
	runner := newFakeRunner()
	_, err := Create(context.Background(), testTarget("agent-control"), runner)
	if err != nil {
		t.Fatal(err)
	}
	index := callIndex(runner.calls, func(call recordedCall) bool {
		return call.name == "gh" && len(call.args) > 1 && call.args[0] == "repo" && call.args[1] == "create"
	})
	if index < 0 {
		t.Fatal("gh repo create not called")
	}
	call := runner.calls[index]
	sourceIndex := sliceIndex(call.args, "--source")
	if sourceIndex < 0 || sourceIndex+1 >= len(call.args) || !strings.Contains(call.args[sourceIndex+1], "temporary staging with spaces") {
		t.Fatalf("source argument was not preserved: %#v", call.args)
	}
	if call.name == "cmd" || call.name == "powershell" || call.name == "sh" {
		t.Fatalf("shell command used: %+v", call)
	}
}

func TestCreateReturnsReceiptAndErrorWhenCommandFailsAfterLanding(t *testing.T) {
	runner := newFakeRunner()
	runner.createErr = errors.New("connection closed")
	receipt, err := Create(context.Background(), testTarget("agent-control"), runner)
	if err == nil || !strings.Contains(err.Error(), "AGX-REPOSITORY-CREATE-PARTIAL") {
		t.Fatalf("Create() err = %v", err)
	}
	if !receipt.Created || receipt.Verification != VerificationReadback || receipt.InitialCommit != testCommit || receipt.NameWithOwner != "zaurakworks/agent-control" {
		t.Fatalf("receipt = %+v", receipt)
	}
	createIndex := callIndex(runner.calls, func(call recordedCall) bool {
		return call.name == "gh" && len(call.args) > 1 && call.args[0] == "repo"
	})
	readbacks := 0
	for _, call := range runner.calls[createIndex+1:] {
		if call.name == "gh" && argumentValue(call.args, "commit") == testCommit {
			readbacks++
		}
	}
	if readbacks != 1 {
		t.Fatalf("post-error readbacks = %d, want 1", readbacks)
	}
}

func TestCreateReturnsUncertainReceiptWhenReadbackIsInconclusiveAfterLanding(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeRunner)
	}{
		{name: "timeout", configure: func(runner *fakeRunner) { runner.readbackErrName = "agent-control" }},
		{name: "malformed", configure: func(runner *fakeRunner) { runner.readbackBadName = "agent-control" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runner := newFakeRunner()
			test.configure(runner)
			target := testTarget("agent-control")
			receipt, err := Create(context.Background(), target, runner)
			if err == nil || !strings.Contains(err.Error(), "AGX-REPOSITORY-READBACK-UNCERTAIN") {
				t.Fatalf("Create() err = %v, want uncertain readback failure", err)
			}
			if receipt.Created || receipt.Verification != VerificationUncertain {
				t.Fatalf("receipt state = %+v, want uncertain without a created claim", receipt)
			}
			if receipt.NameWithOwner != "zaurakworks/agent-control" ||
				receipt.URL != "https://github.com/zaurakworks/agent-control" ||
				receipt.Visibility != VisibilityPrivate || receipt.InitialCommit != testCommit ||
				receipt.TemplateVersion != target.Seed.Version || receipt.TemplateDigest != target.Seed.Digest {
				t.Fatalf("uncertain receipt lost recovery evidence: %+v", receipt)
			}
			if _, landed := runner.repositories["zaurakworks/agent-control"]; !landed {
				t.Fatal("fake repository did not land before inconclusive readback")
			}
			runner.readbackErrName = ""
			runner.readbackBadName = ""
			if err := Verify(context.Background(), receipt, runner); err != nil {
				t.Fatalf("Verify() rejected recoverable uncertain receipt: %v", err)
			}
		})
	}
}

func TestProvisionRetainsUncertainReceipt(t *testing.T) {
	runner := newFakeRunner()
	runner.readbackErrName = "agent-control"
	receipts, err := Provision(context.Background(), []Target{testTarget("agent-control")}, runner)
	if err == nil || len(receipts) != 1 || receipts[0].Verification != VerificationUncertain {
		t.Fatalf("Provision() receipts=%+v err=%v, want one uncertain receipt", receipts, err)
	}
}

func TestCreateFailureWithAbsentReadbackReturnsNoReceipt(t *testing.T) {
	runner := newFakeRunner()
	runner.landOnCreate = false
	runner.createErr = errors.New("permission denied")
	receipt, err := Create(context.Background(), testTarget("agent-control"), runner)
	if err == nil || receipt.Created {
		t.Fatalf("Create() receipt=%+v err=%v", receipt, err)
	}
	createIndex := callIndex(runner.calls, func(call recordedCall) bool {
		return call.name == "gh" && len(call.args) > 1 && call.args[0] == "repo"
	})
	readbacks := 0
	for _, call := range runner.calls[createIndex+1:] {
		if call.name == "gh" && argumentValue(call.args, "commit") == testCommit {
			readbacks++
		}
	}
	if readbacks != 1 {
		t.Fatalf("post-error readbacks = %d, want 1", readbacks)
	}
}

func TestUnsafeSeedPathsFailBeforeCommands(t *testing.T) {
	paths := []string{"../escape", "/absolute", "a/../../escape", `C:\\absolute`, `a\\windows`, "a//b", "./a"}
	for _, unsafe := range paths {
		t.Run(strings.ReplaceAll(unsafe, "/", "_"), func(t *testing.T) {
			target := testTarget("agent-control")
			target.Seed.Files[0].Path = unsafe
			runner := newFakeRunner()
			if _, err := Create(context.Background(), target, runner); err == nil {
				t.Fatalf("Create() accepted %q", unsafe)
			}
			if len(runner.calls) != 0 {
				t.Fatalf("commands ran for unsafe path: %+v", runner.calls)
			}
		})
	}
}

func TestSeedDigestMatchesBootstrapCanonicalManifest(t *testing.T) {
	rendered, err := bootstrap.Render(bootstrap.KindAgentControl, bootstrap.Params{
		Owner: "octo-lab", Repository: "agent-control", PluginSource: "zaurakworks/agent-plugins",
	})
	if err != nil {
		t.Fatal(err)
	}
	files := make([]File, 0, len(rendered.Files))
	for _, file := range rendered.Files {
		files = append(files, File{Path: file.Path, Content: file.Content})
	}
	if got := SeedDigest(files); got != rendered.Digest {
		t.Fatalf("SeedDigest() = %q, bootstrap digest = %q", got, rendered.Digest)
	}
}

func TestSeedDigestMismatchFailsBeforeCommands(t *testing.T) {
	target := testTarget("agent-control")
	target.Seed.Files[0].Content = []byte("# Tampered after digest\n")
	runner := newFakeRunner()
	if _, err := Create(context.Background(), target, runner); err == nil || !strings.Contains(err.Error(), "manifest digest does not match files") {
		t.Fatalf("Create() err = %v, want seed digest mismatch", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("commands ran for mismatched seed digest: %+v", runner.calls)
	}
}

func TestInvalidRepositoryTargetsFailBeforeCommands(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Target)
	}{
		{name: "owner", mutate: func(target *Target) { target.Owner = "bad/owner" }},
		{name: "repository", mutate: func(target *Target) { target.Name = "bad name" }},
		{name: "git suffix", mutate: func(target *Target) { target.Name = "agent-control.git" }},
		{name: "visibility", mutate: func(target *Target) { target.Visibility = "internal" }},
		{name: "digest", mutate: func(target *Target) { target.Seed.Digest = "mutable" }},
		{name: "duplicate files", mutate: func(target *Target) {
			target.Seed.Files = append(target.Seed.Files, File{Path: "readme.md", Content: []byte("duplicate")})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := testTarget("agent-control")
			test.mutate(&target)
			runner := newFakeRunner()
			if _, err := Create(context.Background(), target, runner); err == nil {
				t.Fatal("Create() accepted invalid target")
			}
			if len(runner.calls) != 0 {
				t.Fatalf("commands ran for invalid target: %+v", runner.calls)
			}
		})
	}
}

func TestWriteSeedRejectsSymlinkTarget(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "linked")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlinks unavailable: %v", err)
		}
		t.Fatal(err)
	}
	err := writeSeed(root, Seed{Files: []File{{Path: "linked/file.txt", Content: []byte("unsafe")}}})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("writeSeed() err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "file.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("outside target was written: %v", err)
	}
}

func TestMissingGitOrGHBlocksBeforeCommands(t *testing.T) {
	for _, missing := range []string{"git", "gh"} {
		t.Run(missing, func(t *testing.T) {
			runner := newFakeRunner()
			runner.missing = map[string]bool{missing: true}
			if _, err := Create(context.Background(), testTarget("agent-control"), runner); err == nil || !strings.Contains(err.Error(), "CLI-MISSING") {
				t.Fatalf("Create() err = %v", err)
			}
			if len(runner.calls) != 0 {
				t.Fatalf("commands = %+v", runner.calls)
			}
		})
	}
}

func TestInspectAndVerifyReachableInitializationCommit(t *testing.T) {
	runner := newFakeRunner()
	newHead := "cccccccccccccccccccccccccccccccccccccccc"
	runner.repositories["zaurakworks/agent-control"] = fakeRepository{
		nameWithOwner: "zaurakworks/agent-control",
		visibility:    VisibilityPrivate,
		defaultBranch: "main",
		head:          newHead,
		reachable:     map[string]bool{testCommit: true, newHead: true},
	}
	inspection, err := Inspect(context.Background(), "zaurakworks", "agent-control", runner)
	if err != nil {
		t.Fatal(err)
	}
	if inspection.HeadCommit != newHead || inspection.DefaultBranch != "main" {
		t.Fatalf("inspection = %+v", inspection)
	}
	receipt := Receipt{
		NameWithOwner:   "zaurakworks/agent-control",
		URL:             "https://github.com/zaurakworks/agent-control",
		Visibility:      VisibilityPrivate,
		InitialCommit:   testCommit,
		Created:         true,
		Verification:    VerificationReadback,
		TemplateVersion: "2026.08.17.1",
		TemplateDigest:  "sha256:" + strings.Repeat("a", 64),
	}
	if err := Verify(context.Background(), receipt, runner); err != nil {
		t.Fatal(err)
	}
	tamperedURL := receipt
	tamperedURL.URL = "https://example.com/zaurakworks/agent-control"
	if err := Verify(context.Background(), tamperedURL, runner); err == nil || !strings.Contains(err.Error(), "DRIFT") {
		t.Fatalf("Verify() accepted mismatched repository URL: %v", err)
	}
	repository := runner.repositories["zaurakworks/agent-control"]
	repository.reachable[testCommit] = false
	runner.repositories["zaurakworks/agent-control"] = repository
	if err := Verify(context.Background(), receipt, runner); err == nil || !strings.Contains(err.Error(), "DRIFT") {
		t.Fatalf("Verify() err = %v", err)
	}
}

func testTarget(name string) Target {
	target := Target{
		Owner:       "zaurakworks",
		Name:        name,
		Description: "AGX initialized repository",
		Visibility:  VisibilityPrivate,
		Seed: Seed{
			Version: "2026.08.17.1",
			Files:   []File{{Path: "README.md", Content: []byte("# Initialized\n")}},
		},
	}
	target.Seed.Digest = SeedDigest(target.Seed.Files)
	return target
}

func argumentValue(args []string, name string) string {
	prefix := name + "="
	for _, argument := range args {
		if strings.HasPrefix(argument, prefix) {
			return strings.TrimPrefix(argument, prefix)
		}
	}
	return ""
}

func argumentAfter(args []string, name string) string {
	for index, argument := range args {
		if argument == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func gitCommand(args []string) string {
	for index := 0; index < len(args); index++ {
		if args[index] == "-c" {
			index++
			continue
		}
		return args[index]
	}
	return ""
}

func contains(values []string, wanted string) bool {
	return sliceIndex(values, wanted) >= 0
}

func sliceIndex(values []string, wanted string) int {
	for index, value := range values {
		if value == wanted {
			return index
		}
	}
	return -1
}

func callIndex(calls []recordedCall, matches func(recordedCall) bool) int {
	for index, call := range calls {
		if matches(call) {
			return index
		}
	}
	return -1
}

func assertNoWrites(t *testing.T, calls []recordedCall) {
	t.Helper()
	for _, call := range calls {
		if call.name == "git" || (call.name == "gh" && len(call.args) > 1 && call.args[0] == "repo" && call.args[1] == "create") {
			t.Fatalf("write command was invoked: %+v", call)
		}
	}
}

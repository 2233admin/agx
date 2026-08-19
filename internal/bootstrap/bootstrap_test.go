package bootstrap

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestAgentControlValidationWorkflowDigest(t *testing.T) {
	parameters := []Params{
		{Owner: "octo-lab", Repository: "agent-control", PluginSource: AgentPluginsReferenceRepository},
		{Owner: "another-owner", Repository: "another-control", PluginSource: AgentPluginsReferenceRepository},
	}
	workflows := make([][]byte, 0, len(parameters))
	for _, params := range parameters {
		rendered, err := Render(KindAgentControl, params)
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range rendered.Files {
			if file.Path == ".github/workflows/validate.yml" {
				workflows = append(workflows, file.Content)
				break
			}
		}
	}
	if len(workflows) != len(parameters) {
		t.Fatal("agent-control validation workflow is missing")
	}
	if !bytes.Equal(workflows[0], workflows[1]) || bytes.Contains(workflows[0], []byte("@@AGX_")) {
		t.Fatalf("validation workflow must be deployment-independent and placeholder-free:\n%s", workflows[0])
	}
	digest := sha256.Sum256(workflows[0])
	if got := hex.EncodeToString(digest[:]); got != AgentControlValidationWorkflowSHA256 {
		t.Fatalf("validation workflow digest = %q, constant = %q", got, AgentControlValidationWorkflowSHA256)
	}
}

var goldenPaths = map[Kind][]string{
	KindAgentControl: {
		".gitattributes",
		".github/ISSUE_TEMPLATE/01-goal.yml",
		".github/ISSUE_TEMPLATE/02-need.yml",
		".github/ISSUE_TEMPLATE/03-delivery.yml",
		".github/ISSUE_TEMPLATE/04-experiment.yml",
		".github/ISSUE_TEMPLATE/05-research.yml",
		".github/ISSUE_TEMPLATE/06-friction.yml",
		".github/ISSUE_TEMPLATE/07-proposal.yml",
		".github/ISSUE_TEMPLATE/config.yml",
		".github/workflows/validate.yml",
		".gitignore",
		"AGENTS.md",
		"CLAUDE.md",
		"README.md",
		"authority/00-map.md",
		"authority/01-knowledge.md",
		"authority/02-long-horizon-work.md",
		"authority/04-collaboration.md",
		"authority/10-operating-ledger.md",
		"knowledge/README.md",
		"tools/validate.py",
		"work/current.md",
	},
	KindAgentContracts: {
		".gitattributes",
		".github/ISSUE_TEMPLATE/config.yml",
		".github/ISSUE_TEMPLATE/execution.yml",
		".github/ISSUE_TEMPLATE/goal.yml",
		".github/workflows/validate.yml",
		".gitignore",
		"AGENTS.md",
		"CLAUDE.md",
		"README.md",
		"examples/invalid/execution-contract-ref-mismatch.json",
		"examples/invalid/goal-missing-permissions.json",
		"examples/invalid/receipt-missing-source-digest.json",
		"examples/valid/execution-contract.json",
		"examples/valid/goal.json",
		"examples/valid/receipt.json",
		"schemas/execution-contract.schema.json",
		"schemas/goal.schema.json",
		"schemas/receipt.schema.json",
		"tests/fixtures/execution_issue.json",
		"tests/fixtures/goal_issue.json",
		"tests/fixtures/native_parent.json",
		"tests/test_contract.py",
		"tools/contract.py",
		"tools/validate.py",
	},
}

func TestRenderGoldenTreesAndDigests(t *testing.T) {
	params := Params{Owner: "octo-lab", PluginSource: "zaurakworks/agent-plugins"}
	wantDigests := map[Kind]string{
		KindAgentControl:   "8d3b4220cfb75787ad1897b1881d402505ab5e9fe255b35d5e33a4c9f1652638",
		KindAgentContracts: "73bedf20db31b166995776ecb2d6b32de5d49202fb781ab0de3bff2788a8b680",
	}

	for _, kind := range []Kind{KindAgentControl, KindAgentContracts} {
		t.Run(string(kind), func(t *testing.T) {
			params.Repository = string(kind)
			rendered, err := Render(kind, params)
			if err != nil {
				t.Fatalf("Render() error = %v", err)
			}
			var paths []string
			for _, file := range rendered.Files {
				paths = append(paths, file.Path)
			}
			if !reflect.DeepEqual(paths, goldenPaths[kind]) {
				t.Fatalf("rendered paths = %#v, want %#v", paths, goldenPaths[kind])
			}
			if rendered.Digest != wantDigests[kind] {
				t.Fatalf("Digest = %q, want %q", rendered.Digest, wantDigests[kind])
			}
		})
	}
}

func TestTemplateSetContentDigest(t *testing.T) {
	got, err := templateSetDigest()
	if err != nil {
		t.Fatalf("templateSetDigest() error = %v", err)
	}
	if got != TemplateSetContentSHA256 {
		t.Fatalf("templateSetDigest() = %q, constant = %q", got, TemplateSetContentSHA256)
	}
}

func TestRenderIsDeterministicAndParameterized(t *testing.T) {
	params := Params{
		Owner:        "example-owner",
		Repository:   "project-contracts",
		PluginSource: "source-org/portable-plugins",
	}
	first, err := Render(KindAgentContracts, params)
	if err != nil {
		t.Fatalf("first Render() error = %v", err)
	}
	second, err := Render(KindAgentContracts, params)
	if err != nil {
		t.Fatalf("second Render() error = %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("Render() returned different trees for the same input")
	}
	changedParams := params
	changedParams.Owner = "another-owner"
	changed, err := Render(KindAgentContracts, changedParams)
	if err != nil {
		t.Fatalf("changed Render() error = %v", err)
	}
	if changed.Digest == first.Digest {
		t.Fatal("rendered digest did not change with repository identity")
	}

	contractTool := contentAt(t, first, "tools/contract.py")
	for _, want := range []string{
		`REPOSITORY = "example-owner/project-contracts"`,
		`https://github\.com/example-owner/project-contracts/issues/`,
		`goal-project-contracts-001`,
	} {
		if !strings.Contains(contractTool, want) {
			t.Errorf("tools/contract.py does not contain %q", want)
		}
	}
	for _, forbidden := range []string{
		`REPOSITORY = "zaurakworks/agent-system"`,
		"https://github.com/zaurakworks/agent-system/issues/",
		"https://github.com/zaurakworks/agent-control/issues/",
	} {
		if strings.Contains(contractTool, forbidden) {
			t.Errorf("tools/contract.py still hardcodes %q", forbidden)
		}
	}
	readme := contentAt(t, first, "README.md")
	if !strings.Contains(readme, "https://github.com/source-org/portable-plugins") {
		t.Error("README.md does not contain the rendered Plugin source URL")
	}
	if strings.Contains(contractTool, placeholderPrefix) || strings.Contains(readme, placeholderPrefix) {
		t.Fatal("rendered files retain a template placeholder")
	}
}

func TestRenderedTreesDoNotLeakInstanceState(t *testing.T) {
	params := Params{Owner: "clean-owner", PluginSource: "zaurakworks/agent-plugins"}
	for _, kind := range []Kind{KindAgentControl, KindAgentContracts} {
		params.Repository = string(kind)
		rendered, err := Render(kind, params)
		if err != nil {
			t.Fatalf("Render(%q) error = %v", kind, err)
		}
		for _, file := range rendered.Files {
			lowerPath := strings.ToLower(file.Path)
			if strings.HasPrefix(lowerPath, "work/records/") ||
				strings.HasPrefix(lowerPath, "work/history/") ||
				strings.HasPrefix(lowerPath, "run-packages/") ||
				strings.HasPrefix(lowerPath, ".cap/") ||
				strings.HasPrefix(lowerPath, "src/agent_system/") ||
				strings.HasPrefix(lowerPath, "plugins/") ||
				strings.HasPrefix(lowerPath, "entrypoints/") {
				t.Errorf("%s contains source-monorepo path %q", kind, file.Path)
			}
			content := string(file.Content)
			for _, marker := range []string{
				"C:" + "/Users/",
				"C:" + `\` + "Users" + `\`,
				"/" + "Users/",
				"observed" + "At",
				"issuecomment-5307822402",
				"zaurakworks/agent-control",
			} {
				if strings.Contains(content, marker) {
					t.Errorf("%s/%s contains forbidden instance marker %q", kind, file.Path, marker)
				}
			}
			if bytes.Contains(file.Content, []byte{'\r'}) {
				t.Errorf("%s/%s contains a CR byte", kind, file.Path)
			}
		}
	}
}

func TestRenderedControlRulesUseEvidenceProfileLanguage(t *testing.T) {
	rendered, err := Render(KindAgentControl, Params{
		Owner:        "octo-lab",
		Repository:   "agent-control",
		PluginSource: AgentPluginsReferenceRepository,
	})
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	agents := contentAt(t, rendered, "AGENTS.md")
	authority := contentAt(t, rendered, "authority/00-map.md")
	for name, body := range map[string]string{"AGENTS.md": agents, "authority/00-map.md": authority} {
		if !strings.Contains(body, "Evidence Profile") {
			t.Errorf("%s is missing Evidence Profile language", name)
		}
		if strings.Contains(body, "local tree is verified") {
			t.Errorf("%s claims verified from a local tree", name)
		}
	}
	if !strings.Contains(agents, "never `verified`") {
		t.Error("AGENTS.md does not reserve verified for Evidence Profile readback")
	}
	if !strings.Contains(authority, "Do not emit `verified` from a local tree") {
		t.Error("authority/00-map.md does not forbid verified from a local tree")
	}
}

func TestWriteProducesExactTreeAndIsIdempotent(t *testing.T) {
	rendered, err := Render(KindAgentControl, Params{
		Owner:        "octo-lab",
		Repository:   "runtime-control",
		PluginSource: "zaurakworks/agent-plugins",
	})
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	root := filepath.Join(t.TempDir(), "repository")
	if err := Write(root, rendered); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if err := Write(root, rendered); err != nil {
		t.Fatalf("idempotent Write() error = %v", err)
	}

	var diskPaths []string
	err = filepath.WalkDir(root, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		diskPaths = append(diskPaths, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		t.Fatalf("WalkDir() error = %v", err)
	}
	sort.Strings(diskPaths)
	if !reflect.DeepEqual(diskPaths, goldenPaths[KindAgentControl]) {
		t.Fatalf("disk paths = %#v, want %#v", diskPaths, goldenPaths[KindAgentControl])
	}
	for _, file := range rendered.Files {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(file.Path)))
		if err != nil {
			t.Fatalf("ReadFile(%q) error = %v", file.Path, err)
		}
		if !bytes.Equal(got, file.Content) {
			t.Errorf("disk content for %q differs from rendered content", file.Path)
		}
	}
}

func TestRenderedBaselinesPassTheirValidators(t *testing.T) {
	python := ""
	for _, candidate := range []string{"python3", "python"} {
		if resolved, err := exec.LookPath(candidate); err == nil {
			python = resolved
			break
		}
	}
	if python == "" {
		t.Skip("Python is not available")
	}

	params := Params{Owner: "octo-lab", PluginSource: "zaurakworks/agent-plugins"}
	for _, kind := range []Kind{KindAgentControl, KindAgentContracts} {
		t.Run(string(kind), func(t *testing.T) {
			params.Repository = string(kind)
			rendered, err := Render(kind, params)
			if err != nil {
				t.Fatalf("Render() error = %v", err)
			}
			root := t.TempDir()
			if err := Write(root, rendered); err != nil {
				t.Fatalf("Write() error = %v", err)
			}
			command := exec.Command(python, "tools/validate.py")
			command.Dir = root
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("template validator error = %v\n%s", err, output)
			}
		})
	}
}

func TestWriteRejectsDriftAndSymlink(t *testing.T) {
	rendered, err := Render(KindAgentControl, Params{
		Owner:        "octo-lab",
		Repository:   "runtime-control",
		PluginSource: "zaurakworks/agent-plugins",
	})
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}

	t.Run("drift", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "README.md")
		if err := os.WriteFile(target, []byte("operator content\n"), 0o644); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		if err := Write(root, rendered); err == nil || !strings.Contains(err.Error(), "different content") {
			t.Fatalf("Write() error = %v, want content collision", err)
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatalf("ReadDir() error = %v", err)
		}
		if len(entries) != 1 || entries[0].Name() != "README.md" {
			t.Fatalf("Write() mutated root before reporting drift: %#v", entries)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		root := t.TempDir()
		outside := t.TempDir()
		link := filepath.Join(root, "authority")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		if err := Write(root, rendered); err == nil || !strings.Contains(err.Error(), "not a real directory") {
			t.Fatalf("Write() error = %v, want symlink rejection", err)
		}
	})
}

func TestRenderAndWriteRejectInvalidInput(t *testing.T) {
	valid := Params{Owner: "octo-lab", Repository: "agent-control", PluginSource: "zaurakworks/agent-plugins"}
	for _, test := range []struct {
		name   string
		kind   Kind
		params Params
	}{
		{name: "kind", kind: Kind("other"), params: valid},
		{name: "owner", kind: KindAgentControl, params: Params{Owner: "bad/owner", Repository: "agent-control", PluginSource: valid.PluginSource}},
		{name: "repository", kind: KindAgentControl, params: Params{Owner: valid.Owner, Repository: "../repo", PluginSource: valid.PluginSource}},
		{name: "source", kind: KindAgentControl, params: Params{Owner: valid.Owner, Repository: valid.Repository, PluginSource: "https://example.test/plugins"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Render(test.kind, test.params); err == nil {
				t.Fatal("Render() error = nil")
			}
		})
	}

	rendered, err := Render(KindAgentControl, valid)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	tampered := rendered
	tampered.Files = append([]File(nil), rendered.Files...)
	tampered.Files[0].Path = "../escape"
	tampered.Digest = manifestDigest(tampered.Files)
	if err := Write(t.TempDir(), tampered); err == nil || !strings.Contains(err.Error(), "invalid path") {
		t.Fatalf("Write() error = %v, want invalid path", err)
	}
}

func contentAt(t *testing.T, rendered Rendered, name string) string {
	t.Helper()
	for _, file := range rendered.Files {
		if file.Path == name {
			return string(file.Content)
		}
	}
	t.Fatalf("rendered tree does not contain %q", name)
	return ""
}

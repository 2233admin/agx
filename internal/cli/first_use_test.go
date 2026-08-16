package cli

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/exitcode"
	"github.com/2233admin/agx/internal/provider"
)

func TestFirstUsePrompts(t *testing.T) {
	tests := []struct {
		name      string
		profile   activation.Profile
		providers []provider.Name
		want      []firstUsePrompt
	}{
		{
			name:      "core codex",
			profile:   activation.ProfileCore,
			providers: []provider.Name{provider.Codex},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
			},
		},
		{
			name:      "core claude",
			profile:   activation.ProfileCore,
			providers: []provider.Name{provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
			},
		},
		{
			name:      "core both",
			profile:   activation.ProfileCore,
			providers: []provider.Name{provider.Codex, provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
			},
		},
		{
			name:      "full codex",
			profile:   activation.ProfileFull,
			providers: []provider.Name{provider.Codex},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Codex, Prompt: "$github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Codex, Prompt: "$resource-observability:resource-observability 查看当前账户额度"},
			},
		},
		{
			name:      "full claude",
			profile:   activation.ProfileFull,
			providers: []provider.Name{provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Claude, Prompt: "/github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Claude, Prompt: "/resource-observability:resource-observability 查看当前账户额度"},
			},
		},
		{
			name:      "full both",
			profile:   activation.ProfileFull,
			providers: []provider.Name{provider.Codex, provider.Claude},
			want: []firstUsePrompt{
				{Provider: provider.Codex, Prompt: "$grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Claude, Prompt: "/grilling:grilling 帮我压力测试这个方案"},
				{Provider: provider.Codex, Prompt: "$github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Claude, Prompt: "/github-collaboration:issue-workflow 处理 GitHub Issue #123"},
				{Provider: provider.Codex, Prompt: "$resource-observability:resource-observability 查看当前账户额度"},
				{Provider: provider.Claude, Prompt: "/resource-observability:resource-observability 查看当前账户额度"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			receipt := activation.Receipt{Profile: test.profile, Providers: providerReceipts(test.providers)}
			if got := firstUsePrompts(receipt); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("firstUsePrompts() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestInitResultSerializesStructuredFirstUse(t *testing.T) {
	receipt := activation.Receipt{
		InstallationID: "installation-test",
		Phase:          activation.PhaseInitialized,
		Profile:        activation.ProfileFull,
		Providers:      providerReceipts([]provider.Name{provider.Codex, provider.Claude}),
	}
	result := newInitResult(receipt, true)

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json.Marshal(newInitResult()) error = %v", err)
	}
	var decoded struct {
		FirstUse []firstUsePrompt `json:"first_use"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(init result) error = %v", err)
	}
	if !reflect.DeepEqual(decoded.FirstUse, firstUsePrompts(receipt)) {
		t.Fatalf("decoded first_use = %#v, want %#v", decoded.FirstUse, firstUsePrompts(receipt))
	}
	if !strings.Contains(string(data), `"first_use":[{"provider":"codex","prompt":"$grilling:grilling`) {
		t.Fatalf("init result JSON does not contain machine-readable first_use prompts: %s", data)
	}
}

func TestHumanFirstUseUsesStructuredPrompts(t *testing.T) {
	receipt := activation.Receipt{
		Profile:   activation.ProfileFull,
		Providers: providerReceipts([]provider.Name{provider.Codex, provider.Claude}),
	}
	stdout := new(bytes.Buffer)

	printFirstUse(stdout, receipt)

	want := "Start a new provider session, then try:\n" +
		"  Codex:  $grilling:grilling 帮我压力测试这个方案\n" +
		"  Claude: /grilling:grilling 帮我压力测试这个方案\n" +
		"  Codex:  $github-collaboration:issue-workflow 处理 GitHub Issue #123\n" +
		"  Claude: /github-collaboration:issue-workflow 处理 GitHub Issue #123\n" +
		"  Codex:  $resource-observability:resource-observability 查看当前账户额度\n" +
		"  Claude: /resource-observability:resource-observability 查看当前账户额度\n"
	if got := stdout.String(); got != want {
		t.Fatalf("printFirstUse() = %q, want %q", got, want)
	}
}

func TestApplyHelpAndNextStepRemainAvailable(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := Run([]string{"apply", "--help"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(apply --help) exit code = %d, want %d", code, exitcode.Success)
	}
	if stderr.Len() != 0 || !strings.Contains(stdout.String(), "agx apply --bundle <bundle.json> --root <directory>") {
		t.Fatalf("Run(apply --help) stdout=%q stderr=%q", stdout.String(), stderr.String())
	}

	stdout.Reset()
	printApplyNextStep(stdout)
	want := "Next: initialize this root with agx init --root <directory> --provider codex|claude|both [--profile core|github|team|full].\n" +
		"Installation phase is configured; initialization does not claim verified.\n"
	if got := stdout.String(); got != want {
		t.Fatalf("printApplyNextStep() = %q, want %q", got, want)
	}
}

func providerReceipts(names []provider.Name) []activation.ProviderReceipt {
	receipts := make([]activation.ProviderReceipt, 0, len(names))
	for _, name := range names {
		receipts = append(receipts, activation.ProviderReceipt{Name: name})
	}
	return receipts
}

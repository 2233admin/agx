package cli_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/cli"
	"github.com/2233admin/agx/internal/exitcode"
)

func TestRunShowsStableGlobalHelp(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"help"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(help) exit code = %d, want %d", code, exitcode.Success)
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run(help) stderr = %q, want empty", stderr.String())
	}
	for _, command := range []string{"plan", "apply", "init", "status", "diagnose", "uninstall", "version"} {
		if !strings.Contains(stdout.String(), command) {
			t.Errorf("global help does not contain %q", command)
		}
	}
}

func TestRunShowsDiagnoseHelp(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"diagnose", "--help"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success || stderr.Len() != 0 {
		t.Fatalf("Run(diagnose --help) code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	for _, text := range []string{"--root", "--evidence-profile", "multica-execution/v1", "--output human|json", "Project/repository evidence", "Agent smoke", "Read-only"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("Run(diagnose --help) stdout does not contain %q: %q", text, stdout.String())
		}
	}
}

func TestRunShowsInitHelp(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"init", "--help"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(init --help) exit code = %d, want %d", code, exitcode.Success)
	}
	for _, text := range []string{
		"--root", "--github-owner", "--provider", "--evidence-profile", "github-delivery/v1|multica-execution/v1", "core|github|team|full", "--apply", "safe uninstall",
		"Prerequisites", "Defaults", "profile: core", "visibility: private",
		"Repository model", "2233admin/agx", "zaurakworks/agent-plugins", "<owner>/agent-control", "<owner>/agent-contracts",
		"First deployment order", "A same-name repository is a collision",
	} {
		if !strings.Contains(stdout.String(), text) {
			t.Errorf("Run(init --help) stdout does not contain %q: %q", text, stdout.String())
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run(init --help) stderr = %q, want empty", stderr.String())
	}
}

func TestRunInitRequiresRootAndProvider(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"init", "--root", "somewhere"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Usage {
		t.Fatalf("Run(init) exit code = %d, want %d", code, exitcode.Usage)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "AGX-USAGE-INIT") {
		t.Fatalf("Run(init) stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	for _, text := range []string{
		"Prerequisites", "git", "authenticated GitHub CLI", "selected provider CLI",
		"Defaults", "--profile core", "--visibility private", "--control-repo agent-control", "--contracts-repo agent-contracts",
		"Order", "agx apply", "agx init --guided", "explicit init plan", "Collision policy", "never adopts or overwrites",
	} {
		if !strings.Contains(stderr.String(), text) {
			t.Fatalf("Run(init) usage stderr does not contain %q: %q", text, stderr.String())
		}
	}
}

func TestRunApplyUsageExplainsBuiltInAndOverrideSources(t *testing.T) {
	for _, args := range [][]string{
		{"apply"},
		{"apply", "--bundle", "bundle.json"},
		{"apply", "--root", `D:\agx`, "--bundle", "one.json", "--bundle", "two.json"},
	} {
		stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
		code := cli.Run(args, "0.0.0-test", stdout, stderr)
		if code != exitcode.Usage || stdout.Len() != 0 {
			t.Fatalf("Run(%v) code=%d stdout=%q stderr=%q", args, code, stdout.String(), stderr.String())
		}
		for _, want := range []string{"--root <directory> is required", "built-in production Bundle", "explicitly overrides", "cannot be combined"} {
			if !strings.Contains(stderr.String(), want) {
				t.Fatalf("Run(%v) stderr=%q, want %q", args, stderr.String(), want)
			}
		}
	}
}

func TestRunPrintsOfflineVersion(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"version"}, "1.2.3-preview", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(version) exit code = %d, want %d", code, exitcode.Success)
	}
	if got := stdout.String(); got != "agx 1.2.3-preview\n" {
		t.Fatalf("Run(version) stdout = %q", got)
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run(version) stderr = %q, want empty", stderr.String())
	}
}

func TestRunRejectsUnimplementedLifecycleCommand(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"resume"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Unsupported {
		t.Fatalf("Run(resume) exit code = %d, want %d", code, exitcode.Unsupported)
	}
	if stdout.Len() != 0 {
		t.Fatalf("Run(resume) stdout = %q, want empty", stdout.String())
	}
	if got := stderr.String(); !strings.Contains(got, "AGX-UNSUPPORTED-COMMAND") || !strings.Contains(got, "resume") {
		t.Fatalf("Run(resume) stderr = %q", got)
	}
}

func TestRunRejectsDailyTaskCommands(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"task"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Unsupported {
		t.Fatalf("Run(task) exit code = %d, want %d", code, exitcode.Unsupported)
	}
	if got := stderr.String(); !strings.Contains(got, "AGX-UNSUPPORTED-TASK") {
		t.Fatalf("Run(task) stderr = %q", got)
	}
}

func TestRunRejectsUnknownCommands(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"nonsense"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Software {
		t.Fatalf("Run(nonsense) exit code = %d, want %d", code, exitcode.Software)
	}
	if got := stderr.String(); !strings.Contains(got, "AGX-INVALID-INVOCATION") {
		t.Fatalf("Run(nonsense) stderr = %q", got)
	}
}

func TestRunShowsPerCommandHelpWithoutWriting(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"plan", "--help"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(plan --help) exit code = %d, want %d", code, exitcode.Success)
	}
	if got := stdout.String(); !strings.Contains(got, "agx plan") || !strings.Contains(got, "No external system is contacted") {
		t.Fatalf("Run(plan --help) stdout = %q", got)
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run(plan --help) stderr = %q, want empty", stderr.String())
	}
}

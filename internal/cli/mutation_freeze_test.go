package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/exitcode"
)

func TestLegacyMutationCommandsHandOffToConfigsWithoutActivation(t *testing.T) {
	commands := [][]string{
		{"apply", "--root", t.TempDir()},
		{"init", "--root", t.TempDir()},
		{"uninstall", "--root", t.TempDir()},
		{"upgrade", "--root", t.TempDir()},
		{"rollback", "--root", t.TempDir()},
		{"install", "--root", t.TempDir()},
		{"update", "--root", t.TempDir()},
		{"config", "--root", t.TempDir(), "list"},
	}
	for _, args := range commands {
		t.Run(args[0], func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := RunFrozen(args, "test", &stdout, &stderr)
			if code != exitcode.Unsupported {
				t.Fatalf("command %v exit code = %d, want unsupported", args, code)
			}
			if stderr.Len() != 0 {
				t.Fatalf("command %v wrote stderr: %q", args, stderr.String())
			}
			output := stdout.String()
			if !strings.Contains(output, `"kind":"migration-handoff"`) || !strings.Contains(output, `"next":"configs"`) || !strings.Contains(output, `"remote_retention":"retain"`) {
				t.Fatalf("command %v output = %q, want typed configs handoff", args, output)
			}
			if strings.Contains(strings.ToLower(output), "bundle") || strings.Contains(strings.ToLower(output), "receipt") || strings.Contains(strings.ToLower(output), "secret") || strings.Contains(strings.ToLower(output), "token") {
				t.Fatalf("command %v leaked legacy or credential marker: %q", args, output)
			}
		})
	}
}

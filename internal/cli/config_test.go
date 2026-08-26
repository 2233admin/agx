package cli_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/cli"
)

func TestRunConfigRequiresRootAndSubcommand(t *testing.T) {
	for _, args := range [][]string{
		{"config", "list"},
		{"config", "--root", t.TempDir()},
	} {
		stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
		code := cli.Run(args, "0.0.0-test", stdout, stderr)
		if code == 0 || !strings.Contains(stderr.String(), "AGX-USAGE-CONFIG") {
			t.Fatalf("Run(%q) code=%d stderr=%q", args, code, stderr.String())
		}
	}
}

func TestRunConfigFailsClosedWhenRuntimeIsAbsent(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := cli.Run([]string{"config", "--root", root, "list"}, "0.0.0-test", stdout, stderr)
	if code == 0 || !strings.Contains(stderr.String(), "AGX-CONFIG-RUNTIME") {
		t.Fatalf("Run() code=%d stderr=%q", code, stderr.String())
	}
}

func TestRunShowsConfigHelp(t *testing.T) {
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	code := cli.Run([]string{"config", "--help"}, "0.0.0-test", stdout, stderr)
	if code != 0 || !strings.Contains(stdout.String(), "agx config --root <directory>") {
		t.Fatalf("Run() code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

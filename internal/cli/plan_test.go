package cli_test

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/cli"
	"github.com/2233admin/agx/internal/contracts"
	"github.com/2233admin/agx/internal/exitcode"
)

func TestRunPlanRendersLocalContractWithoutWritingIt(t *testing.T) {
	path := fixturePath(t)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(before) error = %v", err)
	}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"plan", "--contract", path}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(plan) exit code = %d, want %d; stderr = %q", code, exitcode.Success, stderr.String())
	}
	for _, want := range []string{"AGX Installation Plan", "install-demo", "bundle-demo", "sha256:demo", "configure-demo", "reversible", "rollback", "No external system is contacted"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("human plan does not contain %q", want)
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run(plan) stderr = %q, want empty", stderr.String())
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(after) error = %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("plan changed its contract file")
	}
}

func TestRunPlanEmitsDecodedContractAsJSON(t *testing.T) {
	path := fixturePath(t)
	input, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	want, err := contracts.Decode(input)
	if err != nil {
		t.Fatalf("Decode(input) error = %v", err)
	}
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)

	code := cli.Run([]string{"plan", "--contract", path, "--output", "json"}, "0.0.0-test", stdout, stderr)
	if code != exitcode.Success {
		t.Fatalf("Run(plan --output json) exit code = %d, want %d; stderr = %q", code, exitcode.Success, stderr.String())
	}
	got, err := contracts.Decode(stdout.Bytes())
	if err != nil {
		t.Fatalf("Decode(output) error = %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded output = %#v, want %#v", got, want)
	}
}

func TestRunPlanRejectsMissingAndInvalidContracts(t *testing.T) {
	invalid := filepath.Join(t.TempDir(), "invalid.json")
	if err := os.WriteFile(invalid, []byte(`{"schema_version":"agx/contracts/v1","contract":{},"credential":"secret"}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	tests := []struct {
		name string
		args []string
		code int
		want string
	}{
		{name: "missing contract flag", args: []string{"plan"}, code: exitcode.Usage, want: "AGX-USAGE-PLAN"},
		{name: "unreadable contract", args: []string{"plan", "--contract", filepath.Join(t.TempDir(), "missing.json")}, code: exitcode.Data, want: "AGX-CONTRACT-READ"},
		{name: "unknown field", args: []string{"plan", "--contract", invalid}, code: exitcode.Data, want: "AGX-CONTRACT-INVALID"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
			if code := cli.Run(test.args, "0.0.0-test", stdout, stderr); code != test.code {
				t.Fatalf("Run(%v) exit code = %d, want %d; stderr = %q", test.args, code, test.code, stderr.String())
			}
			if !strings.Contains(stderr.String(), test.want) {
				t.Fatalf("Run(%v) stderr = %q, want %q", test.args, stderr.String(), test.want)
			}
		})
	}
}

func fixturePath(t *testing.T) string {
	t.Helper()
	return filepath.Join("..", "..", "testdata", "contracts", "v1", "plan-valid.json")
}

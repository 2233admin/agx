package multica

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/domain"
)

type fakeRunner struct {
	lookPathErr error
	output      []byte
	runErr      error
	gotName     string
	gotArgs     []string
	runCalls    int
}

func (f *fakeRunner) LookPath(string) (string, error) {
	if f.lookPathErr != nil {
		return "", f.lookPathErr
	}
	return "/usr/bin/multica", nil
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.runCalls++
	f.gotName = name
	f.gotArgs = args
	if f.runErr != nil {
		return nil, f.runErr
	}
	return f.output, nil
}

const arrayShape = `[
  {"id":"d3baaa7b","name":"Claude (AU-5090)","status":"online"},
  {"id":"b1173fcd","name":"Codex (AU-5090)","status":"online"},
  {"id":"3ee64460","name":"Claude (XR-3080)","status":"offline"}
]`

const wrappedShape = `{"runtimes":[{"id":"d3baaa7b","name":"Claude (AU-5090)","status":"online"}]}`

func TestRuntimeReadbackReturnsEvidenceForOnlineRuntime(t *testing.T) {
	for name, payload := range map[string]string{
		"array":   arrayShape,
		"wrapped": wrappedShape,
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{output: []byte(payload)}

			readback, err := RuntimeReadback(context.Background(), "inst-1", "Claude (AU-5090)", runner)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if readback.Source != domain.ReadbackSourceMultica {
				t.Errorf("source = %q, want %q", readback.Source, domain.ReadbackSourceMultica)
			}
			if readback.InstallationID != "inst-1" {
				t.Errorf("installation = %q, want inst-1", readback.InstallationID)
			}
			if readback.EvidenceID != "d3baaa7b" {
				t.Errorf("evidence = %q, want d3baaa7b", readback.EvidenceID)
			}
		})
	}
}

// AGENTS.md: the adapter may use only the versioned official CLI with
// structured output. Pin the exact invocation so a future edit cannot quietly
// switch to an unstructured or unofficial surface.
func TestRuntimeReadbackInvokesOnlyTheOfficialStructuredCLI(t *testing.T) {
	runner := &fakeRunner{output: []byte(arrayShape)}

	if _, err := RuntimeReadback(context.Background(), "inst-1", "Claude (AU-5090)", runner); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if runner.gotName != Binary {
		t.Errorf("binary = %q, want %q", runner.gotName, Binary)
	}
	if got := strings.Join(runner.gotArgs, " "); got != "runtime list --output json" {
		t.Errorf("args = %q, want %q", got, "runtime list --output json")
	}
	if runner.runCalls != 1 {
		t.Errorf("run calls = %d, want 1", runner.runCalls)
	}
}

func TestRuntimeReadbackRefusesToVerify(t *testing.T) {
	cases := map[string]struct {
		payload     string
		runtimeName string
		wantErr     error
	}{
		"absent": {
			payload:     arrayShape,
			runtimeName: "Claude (NOPE)",
			wantErr:     ErrAbsent,
		},
		"offline": {
			payload:     arrayShape,
			runtimeName: "Claude (XR-3080)",
			wantErr:     ErrNotOnline,
		},
		"ambiguous": {
			payload: `[{"id":"a","name":"dup","status":"online"},` +
				`{"id":"b","name":"dup","status":"online"}]`,
			runtimeName: "dup",
			wantErr:     ErrAmbiguous,
		},
		"blank id": {
			payload:     `[{"id":"","name":"Claude (AU-5090)","status":"online"}]`,
			runtimeName: "Claude (AU-5090)",
			wantErr:     ErrAbsent,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{output: []byte(tc.payload)}

			readback, err := RuntimeReadback(context.Background(), "inst-1", tc.runtimeName, runner)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if readback != (domain.Readback{}) {
				t.Errorf("readback = %+v, want zero value on refusal", readback)
			}
		})
	}
}

func TestRuntimeReadbackRejectsBadInput(t *testing.T) {
	runner := &fakeRunner{output: []byte(arrayShape)}

	if _, err := RuntimeReadback(context.Background(), "", "Claude (AU-5090)", runner); err == nil {
		t.Error("expected error for empty installation ID")
	}
	if _, err := RuntimeReadback(context.Background(), "inst-1", "   ", runner); err == nil {
		t.Error("expected error for blank runtime name")
	}
}

func TestRuntimeReadbackRequiresCLIOnPath(t *testing.T) {
	runner := &fakeRunner{lookPathErr: errors.New("not found")}

	if _, err := RuntimeReadback(context.Background(), "inst-1", "Claude (AU-5090)", runner); err == nil {
		t.Fatal("expected error when the official CLI is absent")
	}
	if runner.runCalls != 0 {
		t.Errorf("run calls = %d, want 0 when the CLI is absent", runner.runCalls)
	}
}

// A misread runtime list would fabricate verification evidence, so unparseable
// output must fail loudly rather than degrade to "no runtimes".
func TestRuntimeReadbackRejectsUnparseableOutput(t *testing.T) {
	for name, payload := range map[string]string{
		"garbage":       `not json`,
		"trailing":      arrayShape + ` {"extra":1}`,
		"wrong shape":   `{"items":[]}`,
		"scalar":        `42`,
		"null runtimes": `{"runtimes":null}`,
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{output: []byte(payload)}

			if _, err := RuntimeReadback(context.Background(), "inst-1", "x", runner); err == nil {
				t.Fatal("expected error for unparseable CLI output")
			} else if errors.Is(err, ErrAbsent) {
				t.Fatalf("unparseable output must not read as absent evidence: %v", err)
			}
		})
	}
}

func TestOSRunnerErrorOmitsCommandStderr(t *testing.T) {
	// Credentials can appear in Multica CLI stderr; AGENTS.md keeps them out of
	// logs and receipts. Verify the failure path never grows a stderr field.
	_, err := OSRunner{}.Run(context.Background(), "agx-multica-does-not-exist", "runtime", "list")
	if err == nil {
		t.Skip("unexpected: placeholder binary resolved on this host")
	}
	if strings.Contains(err.Error(), "stderr") {
		t.Errorf("error text must not carry stderr: %v", err)
	}
}

// The point of the whole adapter: a Multica readback is one of the two halves
// domain.NewVerifiedReceipt requires, and a refusal must make `verified`
// unreachable.
func TestReadbackFeedsVerifiedReceipt(t *testing.T) {
	runner := &fakeRunner{output: []byte(arrayShape)}

	multicaSide, err := RuntimeReadback(context.Background(), "inst-1", "Claude (AU-5090)", runner)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	githubSide := domain.Readback{
		Source:         domain.ReadbackSourceGitHub,
		InstallationID: "inst-1",
		EvidenceID:     "repo-node-id",
	}

	receipt, err := domain.NewVerifiedReceipt("inst-1", domain.Verification{
		GitHub:  githubSide,
		Multica: multicaSide,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if receipt.Phase != domain.PhaseVerified {
		t.Errorf("phase = %q, want %q", receipt.Phase, domain.PhaseVerified)
	}

	// Without the Multica half the receipt must not reach `verified`.
	if _, err := domain.NewVerifiedReceipt("inst-1", domain.Verification{
		GitHub: githubSide,
	}); err == nil {
		t.Error("expected verification to fail without a Multica readback")
	}
}

func TestAvailable(t *testing.T) {
	if !Available(&fakeRunner{}) {
		t.Error("expected available when LookPath succeeds")
	}
	if Available(&fakeRunner{lookPathErr: errors.New("nope")}) {
		t.Error("expected unavailable when LookPath fails")
	}
}

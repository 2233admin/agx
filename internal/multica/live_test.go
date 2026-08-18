package multica

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/2233admin/agx/internal/domain"
)

// Opt-in live check against a real Multica deployment. Skipped by default and
// in CI: it needs the official CLI on PATH, an authenticated session, and a
// runtime that is actually online. Unit tests cover the parsing and refusal
// logic; this exists so the adapter can be proven against the real CLI output
// rather than only against recorded fixtures.
//
//	AGX_LIVE_MULTICA_RUNTIME="Claude (AU-5090)" go test ./internal/multica/ -run Live -v
func TestLiveRuntimeReadback(t *testing.T) {
	runtimeName := os.Getenv("AGX_LIVE_MULTICA_RUNTIME")
	if runtimeName == "" {
		t.Skip("set AGX_LIVE_MULTICA_RUNTIME to run against a real deployment")
	}

	runner := OSRunner{}
	if !Available(runner) {
		t.Skipf("official %q CLI not on PATH", Binary)
	}

	const installationID domain.InstallationID = "agx-live-probe"

	readback, err := RuntimeReadback(context.Background(), installationID, runtimeName, runner)
	if err != nil {
		t.Fatalf("live readback for %q failed: %v", runtimeName, err)
	}
	if readback.Source != domain.ReadbackSourceMultica {
		t.Errorf("source = %q, want %q", readback.Source, domain.ReadbackSourceMultica)
	}
	if readback.EvidenceID == "" {
		t.Error("live readback returned an empty evidence ID")
	}
	t.Logf("live evidence for %q: %s", runtimeName, readback.EvidenceID)

	receipt, err := domain.NewVerifiedReceipt(installationID, domain.Verification{
		GitHub: domain.Readback{
			Source:         domain.ReadbackSourceGitHub,
			InstallationID: installationID,
			EvidenceID:     "probe-github-evidence",
		},
		Multica: readback,
	})
	if err != nil {
		t.Fatalf("verified receipt from live readback failed: %v", err)
	}
	if receipt.Phase != domain.PhaseVerified {
		t.Errorf("phase = %q, want %q", receipt.Phase, domain.PhaseVerified)
	}

	// A name that cannot exist must be refused, not silently verified — the
	// whole point of the adapter is that it can say no against a live server.
	if _, err := RuntimeReadback(
		context.Background(), installationID, "agx-live-probe-absent-runtime", runner,
	); !errors.Is(err, ErrAbsent) {
		t.Errorf("absent runtime error = %v, want ErrAbsent", err)
	}
}

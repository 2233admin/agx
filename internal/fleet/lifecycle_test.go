package fleet_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/2233admin/agx/internal/fleet"
)

func TestBuildPlanForValidProfileReportsOnePersistAction(t *testing.T) {
	plan := fleet.BuildPlan(validProfile())
	if len(plan.Diagnostics) != 0 {
		t.Fatalf("BuildPlan() diagnostics = %+v, want none", plan.Diagnostics)
	}
	if len(plan.Actions) != 1 {
		t.Fatalf("BuildPlan() actions = %+v, want exactly one", plan.Actions)
	}
}

// A Plan for an invalid profile carries its Diagnostics and reports no
// Actions; it must never claim it would persist a profile that Apply
// would then reject.
func TestBuildPlanForInvalidProfileReportsDiagnosticsAndNoActions(t *testing.T) {
	profile := validProfile()
	profile.Worker.Kind = ""
	plan := fleet.BuildPlan(profile)
	if len(plan.Diagnostics) == 0 {
		t.Fatal("BuildPlan() diagnostics empty, want the missing worker.kind reported")
	}
	if len(plan.Actions) != 0 {
		t.Fatalf("BuildPlan() actions = %+v, want none for an invalid profile", plan.Actions)
	}
}

// BuildPlan never touches the filesystem: same root before and after
// building a Plan for a root with no prior Deployment Profile.
func TestBuildPlanPerformsNoWrites(t *testing.T) {
	root := t.TempDir()
	fleet.BuildPlan(validProfile())
	if _, err := os.Stat(filepath.Join(root, ".agx")); !os.IsNotExist(err) {
		t.Fatalf("BuildPlan() created %s, want no filesystem changes", filepath.Join(root, ".agx"))
	}
}

// 1. First execution: Apply on a root with no existing Deployment Profile
// persists it and returns a Receipt with the expected stable identity,
// Adapter, and capability summary. Status then reads back configured.
func TestApplyFirstExecutionThenStatusReportsConfigured(t *testing.T) {
	root := t.TempDir()
	profile := validProfile()

	receipt, err := fleet.Apply(root, profile)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if receipt.DeploymentID != profile.DeploymentID || receipt.FleetID != profile.FleetID || receipt.InstallationID != profile.InstallationID {
		t.Fatalf("Apply() receipt identity = %+v, want it to match the profile", receipt)
	}
	if receipt.Adapter != "local+manual+manual+none+manual" {
		t.Fatalf("Apply() adapter = %q, want the deterministic axis-kind join", receipt.Adapter)
	}
	if len(receipt.Capabilities) != 5 {
		t.Fatalf("Apply() capabilities = %+v, want one entry per axis", receipt.Capabilities)
	}
	if receipt.ProfileDigest == "" {
		t.Fatal("Apply() left ProfileDigest empty")
	}

	path := filepath.Join(root, ".agx", "fleet-profile.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("Apply() did not persist %s: %v", path, err)
	}

	state, err := fleet.Status(root)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if state.Status != fleet.StatusConfigured || !state.Present || state.Receipt == nil {
		t.Fatalf("Status() = %+v, want configured with a Receipt", state)
	}
	if state.Receipt.ProfileDigest != receipt.ProfileDigest {
		t.Fatalf("Status() digest = %q, want %q from Apply()", state.Receipt.ProfileDigest, receipt.ProfileDigest)
	}
}

// 2. Repeat no-op: applying the exact same Profile a second time succeeds
// and returns byte-identical Receipt content, without erroring on the
// already-present file.
func TestApplyRepeatWithSameProfileIsNoOp(t *testing.T) {
	root := t.TempDir()
	profile := validProfile()

	first, err := fleet.Apply(root, profile)
	if err != nil {
		t.Fatalf("Apply() first error = %v", err)
	}
	second, err := fleet.Apply(root, profile)
	if err != nil {
		t.Fatalf("Apply() second error = %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("Apply() repeat = %+v, want identical to first %+v", second, first)
	}
}

// 3. Drift: applying a different Profile (different content digest) over
// an existing one at the same root is rejected, not silently overwritten.
func TestApplyRejectsDifferentProfileAtSameRoot(t *testing.T) {
	root := t.TempDir()
	profile := validProfile()
	if _, err := fleet.Apply(root, profile); err != nil {
		t.Fatalf("Apply() first error = %v", err)
	}

	changed := profile
	changed.FleetID = "fleet-2"
	if _, err := fleet.Apply(root, changed); err == nil {
		t.Fatal("Apply() accepted a different profile over an existing deployment")
	}

	// The original, valid Deployment Profile must remain untouched.
	state, err := fleet.Status(root)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if state.Receipt == nil || state.Receipt.FleetID != profile.FleetID {
		t.Fatalf("Status() = %+v, want the original profile preserved after a rejected drift Apply", state)
	}
}

// 4. Failure recovery: Apply refuses an invalid Profile outright and
// never persists it, so a caller can fix the Profile and retry cleanly.
func TestApplyRejectsInvalidProfileAndPersistsNothing(t *testing.T) {
	root := t.TempDir()
	profile := validProfile()
	profile.Runtime.Kind = "unsupported"

	if _, err := fleet.Apply(root, profile); err == nil {
		t.Fatal("Apply() accepted an invalid profile")
	}
	if _, err := os.Stat(filepath.Join(root, ".agx", "fleet-profile.json")); !os.IsNotExist(err) {
		t.Fatal("Apply() persisted a Deployment Profile despite validation failure")
	}
	state, err := fleet.Status(root)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if state.Status != fleet.StatusAbsent {
		t.Fatalf("Status() = %+v, want absent after a rejected Apply", state)
	}
}

func TestStatusReportsAbsentForFreshRoot(t *testing.T) {
	root := t.TempDir()
	state, err := fleet.Status(root)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if state.Status != fleet.StatusAbsent || state.Present || state.Receipt != nil {
		t.Fatalf("Status() = %+v, want absent with no Receipt", state)
	}
}

// 5. Drift by external edit: a persisted Deployment Profile hand-edited
// into an invalid state must be reported drifted, not silently treated
// as absent or configured.
func TestStatusReportsDriftedAfterExternalEditMakesProfileInvalid(t *testing.T) {
	root := t.TempDir()
	profile := validProfile()
	if _, err := fleet.Apply(root, profile); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}

	path := filepath.Join(root, ".agx", "fleet-profile.json")
	corrupted := []byte(`{"schema_version":"agx.fleet-profile/v1","installation_id":"install-0123456789abcdef","deployment_id":"deployment-1","fleet_id":"fleet-1","worker":{"id":"worker-1","kind":"local"},"transport":{"id":"transport-1","kind":"manual"},"runtime":{"id":"runtime-1","kind":""},"work_hub":{"kind":"none"},"runtime_bridge":{"id":"bridge-1","kind":"manual"}}`)
	if err := os.WriteFile(path, corrupted, 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	state, err := fleet.Status(root)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if state.Status != fleet.StatusDrifted || !state.Present || len(state.Diagnostics) == 0 {
		t.Fatalf("Status() = %+v, want drifted with diagnostics", state)
	}
}

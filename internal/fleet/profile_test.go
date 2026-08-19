package fleet_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/fleet"
)

func validProfile() fleet.Profile {
	return fleet.Profile{
		SchemaVersion:  fleet.SchemaVersionV1,
		InstallationID: "install-0123456789abcdef",
		DeploymentID:   "deployment-1",
		FleetID:        "fleet-1",
		Worker:         fleet.Ref{ID: "worker-1", Kind: string(fleet.WorkerKindLocal)},
		Transport:      fleet.Ref{ID: "transport-1", Kind: string(fleet.TransportKindManual)},
		Runtime:        fleet.Ref{ID: "runtime-1", Kind: string(fleet.RuntimeKindManual)},
		WorkHub:        fleet.Ref{Kind: string(fleet.WorkHubKindNone)},
		RuntimeBridge:  fleet.Ref{ID: "bridge-1", Kind: string(fleet.RuntimeBridgeKindManual)},
	}
}

func TestValidateProfileAcceptsCompleteV1Profile(t *testing.T) {
	if diagnostics := fleet.ValidateProfile(validProfile()); len(diagnostics) != 0 {
		t.Fatalf("ValidateProfile() = %+v, want none", diagnostics)
	}
}

// 1. No axis may ever be inferred from another: every required field
// missing on its own must fail preflight with a distinct diagnostic.
func TestValidateProfileRejectsEachMissingRequiredField(t *testing.T) {
	tests := map[string]func(*fleet.Profile){
		"installation_id missing":     func(p *fleet.Profile) { p.InstallationID = "" },
		"deployment_id missing":       func(p *fleet.Profile) { p.DeploymentID = "" },
		"fleet_id missing":            func(p *fleet.Profile) { p.FleetID = "" },
		"worker.kind missing":         func(p *fleet.Profile) { p.Worker.Kind = "" },
		"worker.id missing":           func(p *fleet.Profile) { p.Worker.ID = "" },
		"transport.kind missing":      func(p *fleet.Profile) { p.Transport.Kind = "" },
		"transport.id missing":        func(p *fleet.Profile) { p.Transport.ID = "" },
		"runtime.kind missing":        func(p *fleet.Profile) { p.Runtime.Kind = "" },
		"runtime.id missing":          func(p *fleet.Profile) { p.Runtime.ID = "" },
		"work_hub.kind missing":       func(p *fleet.Profile) { p.WorkHub.Kind = "" },
		"runtime_bridge.kind missing": func(p *fleet.Profile) { p.RuntimeBridge.Kind = "" },
		"runtime_bridge.id missing":   func(p *fleet.Profile) { p.RuntimeBridge.ID = "" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			profile := validProfile()
			mutate(&profile)
			diagnostics := fleet.ValidateProfile(profile)
			if len(diagnostics) == 0 {
				t.Fatalf("ValidateProfile() accepted a profile missing %s", name)
			}
			for _, diagnostic := range diagnostics {
				if diagnostic.Code != fleet.DiagnosticFieldMissing {
					t.Fatalf("diagnostic code = %v, want %v", diagnostic.Code, fleet.DiagnosticFieldMissing)
				}
			}
		})
	}
}

// work_hub.id is the one axis whose ID is not required (v1's only
// supported Work Hub kind, "none", has no identity of its own).
func TestValidateProfileAllowsEmptyWorkHubID(t *testing.T) {
	profile := validProfile()
	profile.WorkHub.ID = ""
	if diagnostics := fleet.ValidateProfile(profile); len(diagnostics) != 0 {
		t.Fatalf("ValidateProfile() = %+v, want none for empty work_hub.id", diagnostics)
	}
}

// 2. An unsupported schema_version must be rejected outright, and nothing
// else about the profile is safe to validate against an unknown schema.
func TestValidateProfileRejectsUnsupportedSchemaVersion(t *testing.T) {
	profile := validProfile()
	profile.SchemaVersion = "agx.fleet-profile/v2"
	diagnostics := fleet.ValidateProfile(profile)
	if len(diagnostics) != 1 || diagnostics[0].Code != fleet.DiagnosticSchemaUnsupported {
		t.Fatalf("ValidateProfile() = %+v, want exactly one %v diagnostic", diagnostics, fleet.DiagnosticSchemaUnsupported)
	}
}

// 3. An axis Kind AGX does not recognize must fail closed, not be
// silently accepted or treated as a supported default.
func TestValidateProfileRejectsUnsupportedKind(t *testing.T) {
	tests := map[string]func(*fleet.Profile){
		"worker kind":         func(p *fleet.Profile) { p.Worker.Kind = "remote" },
		"transport kind":      func(p *fleet.Profile) { p.Transport.Kind = "ssh" },
		"runtime kind":        func(p *fleet.Profile) { p.Runtime.Kind = "codex" },
		"work_hub kind":       func(p *fleet.Profile) { p.WorkHub.Kind = "github" },
		"runtime_bridge kind": func(p *fleet.Profile) { p.RuntimeBridge.Kind = "automated" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			profile := validProfile()
			mutate(&profile)
			diagnostics := fleet.ValidateProfile(profile)
			if len(diagnostics) == 0 {
				t.Fatalf("ValidateProfile() accepted unsupported %s", name)
			}
			found := false
			for _, diagnostic := range diagnostics {
				if diagnostic.Code == fleet.DiagnosticKindUnsupported {
					found = true
				}
			}
			if !found {
				t.Fatalf("ValidateProfile() = %+v, want a %v diagnostic", diagnostics, fleet.DiagnosticKindUnsupported)
			}
		})
	}
}

// 4. Two axes sharing the same explicit ID is a stable diagnostic, not a
// silently accepted collision.
func TestValidateProfileRejectsDuplicateIDAcrossAxes(t *testing.T) {
	profile := validProfile()
	profile.Transport.ID = profile.Worker.ID
	diagnostics := fleet.ValidateProfile(profile)
	found := false
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == fleet.DiagnosticDuplicateID {
			found = true
		}
	}
	if !found {
		t.Fatalf("ValidateProfile() = %+v, want a %v diagnostic", diagnostics, fleet.DiagnosticDuplicateID)
	}
}

func TestParseProfileRoundTrip(t *testing.T) {
	profile := validProfile()
	encoded, err := json.Marshal(profile)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	decoded, err := fleet.ParseProfile(encoded)
	if err != nil {
		t.Fatalf("ParseProfile() error = %v", err)
	}
	if decoded != profile {
		t.Fatalf("ParseProfile() = %+v, want %+v", decoded, profile)
	}
}

func TestParseProfileRejectsUnknownField(t *testing.T) {
	raw := `{"schema_version":"agx.fleet-profile/v1","installation_id":"install-0123456789abcdef","deployment_id":"d","fleet_id":"f","worker":{"id":"w","kind":"local"},"transport":{"id":"t","kind":"manual"},"runtime":{"id":"r","kind":"manual"},"work_hub":{"kind":"none"},"runtime_bridge":{"id":"b","kind":"manual"},"unexpected_field":true}`
	if _, err := fleet.ParseProfile([]byte(raw)); err == nil {
		t.Fatal("ParseProfile() accepted an unknown field")
	}
}

func TestParseProfileRejectsDuplicateKey(t *testing.T) {
	raw := `{"schema_version":"agx.fleet-profile/v1","schema_version":"agx.fleet-profile/v1","installation_id":"install-0123456789abcdef","deployment_id":"d","fleet_id":"f","worker":{"id":"w","kind":"local"},"transport":{"id":"t","kind":"manual"},"runtime":{"id":"r","kind":"manual"},"work_hub":{"kind":"none"},"runtime_bridge":{"id":"b","kind":"manual"}}`
	if _, err := fleet.ParseProfile([]byte(raw)); err == nil {
		t.Fatal("ParseProfile() accepted a duplicate JSON key")
	}
}

func TestParseProfileRejectsTrailingData(t *testing.T) {
	profile := validProfile()
	encoded, err := json.Marshal(profile)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	raw := append(encoded, []byte(`{}`)...)
	if _, err := fleet.ParseProfile(raw); err == nil {
		t.Fatal("ParseProfile() accepted trailing data")
	}
}

func TestComputeProfileDigestIsDeterministicAndRejectsInvalidProfile(t *testing.T) {
	profile := validProfile()
	first, err := fleet.ComputeProfileDigest(profile)
	if err != nil {
		t.Fatalf("ComputeProfileDigest() error = %v", err)
	}
	second, err := fleet.ComputeProfileDigest(profile)
	if err != nil {
		t.Fatalf("ComputeProfileDigest() error = %v", err)
	}
	if first != second {
		t.Fatalf("ComputeProfileDigest() = %q then %q, want identical for identical input", first, second)
	}
	if !strings.HasPrefix(first, "") || len(first) != 64 {
		t.Fatalf("ComputeProfileDigest() = %q, want a 64-char hex SHA-256 digest", first)
	}

	other := profile
	other.DeploymentID = "deployment-2"
	otherDigest, err := fleet.ComputeProfileDigest(other)
	if err != nil {
		t.Fatalf("ComputeProfileDigest() error = %v", err)
	}
	if otherDigest == first {
		t.Fatal("ComputeProfileDigest() produced the same digest for two different profiles")
	}

	invalid := profile
	invalid.Worker.Kind = ""
	if _, err := fleet.ComputeProfileDigest(invalid); err == nil {
		t.Fatal("ComputeProfileDigest() accepted an invalid profile")
	}
}

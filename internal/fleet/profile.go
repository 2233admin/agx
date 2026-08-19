// Package fleet defines the Hub-neutral Agent Fleet Deployment Profile
// object model (see issue #53): an installation optionally declares one
// versioned Deployment Profile that references a Worker, a Transport, a
// Runtime, a Work Hub, and a Runtime Bridge as independent, explicitly
// declared axes. No axis is ever inferred from another: a profile missing
// any required explicit binding fails validation instead of silently
// defaulting.
//
// v1 (agx.fleet-profile/v1) is the first tracer bullet: it supports exactly
// one Worker kind (local), one Transport kind (manual), one Runtime kind
// (manual), one Runtime Bridge kind (manual), and an explicit "none" Work
// Hub. Nothing in this schema is automated yet; apply only persists the
// declared Profile and returns a Receipt proving the object model survives
// a real parse/validate/plan/apply/status round trip through the existing
// AGX CLI lifecycle. Later Fleet tickets add real Worker/Runtime/Work Hub
// kinds without changing this shape.
package fleet

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/2233admin/agx/internal/domain"
	"github.com/2233admin/agx/internal/strictjson"
)

// SchemaVersionV1 is the only Deployment Profile schema version this
// package currently supports.
const SchemaVersionV1 = "agx.fleet-profile/v1"

type WorkerKind string
type TransportKind string
type RuntimeKind string
type WorkHubKind string
type RuntimeBridgeKind string

const (
	WorkerKindLocal         WorkerKind        = "local"
	TransportKindManual     TransportKind     = "manual"
	RuntimeKindManual       RuntimeKind       = "manual"
	WorkHubKindNone         WorkHubKind       = "none"
	RuntimeBridgeKindManual RuntimeBridgeKind = "manual"
)

// Diagnostic codes returned by ValidateProfile.
const (
	DiagnosticSchemaUnsupported domain.DiagnosticCode = "AGX-FLEET-PROFILE-SCHEMA-UNSUPPORTED"
	DiagnosticFieldMissing      domain.DiagnosticCode = "AGX-FLEET-PROFILE-FIELD-MISSING"
	DiagnosticKindUnsupported   domain.DiagnosticCode = "AGX-FLEET-PROFILE-KIND-UNSUPPORTED"
	DiagnosticDuplicateID       domain.DiagnosticCode = "AGX-FLEET-PROFILE-DUPLICATE-ID"
)

// Ref is a stable, explicit reference to one Fleet axis object. Kind must
// be one of that axis's supported values; ID is the caller-chosen stable
// identifier for the referenced object and must be unique within the
// Profile across every axis.
type Ref struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

// Profile is a versioned Deployment Profile: one Worker, Transport,
// Runtime, Work Hub, and Runtime Bridge, each declared independently, plus
// the stable identity fields a receipt and later status/diagnose readback
// need. EvidenceProfile optionally references an existing
// domain.EvidenceProfileID by value; this package does not depend on the
// activation/domain evidence machinery and never interprets that value.
type Profile struct {
	SchemaVersion   string `json:"schema_version"`
	InstallationID  string `json:"installation_id"`
	DeploymentID    string `json:"deployment_id"`
	FleetID         string `json:"fleet_id"`
	Worker          Ref    `json:"worker"`
	Transport       Ref    `json:"transport"`
	Runtime         Ref    `json:"runtime"`
	WorkHub         Ref    `json:"work_hub"`
	RuntimeBridge   Ref    `json:"runtime_bridge"`
	EvidenceProfile string `json:"evidence_profile,omitempty"`
}

// ParseProfile decodes data as a Profile. It rejects unknown fields,
// trailing data, and duplicate JSON object keys; it does not validate
// field values (use ValidateProfile for that), so an unsupported
// schema_version or missing required field parses successfully and is
// reported by ValidateProfile instead.
func ParseProfile(data []byte) (Profile, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var profile Profile
	if err := decoder.Decode(&profile); err != nil {
		return Profile{}, fmt.Errorf("AGX-FLEET-PROFILE-INVALID: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Profile{}, fmt.Errorf("AGX-FLEET-PROFILE-INVALID: trailing data")
	}
	if err := strictjson.RejectDuplicateKeys(data); err != nil {
		return Profile{}, fmt.Errorf("AGX-FLEET-PROFILE-INVALID: %w", err)
	}
	return profile, nil
}

type axisRule struct {
	name          string
	ref           Ref
	supportedKind string
	idRequired    bool
}

// ValidateProfile fails closed: it never infers a missing axis from
// another, never defaults an absent Kind, and reports every problem it
// finds rather than stopping at the first one (except when
// schema_version itself is unsupported, since no other field can be
// safely interpreted against an unknown schema).
func ValidateProfile(profile Profile) []domain.Diagnostic {
	var diagnostics []domain.Diagnostic
	add := func(code domain.DiagnosticCode, message string) {
		diagnostics = append(diagnostics, domain.Diagnostic{
			Code: code, Category: domain.DiagnosticCategoryPreflight, Severity: domain.SeverityError, Message: message,
		})
	}

	if profile.SchemaVersion != SchemaVersionV1 {
		add(DiagnosticSchemaUnsupported, fmt.Sprintf("schema_version %q is not supported", profile.SchemaVersion))
		return diagnostics
	}
	if strings.TrimSpace(profile.InstallationID) == "" {
		add(DiagnosticFieldMissing, "installation_id is required")
	}
	if strings.TrimSpace(profile.DeploymentID) == "" {
		add(DiagnosticFieldMissing, "deployment_id is required")
	}
	if strings.TrimSpace(profile.FleetID) == "" {
		add(DiagnosticFieldMissing, "fleet_id is required")
	}

	axes := []axisRule{
		{"worker", profile.Worker, string(WorkerKindLocal), true},
		{"transport", profile.Transport, string(TransportKindManual), true},
		{"runtime", profile.Runtime, string(RuntimeKindManual), true},
		{"work_hub", profile.WorkHub, string(WorkHubKindNone), false},
		{"runtime_bridge", profile.RuntimeBridge, string(RuntimeBridgeKindManual), true},
	}

	ownerByID := map[string]string{}
	for _, axis := range axes {
		if strings.TrimSpace(axis.ref.Kind) == "" {
			add(DiagnosticFieldMissing, axis.name+".kind is required")
			continue
		}
		if axis.ref.Kind != axis.supportedKind {
			add(DiagnosticKindUnsupported, fmt.Sprintf("%s.kind %q is not supported in %s", axis.name, axis.ref.Kind, SchemaVersionV1))
			continue
		}
		if axis.idRequired && strings.TrimSpace(axis.ref.ID) == "" {
			add(DiagnosticFieldMissing, axis.name+".id is required")
			continue
		}
		if axis.ref.ID == "" {
			continue
		}
		if owner, seen := ownerByID[axis.ref.ID]; seen {
			add(DiagnosticDuplicateID, fmt.Sprintf("%s and %s share id %q", owner, axis.name, axis.ref.ID))
			continue
		}
		ownerByID[axis.ref.ID] = axis.name
	}
	return diagnostics
}

// ComputeProfileDigest returns the stable content digest of a valid
// Profile. It refuses to digest an invalid Profile so a digest can never
// stand in for validation.
func ComputeProfileDigest(profile Profile) (string, error) {
	if diagnostics := ValidateProfile(profile); len(diagnostics) > 0 {
		return "", fmt.Errorf("AGX-FLEET-PROFILE-INVALID: profile has %d diagnostic(s), first: %s", len(diagnostics), diagnostics[0].Message)
	}
	data, err := json.Marshal(profile)
	if err != nil {
		return "", fmt.Errorf("AGX-FLEET-PROFILE-INVALID: %w", err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

// adapterID deterministically names the concrete Adapter a valid Profile
// selects. v1 has exactly one Adapter per axis-kind combination; later
// schema versions may select among several real Adapters per Work Hub/
// Runtime Bridge combination.
func adapterID(profile Profile) string {
	return strings.Join([]string{profile.Worker.Kind, profile.Transport.Kind, profile.Runtime.Kind, profile.WorkHub.Kind, profile.RuntimeBridge.Kind}, "+")
}

// capabilitySummary lists the declared axis bindings in a stable,
// deterministic order for receipt/status human and JSON output.
func capabilitySummary(profile Profile) []string {
	return []string{
		"worker:" + profile.Worker.Kind,
		"transport:" + profile.Transport.Kind,
		"runtime:" + profile.Runtime.Kind,
		"work_hub:" + profile.WorkHub.Kind,
		"runtime_bridge:" + profile.RuntimeBridge.Kind,
	}
}

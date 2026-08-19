package fleet

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/2233admin/agx/internal/domain"
	"github.com/2233admin/agx/internal/metadatafile"
)

const fleetProfileFile = "fleet-profile.json"

// Plan is the deterministic, side-effect-free result of BuildPlan: every
// declared object, the schema/kind of each, and the exact actions Apply
// would take. Building a Plan never performs a write, network call, or
// external command.
type Plan struct {
	Profile     Profile             `json:"profile"`
	Actions     []string            `json:"actions,omitempty"`
	Diagnostics []domain.Diagnostic `json:"diagnostics,omitempty"`
}

// Receipt is the non-sensitive, persisted-alongside result of a successful
// Apply: stable IDs, the selected Adapter, the Profile's content digest,
// and a capability summary. It never contains credentials, business
// content, or absolute user paths.
type Receipt struct {
	SchemaVersion   string   `json:"schema_version"`
	InstallationID  string   `json:"installation_id"`
	DeploymentID    string   `json:"deployment_id"`
	FleetID         string   `json:"fleet_id"`
	Worker          Ref      `json:"worker"`
	Transport       Ref      `json:"transport"`
	Runtime         Ref      `json:"runtime"`
	WorkHub         Ref      `json:"work_hub"`
	RuntimeBridge   Ref      `json:"runtime_bridge"`
	EvidenceProfile string   `json:"evidence_profile,omitempty"`
	Adapter         string   `json:"adapter"`
	ProfileDigest   string   `json:"profile_digest"`
	Capabilities    []string `json:"capabilities"`
}

func buildReceipt(profile Profile, digest string) Receipt {
	return Receipt{
		SchemaVersion:   profile.SchemaVersion,
		InstallationID:  profile.InstallationID,
		DeploymentID:    profile.DeploymentID,
		FleetID:         profile.FleetID,
		Worker:          profile.Worker,
		Transport:       profile.Transport,
		Runtime:         profile.Runtime,
		WorkHub:         profile.WorkHub,
		RuntimeBridge:   profile.RuntimeBridge,
		EvidenceProfile: profile.EvidenceProfile,
		Adapter:         adapterID(profile),
		ProfileDigest:   digest,
		Capabilities:    capabilitySummary(profile),
	}
}

// BuildPlan validates profile and reports every object, version,
// capability, and target resource Apply would touch, with zero external
// writes. An invalid profile produces a Plan with Diagnostics and no
// Actions; callers must refuse --apply on a Plan with any Diagnostic.
func BuildPlan(profile Profile) Plan {
	diagnostics := ValidateProfile(profile)
	plan := Plan{Profile: profile, Diagnostics: diagnostics}
	if len(diagnostics) == 0 {
		plan.Actions = []string{"persist Deployment Profile at .agx/" + fleetProfileFile}
	}
	return plan
}

// Status values for State.Status.
const (
	StatusAbsent     = "absent"
	StatusConfigured = "configured"
	StatusDrifted    = "drifted"
)

// State is Status's read-only report. Configured means the persisted
// Profile is present, well-formed, and valid — it is a purely local,
// internally-consistent claim and is never equivalent to any external
// verification; this package has no concept of "verified" and never
// produces one.
type State struct {
	Present     bool                `json:"present"`
	Status      string              `json:"status"`
	Receipt     *Receipt            `json:"receipt,omitempty"`
	Diagnostics []domain.Diagnostic `json:"diagnostics,omitempty"`
}

// Apply validates profile, then persists it at .agx/fleet-profile.json
// under root and returns the resulting Receipt. Apply only performs the
// actions BuildPlan(profile) reported; it never mutates anything outside
// the local .agx directory (v1's Worker/Transport/Runtime/Runtime Bridge
// are all local/manual, so there is nothing else to mutate yet).
//
// Re-applying the same Profile (identical content digest) is a no-op that
// returns the same Receipt. Applying a different Profile over an existing
// one is rejected as drift: callers must use a new deployment_id for a
// distinct deployment rather than silently rebinding an existing one.
func Apply(root string, profile Profile) (Receipt, error) {
	diagnostics := ValidateProfile(profile)
	if len(diagnostics) > 0 {
		return Receipt{}, fmt.Errorf("AGX-FLEET-PROFILE-INVALID: profile has %d diagnostic(s), first: %s", len(diagnostics), diagnostics[0].Message)
	}
	digest, err := ComputeProfileDigest(profile)
	if err != nil {
		return Receipt{}, err
	}
	existing, present, err := readProfile(root)
	if err != nil {
		return Receipt{}, err
	}
	if present {
		existingDigest, digestErr := ComputeProfileDigest(existing)
		if digestErr != nil {
			return Receipt{}, digestErr
		}
		if existingDigest != digest {
			return Receipt{}, fmt.Errorf("AGX-FLEET-DEPLOYMENT-PROFILE-DRIFT: an existing Deployment Profile for a different configuration is already applied at this root; use a new deployment_id for a distinct deployment")
		}
		return buildReceipt(profile, digest), nil
	}
	if err := writeProfile(root, profile); err != nil {
		return Receipt{}, err
	}
	return buildReceipt(profile, digest), nil
}

// Status reads back the persisted Profile at root and reports whether it
// is absent, configured (present and internally valid), or drifted
// (present but no longer valid, e.g. after a hand-edit).
func Status(root string) (State, error) {
	profile, present, err := readProfile(root)
	if err != nil {
		return State{}, err
	}
	if !present {
		return State{Status: StatusAbsent}, nil
	}
	diagnostics := ValidateProfile(profile)
	if len(diagnostics) > 0 {
		return State{Present: true, Status: StatusDrifted, Diagnostics: diagnostics}, nil
	}
	digest, err := ComputeProfileDigest(profile)
	if err != nil {
		return State{}, err
	}
	receipt := buildReceipt(profile, digest)
	return State{Present: true, Status: StatusConfigured, Receipt: &receipt}, nil
}

func readProfile(root string) (Profile, bool, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-READ: invalid Installation root: %w", err)
	}
	directory := filepath.Join(absoluteRoot, ".agx")
	directoryInfo, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		return Profile{}, false, nil
	}
	if err != nil {
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-READ: cannot inspect metadata directory: %w", err)
	}
	if err := metadatafile.RequireRealEntry(directory, directoryInfo, true, "metadata directory", "AGX-FLEET-PROFILE-INVALID"); err != nil {
		return Profile{}, false, err
	}
	path := filepath.Join(directory, fleetProfileFile)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return Profile{}, false, nil
	}
	if err != nil {
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-READ: cannot inspect Deployment Profile: %w", err)
	}
	if err := metadatafile.RequireRealEntry(path, info, false, "Deployment Profile", "AGX-FLEET-PROFILE-INVALID"); err != nil {
		return Profile{}, false, err
	}
	file, err := os.Open(path)
	if err != nil {
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-READ: cannot open Deployment Profile: %w", err)
	}
	openedInfo, statErr := file.Stat()
	if statErr != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		file.Close()
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-INVALID: Deployment Profile changed during read")
	}
	data, readErr := io.ReadAll(file)
	closeErr := file.Close()
	if readErr != nil {
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-READ: cannot read Deployment Profile: %w", readErr)
	}
	if closeErr != nil {
		return Profile{}, false, fmt.Errorf("AGX-FLEET-PROFILE-READ: cannot close Deployment Profile: %w", closeErr)
	}
	profile, err := ParseProfile(data)
	if err != nil {
		return Profile{}, false, err
	}
	return profile, true, nil
}

func writeProfile(root string, profile Profile) error {
	data, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	data = append(data, '\n')
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: invalid Installation root: %w", err)
	}
	directory := filepath.Join(absoluteRoot, ".agx")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: cannot inspect metadata directory: %w", err)
	}
	if err := metadatafile.RequireRealEntry(directory, directoryInfo, true, "metadata directory", "AGX-FLEET-PROFILE-WRITE"); err != nil {
		return err
	}
	target := filepath.Join(directory, fleetProfileFile)
	if targetInfo, targetErr := os.Lstat(target); targetErr == nil {
		if err := metadatafile.RequireRealEntry(target, targetInfo, false, "Deployment Profile", "AGX-FLEET-PROFILE-WRITE"); err != nil {
			return err
		}
	} else if !os.IsNotExist(targetErr) {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: cannot inspect Deployment Profile: %w", targetErr)
	}
	temporary, err := os.CreateTemp(directory, ".fleet-profile-*.tmp")
	if err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	if err := os.Rename(temporaryName, target); err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	return nil
}

package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"

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
// Publication is create-only (via a hard link, not a replacing rename),
// so two concurrent Apply calls at the same root can never have one
// silently overwrite the other: whichever call loses the race falls back
// to reading the winner's now-published Profile and applies the same
// no-op/drift decision it would have made had it seen that Profile first.
func Apply(root string, profile Profile) (Receipt, error) {
	diagnostics := ValidateProfile(profile)
	if len(diagnostics) > 0 {
		return Receipt{}, fmt.Errorf("AGX-FLEET-PROFILE-INVALID: profile has %d diagnostic(s), first: %s", len(diagnostics), diagnostics[0].Message)
	}
	digest, err := ComputeProfileDigest(profile)
	if err != nil {
		return Receipt{}, err
	}
	if receipt, resolved, err := resolveAgainstExisting(root, profile, digest); err != nil || resolved {
		return receipt, err
	}
	if err := publishProfile(root, profile); err != nil {
		if errors.Is(err, errProfileAlreadyExists) {
			receipt, resolved, resolveErr := resolveAgainstExisting(root, profile, digest)
			if resolveErr != nil {
				return Receipt{}, resolveErr
			}
			if resolved {
				return receipt, nil
			}
			return Receipt{}, fmt.Errorf("AGX-FLEET-PROFILE-WRITE: Deployment Profile was published concurrently but could not be read back")
		}
		return Receipt{}, err
	}
	return buildReceipt(profile, digest), nil
}

// resolveAgainstExisting reports (receipt, true, nil) when an already
// persisted Profile at root has the same content digest as profile
// (idempotent no-op), (Receipt{}, false, drift-error) when a different
// Profile is already persisted, and (Receipt{}, false, nil) when no
// Profile is persisted yet (Apply must still publish one).
func resolveAgainstExisting(root string, profile Profile, digest string) (Receipt, bool, error) {
	existing, present, err := readProfile(root)
	if err != nil {
		return Receipt{}, false, err
	}
	if !present {
		return Receipt{}, false, nil
	}
	existingDigest, digestErr := ComputeProfileDigest(existing)
	if digestErr != nil {
		return Receipt{}, false, digestErr
	}
	if existingDigest != digest {
		return Receipt{}, false, fmt.Errorf("AGX-FLEET-DEPLOYMENT-PROFILE-DRIFT: an existing Deployment Profile for a different configuration is already applied at this root; use a new deployment_id for a distinct deployment")
	}
	return buildReceipt(profile, digest), true, nil
}

// Status reads back the persisted Profile at root and reports whether it
// is absent, configured (present and internally valid), or drifted
// (present but no longer valid, e.g. after a hand-edit).
func Status(root string) (State, error) {
	data, present, err := readProfileBytes(root)
	if err != nil {
		return State{}, err
	}
	if !present {
		return State{Status: StatusAbsent}, nil
	}
	profile, parseErr := ParseProfile(data)
	if parseErr != nil {
		return State{Present: true, Status: StatusDrifted, Diagnostics: []domain.Diagnostic{{
			Code: DiagnosticParseFailed, Category: domain.DiagnosticCategoryPreflight, Severity: domain.SeverityError,
			Message: "Deployment Profile is present but could not be parsed: " + parseErr.Error(),
		}}}, nil
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

// readProfile reads and parses the persisted Deployment Profile. Apply
// uses this directly: an existing profile AGX cannot even parse must
// block Apply with a hard error rather than let it guess whether the
// caller's new Profile would be a safe no-op or a drift rebind.
func readProfile(root string) (Profile, bool, error) {
	data, present, err := readProfileBytes(root)
	if err != nil || !present {
		return Profile{}, present, err
	}
	profile, err := ParseProfile(data)
	if err != nil {
		return Profile{}, false, err
	}
	return profile, true, nil
}

// readProfileBytes performs only the symlink-safe I/O: it reports whether
// a Deployment Profile file exists at root and, if so, its raw bytes. It
// never interprets those bytes, so a present-but-unparseable file is
// reported present with no error, letting callers (Status) distinguish a
// genuine I/O failure from a corrupted/hand-edited file.
func readProfileBytes(root string) ([]byte, bool, error) {
	return metadatafile.ReadFile(root, ".agx", fleetProfileFile, "AGX-FLEET-PROFILE-INVALID")
}

// errProfileAlreadyExists signals that publishProfile lost a create-only
// race: another Apply call already published a Deployment Profile at this
// root between this call's existence check and its publish attempt.
var errProfileAlreadyExists = errors.New("fleet: deployment profile already exists")

// publishProfile persists profile at .agx/fleet-profile.json using
// create-only publication: the final file is linked into place with
// os.Link, never with a replacing os.Rename, so publishProfile can never
// silently overwrite a Deployment Profile a concurrent Apply call already
// published. It reports errProfileAlreadyExists (wrapped) instead.
//
// AGX's two supported platforms (Windows 11 x64 NTFS, Ubuntu 24.04 x64
// ext4) both support hard links for files within the same directory;
func publishProfile(root string, profile Profile) error {
	data, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return fmt.Errorf("AGX-FLEET-PROFILE-WRITE: %w", err)
	}
	data = append(data, '\n')
	if err := metadatafile.WriteFileAtomic(root, ".agx", fleetProfileFile, data, true, "AGX-FLEET-PROFILE-WRITE"); err != nil {
		if errors.Is(err, fs.ErrExist) || errors.Is(err, metadatafile.ErrTargetChanged) {
			return errProfileAlreadyExists
		}
		return err
	}
	return nil
}

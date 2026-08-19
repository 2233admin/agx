package domain

import "fmt"

type InstallationID string

type Phase string

const (
	PhasePlanned              Phase = "planned"
	PhaseBlockedPreflight     Phase = "blocked_preflight"
	PhaseBlockedOutcome       Phase = "blocked_outcome"
	PhaseBlockedFreshness     Phase = "blocked_freshness"
	PhaseApplying             Phase = "applying"
	PhaseConfigured           Phase = "configured"
	PhaseAwaitingVerification Phase = "awaiting_verification"
	PhaseVerified             Phase = "verified"
	PhaseNeedsManualCleanup   Phase = "needs_manual_cleanup"
)

type ReadbackSource string

const (
	ReadbackSourceGitHub  ReadbackSource = "github"
	ReadbackSourceMultica ReadbackSource = "multica"
)

type Readback struct {
	Source         ReadbackSource `json:"source"`
	InstallationID InstallationID `json:"installation_id"`
	EvidenceID     string         `json:"evidence_id"`
}

type Verification struct {
	GitHub  Readback `json:"github"`
	Multica Readback `json:"multica"`
}

type Receipt struct {
	InstallationID InstallationID `json:"installation_id"`
	Phase          Phase          `json:"phase"`
	Verification   Verification   `json:"verification"`
}

// NewVerifiedReceipt constructs the legacy dual-readback receipt. Deprecated: new verification uses EvaluateEvidence.
func NewVerifiedReceipt(installationID InstallationID, verification Verification) (Receipt, error) {
	if installationID == "" {
		return Receipt{}, fmt.Errorf("installation ID is required")
	}
	if verification.GitHub.Source != ReadbackSourceGitHub || verification.Multica.Source != ReadbackSourceMultica {
		return Receipt{}, fmt.Errorf("verification requires GitHub and Multica readbacks")
	}
	if verification.GitHub.InstallationID != installationID || verification.Multica.InstallationID != installationID {
		return Receipt{}, fmt.Errorf("verification readbacks must match installation ID %q", installationID)
	}
	if verification.GitHub.EvidenceID == "" || verification.Multica.EvidenceID == "" {
		return Receipt{}, fmt.Errorf("verification evidence IDs are required")
	}
	return Receipt{InstallationID: installationID, Phase: PhaseVerified, Verification: verification}, nil
}

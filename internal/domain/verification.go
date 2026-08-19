package domain

type InstallationID string

type Phase string

const (
	PhasePlanned              Phase = "planned"
	PhaseBlockedPreflight     Phase = "blocked_preflight"
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

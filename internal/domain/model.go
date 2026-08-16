package domain

type BundleID string
type DesiredHash string
type StepID string

type Ownership string

const (
	OwnershipUser Ownership = "user"
	OwnershipAGX  Ownership = "agx"
)

type IdempotencyStrategy string

const (
	IdempotencySafe IdempotencyStrategy = "safe"
	IdempotencyKey  IdempotencyStrategy = "keyed"
)

type RiskLevel string

const (
	RiskReversible  RiskLevel = "reversible"
	RiskDestructive RiskLevel = "destructive"
)

type CompensationClass string

const (
	CompensationNone     CompensationClass = "none"
	CompensationRollback CompensationClass = "rollback"
	CompensationManual   CompensationClass = "manual"
)

type StepKind string

const (
	StepKindConfigure StepKind = "configure"
)

type DesiredState struct {
	InstallationID InstallationID      `json:"installation_id"`
	BundleID       BundleID            `json:"bundle_id"`
	DesiredHash    DesiredHash         `json:"desired_hash"`
	Ownership      Ownership           `json:"ownership"`
	Idempotency    IdempotencyStrategy `json:"idempotency"`
	Risk           RiskLevel           `json:"risk"`
}

type ObservedState struct {
	InstallationID InstallationID `json:"installation_id"`
	Phase          Phase          `json:"phase"`
	Verification   Verification   `json:"verification"`
}

type Plan struct {
	InstallationID InstallationID `json:"installation_id"`
	DesiredHash    DesiredHash    `json:"desired_hash"`
	Steps          []Step         `json:"steps"`
}

type Step struct {
	ID           StepID            `json:"id"`
	Kind         StepKind          `json:"kind"`
	Risk         RiskLevel         `json:"risk"`
	Compensation CompensationClass `json:"compensation"`
}

type StepResult struct {
	StepID StepID `json:"step_id"`
	Phase  Phase  `json:"phase"`
}

type DiagnosticCode string
type DiagnosticCategory string
type Severity string

const (
	DiagnosticCategoryPreflight DiagnosticCategory = "preflight"
	SeverityWarning             Severity           = "warning"
	SeverityError               Severity           = "error"
)

type Diagnostic struct {
	Code     DiagnosticCode     `json:"code"`
	Category DiagnosticCategory `json:"category"`
	Severity Severity           `json:"severity"`
	Message  string             `json:"message"`
}

type InstallationContract struct {
	Desired     DesiredState  `json:"desired"`
	Observed    ObservedState `json:"observed"`
	Plan        Plan          `json:"plan"`
	StepResults []StepResult  `json:"step_results"`
	Diagnostics []Diagnostic  `json:"diagnostics"`
	Receipt     Receipt       `json:"receipt"`
}

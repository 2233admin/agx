package domain

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// ObservationSchemaVersion is the only Observation schema Evaluate currently
// accepts. Adapters must stamp every Observation with this value; a mismatch
// is treated as an unknown schema and rejected with a diagnosable error
// rather than silently ignored.
const ObservationSchemaVersion = "agx.observation/v1"

// ObservationSource identifies which Source Adapter produced an Observation.
type ObservationSource string

const (
	ObservationSourceGitHub  ObservationSource = "github"
	ObservationSourceMultica ObservationSource = "multica"
)

// ObservationKind identifies the external fact an Observation records.
// Kinds are namespaced by source (`github.` / `multica.`) so Evaluate can
// reject an Observation whose Source does not match its Kind's namespace.
type ObservationKind string

const (
	ObservationKindGitHubProject       ObservationKind = "github.project"
	ObservationKindGitHubContractIssue ObservationKind = "github.contract_issue"
	ObservationKindGitHubFirstWrite    ObservationKind = "github.first_write"
	ObservationKindGitHubDelivery      ObservationKind = "github.delivery"
	ObservationKindGitHubChecks        ObservationKind = "github.checks"

	ObservationKindMulticaWorkspace ObservationKind = "multica.workspace"
	ObservationKindMulticaRuntime   ObservationKind = "multica.runtime"
	ObservationKindMulticaAgent     ObservationKind = "multica.agent"
	ObservationKindMulticaTaskRun   ObservationKind = "multica.task_run"
)

// ObservationStatus records what a Source Adapter concluded about one
// Observation. Only ObservationStatusSatisfied counts toward a requirement;
// every other status is a real, adapter-classified outcome (not an
// Evaluator guess) that Evaluate reports as a precise diagnostic instead of
// treating the requirement as merely absent.
type ObservationStatus string

const (
	ObservationStatusSatisfied ObservationStatus = "satisfied"
	ObservationStatusFailed    ObservationStatus = "failed"
	ObservationStatusAmbiguous ObservationStatus = "ambiguous"
	ObservationStatusDrifted   ObservationStatus = "drifted"
	ObservationStatusExpired   ObservationStatus = "expired"
)

func validObservationStatus(status ObservationStatus) bool {
	switch status {
	case ObservationStatusSatisfied, ObservationStatusFailed, ObservationStatusAmbiguous,
		ObservationStatusDrifted, ObservationStatusExpired:
		return true
	default:
		return false
	}
}

// Observation is one type-safe, credential-free external fact produced by a
// Source Adapter. Evaluate never talks to GitHub or Multica itself; it only
// reasons over Observation values a caller already collected.
type Observation struct {
	Source         ObservationSource `json:"source"`
	Kind           ObservationKind   `json:"kind"`
	InstallationID InstallationID    `json:"installation_id"`
	ResourceID     string            `json:"resource_id"`
	EvidenceID     string            `json:"evidence_id"`
	Status         ObservationStatus `json:"status"`
	SchemaVersion  string            `json:"schema_version"`
	ObservedAt     string            `json:"observed_at"`
}

// EvidenceProfileID names a versioned, explicitly selected combination of
// required Observation kinds. Evaluate never infers a profile from
// installed tooling or discovered resources; callers must pass one.
type EvidenceProfileID string

const (
	// EvidenceProfileGitHubDeliveryV1 is the GitHub-only baseline: a
	// deployment Project, a contract Issue, an Agent first write, a
	// delivery pull request or structured result, and passing CI or an
	// independent verifier.
	EvidenceProfileGitHubDeliveryV1 EvidenceProfileID = "github-delivery/v1"
	// EvidenceProfileMulticaExecutionV1 requires every github-delivery/v1
	// Observation plus a matching Multica Workspace, Runtime, Agent, and
	// Task/Run readback for the same Installation ID.
	EvidenceProfileMulticaExecutionV1 EvidenceProfileID = "multica-execution/v1"
)

// EvaluatorVersion identifies the rule set that produced an EvidenceReceipt.
// It is recorded on every receipt so an older receipt is never silently
// re-graded under newer rules.
type EvaluatorVersion string

// CurrentEvaluatorVersion is the EvaluatorVersion Evaluate currently
// implements.
const CurrentEvaluatorVersion EvaluatorVersion = "evidence-evaluator/v1"

const (
	DiagnosticCategoryEvidence DiagnosticCategory = "evidence"

	DiagnosticCodeEvidenceInstallationMismatch DiagnosticCode = "AGX-EVIDENCE-INSTALLATION-MISMATCH"
	DiagnosticCodeEvidenceEmpty                DiagnosticCode = "AGX-EVIDENCE-EMPTY"
	DiagnosticCodeEvidenceSourceMismatch       DiagnosticCode = "AGX-EVIDENCE-SOURCE-MISMATCH"
	DiagnosticCodeEvidenceUnknownSchema        DiagnosticCode = "AGX-EVIDENCE-UNKNOWN-SCHEMA"
	DiagnosticCodeEvidenceMalformedTimestamp   DiagnosticCode = "AGX-EVIDENCE-TIMESTAMP"
	DiagnosticCodeEvidenceUnknownStatus        DiagnosticCode = "AGX-EVIDENCE-UNKNOWN-STATUS"
	DiagnosticCodeEvidenceAmbiguous            DiagnosticCode = "AGX-EVIDENCE-AMBIGUOUS"
	DiagnosticCodeEvidenceNotSatisfied         DiagnosticCode = "AGX-EVIDENCE-NOT-SATISFIED"
)

// requirement pairs an Observation kind the selected EvidenceProfile
// demands with the precise next step to show when it is missing.
type requirement struct {
	Kind     ObservationKind
	NextStep string
}

var githubDeliveryV1Requirements = []requirement{
	{ObservationKindGitHubProject, "create or link the deployment GitHub Project"},
	{ObservationKindGitHubContractIssue, "create the Bootstrap Verification contract Issue"},
	{ObservationKindGitHubFirstWrite, "run one first-use Agent prompt to record the first write"},
	{ObservationKindGitHubDelivery, "open the delivery pull request or record its structured result"},
	{ObservationKindGitHubChecks, "wait for CI or an independent verifier to pass on the delivery"},
}

var multicaExecutionV1Requirements = append(append([]requirement{}, githubDeliveryV1Requirements...),
	requirement{ObservationKindMulticaWorkspace, "connect or create the Multica Workspace for this installation"},
	requirement{ObservationKindMulticaRuntime, "bring the Multica Runtime online for this installation"},
	requirement{ObservationKindMulticaAgent, "register the Multica Agent for this installation"},
	requirement{ObservationKindMulticaTaskRun, "complete the Multica Task/Run for this installation"},
)

var evidenceProfiles = map[EvidenceProfileID][]requirement{
	EvidenceProfileGitHubDeliveryV1:   githubDeliveryV1Requirements,
	EvidenceProfileMulticaExecutionV1: multicaExecutionV1Requirements,
}

// KnownEvidenceProfile reports whether id names a registered, versioned
// EvidenceProfile. Callers should use this before Evaluate to fail closed
// on a typo'd or not-yet-released profile rather than surface a generic
// error deep inside evaluation.
func KnownEvidenceProfile(id EvidenceProfileID) bool {
	_, ok := evidenceProfiles[id]
	return ok
}

// MissingRequirement names one Observation kind an EvidenceProfile requires
// that Evaluate did not find satisfied, and the precise next step to
// resolve it.
type MissingRequirement struct {
	Kind     ObservationKind `json:"kind"`
	NextStep string          `json:"next_step"`
}

// EvidenceReceipt is the sole output of Evaluate: a phase, the requirements
// that were satisfied and missing, stable diagnostics, and enough metadata
// (profile, evaluator version) to make later re-evaluation explicit rather
// than inferred. It contains no credentials, business content, or local
// paths because Observation cannot carry them.
type EvidenceReceipt struct {
	InstallationID   InstallationID       `json:"installation_id"`
	ProfileID        EvidenceProfileID    `json:"evidence_profile"`
	EvaluatorVersion EvaluatorVersion     `json:"evaluator_version"`
	Phase            Phase                `json:"phase"`
	Satisfied        []ObservationKind    `json:"satisfied,omitempty"`
	Missing          []MissingRequirement `json:"missing,omitempty"`
	Diagnostics      []Diagnostic         `json:"diagnostics,omitempty"`
}

// Evaluate is the single domain Evidence Evaluator. It takes an
// Installation ID, an explicitly selected EvidenceProfile, an evaluator
// version, and a set of type-safe Observations, and deterministically
// returns the resulting phase, satisfied/missing requirements, and stable
// diagnostics. It never mutates state, never calls an Adapter, and never
// infers a profile: GitHub, Multica, Runtime, and Bridge Adapters only ever
// produce Observation values for it to reason over.
//
// Evaluate ignores any Observation whose Kind the selected profile does not
// require, so discovering Multica never changes a github-delivery/v1
// result, and a Multica-only deployment can still satisfy that profile
// without Multica observations at all.
func Evaluate(
	installationID InstallationID,
	profileID EvidenceProfileID,
	evaluatorVersion EvaluatorVersion,
	observations []Observation,
) (EvidenceReceipt, error) {
	if installationID == "" {
		return EvidenceReceipt{}, fmt.Errorf("installation ID is required")
	}
	if evaluatorVersion == "" {
		return EvidenceReceipt{}, fmt.Errorf("evaluator version is required")
	}
	requirements, ok := evidenceProfiles[profileID]
	if !ok {
		return EvidenceReceipt{}, fmt.Errorf("unknown evidence profile %q", profileID)
	}

	required := make(map[ObservationKind]bool, len(requirements))
	for _, req := range requirements {
		required[req.Kind] = true
	}

	// Evaluate over a copy sorted into a fixed order so that shuffled or
	// duplicated input never changes the result.
	sorted := make([]Observation, 0, len(observations))
	for _, obs := range observations {
		if required[obs.Kind] {
			sorted = append(sorted, obs)
		}
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Kind != sorted[j].Kind {
			return sorted[i].Kind < sorted[j].Kind
		}
		if sorted[i].EvidenceID != sorted[j].EvidenceID {
			return sorted[i].EvidenceID < sorted[j].EvidenceID
		}
		return sorted[i].ResourceID < sorted[j].ResourceID
	})

	byKind := make(map[ObservationKind]Observation, len(requirements))
	conflicted := make(map[ObservationKind]bool, len(requirements))
	diagnosticSet := make(map[Diagnostic]bool)
	var addDiagnostic = func(d Diagnostic) { diagnosticSet[d] = true }

	for _, obs := range sorted {
		if diag, valid := validateObservation(installationID, obs); !valid {
			addDiagnostic(diag)
			continue
		}
		existing, seen := byKind[obs.Kind]
		if !seen {
			byKind[obs.Kind] = obs
			continue
		}
		if existing.EvidenceID == obs.EvidenceID && existing.ResourceID == obs.ResourceID && existing.Status == obs.Status {
			continue // exact duplicate: idempotent, not a conflict
		}
		conflicted[obs.Kind] = true
		addDiagnostic(Diagnostic{
			Code:     DiagnosticCodeEvidenceAmbiguous,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s has more than one conflicting observation for installation %q", obs.Kind, installationID),
		})
	}

	var satisfied []ObservationKind
	var missing []MissingRequirement
	for _, req := range requirements {
		obs, present := byKind[req.Kind]
		switch {
		case conflicted[req.Kind]:
			missing = append(missing, MissingRequirement{Kind: req.Kind, NextStep: req.NextStep})
		case !present:
			missing = append(missing, MissingRequirement{Kind: req.Kind, NextStep: req.NextStep})
		case obs.Status != ObservationStatusSatisfied:
			addDiagnostic(Diagnostic{
				Code:     DiagnosticCodeEvidenceNotSatisfied,
				Category: DiagnosticCategoryEvidence,
				Severity: SeverityError,
				Message:  fmt.Sprintf("%s observation status is %q, not satisfied", req.Kind, obs.Status),
			})
			missing = append(missing, MissingRequirement{Kind: req.Kind, NextStep: req.NextStep})
		default:
			satisfied = append(satisfied, req.Kind)
		}
	}

	diagnostics := make([]Diagnostic, 0, len(diagnosticSet))
	for d := range diagnosticSet {
		diagnostics = append(diagnostics, d)
	}
	sort.Slice(diagnostics, func(i, j int) bool {
		if diagnostics[i].Code != diagnostics[j].Code {
			return diagnostics[i].Code < diagnostics[j].Code
		}
		return diagnostics[i].Message < diagnostics[j].Message
	})

	phase := PhaseAwaitingVerification
	if len(missing) == 0 {
		phase = PhaseVerified
	}

	return EvidenceReceipt{
		InstallationID:   installationID,
		ProfileID:        profileID,
		EvaluatorVersion: evaluatorVersion,
		Phase:            phase,
		Satisfied:        satisfied,
		Missing:          missing,
		Diagnostics:      diagnostics,
	}, nil
}

// validateObservation applies structural checks Evaluate can decide without
// any external call: matching Installation ID, non-empty evidence, a
// Source that matches the Kind's namespace, a known schema version, a
// well-formed timestamp, and a known Status. It returns the Observation
// unmodified alongside a diagnostic when invalid, so a rejected Observation
// still yields a stable, explainable reason instead of a bare omission.
func validateObservation(installationID InstallationID, obs Observation) (Diagnostic, bool) {
	if obs.InstallationID != installationID {
		return Diagnostic{
			Code:     DiagnosticCodeEvidenceInstallationMismatch,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s observation installation %q does not match %q", obs.Kind, obs.InstallationID, installationID),
		}, false
	}
	if strings.TrimSpace(obs.EvidenceID) == "" {
		return Diagnostic{
			Code:     DiagnosticCodeEvidenceEmpty,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s observation has an empty evidence ID", obs.Kind),
		}, false
	}
	if !sourceMatchesKind(obs.Source, obs.Kind) {
		return Diagnostic{
			Code:     DiagnosticCodeEvidenceSourceMismatch,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s observation source %q does not match its kind", obs.Kind, obs.Source),
		}, false
	}
	if obs.SchemaVersion != ObservationSchemaVersion {
		return Diagnostic{
			Code:     DiagnosticCodeEvidenceUnknownSchema,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s observation schema version %q is not %q", obs.Kind, obs.SchemaVersion, ObservationSchemaVersion),
		}, false
	}
	if _, err := time.Parse(time.RFC3339, obs.ObservedAt); err != nil {
		return Diagnostic{
			Code:     DiagnosticCodeEvidenceMalformedTimestamp,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s observation has a malformed observed_at timestamp", obs.Kind),
		}, false
	}
	if !validObservationStatus(obs.Status) {
		return Diagnostic{
			Code:     DiagnosticCodeEvidenceUnknownStatus,
			Category: DiagnosticCategoryEvidence,
			Severity: SeverityError,
			Message:  fmt.Sprintf("%s observation status %q is unknown", obs.Kind, obs.Status),
		}, false
	}
	return Diagnostic{}, true
}

func sourceMatchesKind(source ObservationSource, kind ObservationKind) bool {
	switch {
	case strings.HasPrefix(string(kind), "github."):
		return source == ObservationSourceGitHub
	case strings.HasPrefix(string(kind), "multica."):
		return source == ObservationSourceMultica
	default:
		return false
	}
}

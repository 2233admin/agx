package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	EvidenceInputSchemaV1       = "agx/evidence-input/v1"
	EvidenceObservationSchemaV1 = "agx/evidence-observation/v1"
	EvidenceReceiptSchemaV1     = "agx/evidence-receipt/v1"
	EvidenceEvaluatorV1         = "agx/evidence-evaluator/v1"
	DeploymentBindingSchemaV1   = "agx/deployment-binding/v1"
	EvidenceSubjectSchemaV1     = "agx/evidence-subject/v1"
	MaxEvidenceInputBytes       = 1 << 20
	MaxEvidenceObservations     = 128
)

const evidenceMaxAge = 15 * time.Minute

type EvidenceProfileID string

const (
	EvidenceProfileGitHubDeliveryV1   EvidenceProfileID = "github-delivery/v1"
	EvidenceProfileMulticaExecutionV1 EvidenceProfileID = "multica-execution/v1"
)

func ParseEvidenceProfile(value string) (EvidenceProfileID, error) {
	profile := EvidenceProfileID(strings.ToLower(strings.TrimSpace(value)))
	switch profile {
	case EvidenceProfileGitHubDeliveryV1, EvidenceProfileMulticaExecutionV1:
		return profile, nil
	default:
		return "", fmt.Errorf("AGX-EVIDENCE-PROFILE-UNSUPPORTED")
	}
}

func ValidateEvidenceProfileSelection(profile EvidenceProfileID, multicaWorkspaceID, multicaRuntimeID, multicaAgentID string) error {
	parsed, err := ParseEvidenceProfile(string(profile))
	if err != nil {
		return err
	}
	if parsed != EvidenceProfileMulticaExecutionV1 {
		return nil
	}
	for _, value := range []string{multicaWorkspaceID, multicaRuntimeID, multicaAgentID} {
		if !uuidPattern.MatchString(strings.ToLower(strings.TrimSpace(value))) {
			return fmt.Errorf("AGX-EVIDENCE-SUBJECT-INCOMPLETE")
		}
	}
	return nil
}

type EvidenceSource string

const (
	EvidenceSourceGitHub  EvidenceSource = "github"
	EvidenceSourceMultica EvidenceSource = "multica"
)

type EvidenceKind string

const (
	EvidenceGitHubControlRepository   EvidenceKind = "github.control-repository.readback/v1"
	EvidenceGitHubContractsRepository EvidenceKind = "github.contracts-repository.readback/v1"
	EvidenceGitHubProject             EvidenceKind = "github.project.readback/v1"
	EvidenceGitHubProjectItem         EvidenceKind = "github.project-item.readback/v1"
	EvidenceGitHubContractIssue       EvidenceKind = "github.contract-issue.readback/v1"
	EvidenceGitHubAgentFirstWrite     EvidenceKind = "github.agent-first-write.readback/v1"
	EvidenceGitHubCurrentWork         EvidenceKind = "github.current-work.readback/v1"
	EvidenceGitHubDeliveryPROpen      EvidenceKind = "github.delivery-pr.open/v1"
	EvidenceGitHubDeliveryResult      EvidenceKind = "github.delivery-result.readback/v1"
	EvidenceGitHubChecksPassed        EvidenceKind = "github.checks.passed/v1"
	EvidenceGitHubIndependentVerifier EvidenceKind = "github.independent-verifier.passed/v1"
	EvidenceMulticaWorkspace          EvidenceKind = "multica.workspace.readback/v1"
	EvidenceMulticaRuntimeOnline      EvidenceKind = "multica.runtime.online/v1"
	EvidenceMulticaAgent              EvidenceKind = "multica.agent.readback/v1"
	EvidenceMulticaTaskCompleted      EvidenceKind = "multica.task.completed/v1"
	EvidenceMulticaRunCompleted       EvidenceKind = "multica.run.completed/v1"
)

type ObservationOutcome string

const (
	ObservationMatched   ObservationOutcome = "matched"
	ObservationAbsent    ObservationOutcome = "absent"
	ObservationAmbiguous ObservationOutcome = "ambiguous"
	ObservationDrifted   ObservationOutcome = "drifted"
	ObservationRejected  ObservationOutcome = "rejected"
)

type EvidenceResourceType string

const (
	ResourceRepository  EvidenceResourceType = "repository"
	ResourceProject     EvidenceResourceType = "project"
	ResourceProjectItem EvidenceResourceType = "project_item"
	ResourceIssue       EvidenceResourceType = "issue"
	ResourceCommit      EvidenceResourceType = "commit"
	ResourcePullRequest EvidenceResourceType = "pull_request"
	ResourceCheck       EvidenceResourceType = "check"
	ResourceWorkspace   EvidenceResourceType = "workspace"
	ResourceRuntime     EvidenceResourceType = "runtime"
	ResourceAgent       EvidenceResourceType = "agent"
	ResourceTask        EvidenceResourceType = "task"
	ResourceRun         EvidenceResourceType = "run"
)

type EvidenceRef struct {
	ResourceType   EvidenceResourceType `json:"resource_type"`
	IdentitySHA256 string               `json:"identity_sha256,omitempty"`
	UUID           string               `json:"uuid,omitempty"`
	Number         uint64               `json:"number,omitempty"`
	Revision       string               `json:"revision,omitempty"`
}

type EvidenceObservation struct {
	SchemaVersion    string             `json:"schema_version"`
	EvaluatorVersion string             `json:"evaluator_version"`
	Source           EvidenceSource     `json:"source"`
	Kind             EvidenceKind       `json:"kind"`
	InstallationID   InstallationID     `json:"installation_id"`
	DeploymentDigest string             `json:"deployment_digest"`
	SubjectDigest    string             `json:"subject_digest"`
	Ref              EvidenceRef        `json:"ref"`
	Fingerprint      string             `json:"fingerprint"`
	Outcome          ObservationOutcome `json:"outcome"`
	ObservedAt       time.Time          `json:"observed_at"`
}

type ObservationBatch struct {
	Observations []EvidenceObservation `json:"observations"`
	Diagnostics  []Diagnostic          `json:"diagnostics,omitempty"`
}

type EvaluationInput struct {
	SchemaVersion    string                `json:"schema_version"`
	EvaluatorVersion string                `json:"evaluator_version"`
	InstallationID   InstallationID        `json:"installation_id"`
	DeploymentDigest string                `json:"deployment_digest"`
	SubjectDigest    string                `json:"subject_digest"`
	Profile          EvidenceProfileID     `json:"profile"`
	EvaluatedAt      time.Time             `json:"evaluated_at"`
	Observations     []EvidenceObservation `json:"observations"`
	Diagnostics      []Diagnostic          `json:"diagnostics,omitempty"`
}

type RequirementResult struct {
	ID   string `json:"id"`
	Code string `json:"code"`
}

type ObservationRef struct {
	Source      EvidenceSource `json:"source"`
	Kind        EvidenceKind   `json:"kind"`
	Fingerprint string         `json:"fingerprint"`
	Ref         EvidenceRef    `json:"ref"`
	ObservedAt  time.Time      `json:"observed_at"`
}

type EvidenceReceipt struct {
	SchemaVersion    string              `json:"schema_version"`
	EvaluatorVersion string              `json:"evaluator_version"`
	InstallationID   InstallationID      `json:"installation_id"`
	DeploymentDigest string              `json:"deployment_digest"`
	SubjectDigest    string              `json:"subject_digest"`
	Profile          EvidenceProfileID   `json:"profile"`
	Phase            Phase               `json:"phase"`
	EvaluatedAt      time.Time           `json:"evaluated_at"`
	Satisfied        []RequirementResult `json:"satisfied"`
	Missing          []RequirementResult `json:"missing"`
	Diagnostics      []Diagnostic        `json:"diagnostics"`
	NextSteps        []string            `json:"next_steps"`
	Evidence         []ObservationRef    `json:"evidence"`
}

type RepositoryBindingV1 struct {
	IdentitySHA256 string `json:"identity_sha256"`
	TemplateSHA256 string `json:"template_sha256"`
}

type DeploymentBindingV1 struct {
	SchemaVersion          string              `json:"schema_version"`
	InstallationID         InstallationID      `json:"installation_id"`
	BundleSHA256           string              `json:"bundle_sha256"`
	TemplateVersion        string              `json:"template_version"`
	TemplateSHA256         string              `json:"template_sha256"`
	ProviderProfile        string              `json:"provider_profile"`
	SelectedProviders      []string            `json:"selected_providers"`
	ControlRepository      RepositoryBindingV1 `json:"control_repository"`
	ContractsRepository    RepositoryBindingV1 `json:"contracts_repository"`
	ProjectIdentitySHA256  string              `json:"project_identity_sha256"`
	FirstUseContractSHA256 string              `json:"first_use_contract_sha256"`
}

type GitHubSubjectSelectorsV1 struct {
	ControlRepositorySHA256   string `json:"control_repository_sha256"`
	ContractsRepositorySHA256 string `json:"contracts_repository_sha256"`
	ProjectSelectorSHA256     string `json:"project_selector_sha256"`
	IssueSelectorSHA256       string `json:"issue_selector_sha256"`
	PullRequestSelectorSHA256 string `json:"pull_request_selector_sha256"`
	BranchSelectorSHA256      string `json:"branch_selector_sha256"`
	WorkflowSHA256            string `json:"workflow_sha256"`
	CheckSelectorSHA256       string `json:"check_selector_sha256"`
}

type MulticaSubjectSelectorsV1 struct {
	WorkspaceUUID         string `json:"workspace_uuid"`
	RuntimeUUID           string `json:"runtime_uuid"`
	AgentUUID             string `json:"agent_uuid"`
	ExecutionMarkerSHA256 string `json:"execution_marker_sha256"`
}

type SubjectBindingV1 struct {
	SchemaVersion            string                     `json:"schema_version"`
	Profile                  EvidenceProfileID          `json:"profile"`
	DeploymentDigest         string                     `json:"deployment_digest"`
	InstallationMarkerSHA256 string                     `json:"installation_marker_sha256"`
	GitHubSelectors          GitHubSubjectSelectorsV1   `json:"github_selectors"`
	MulticaSelectors         *MulticaSubjectSelectorsV1 `json:"multica_selectors,omitempty"`
}

type evidenceRequirement struct {
	id    string
	code  string
	next  string
	kinds []EvidenceKind
}

var githubRequirements = []evidenceRequirement{
	{"github.control-repository", "AGX-EVIDENCE-GITHUB-CONTROL-REPOSITORY-MISSING", "read back the control repository", []EvidenceKind{EvidenceGitHubControlRepository}},
	{"github.contracts-repository", "AGX-EVIDENCE-GITHUB-CONTRACTS-REPOSITORY-MISSING", "read back the contracts repository", []EvidenceKind{EvidenceGitHubContractsRepository}},
	{"github.project", "AGX-EVIDENCE-GITHUB-PROJECT-MISSING", "read back the deployment Project", []EvidenceKind{EvidenceGitHubProject}},
	{"github.project-item", "AGX-EVIDENCE-GITHUB-PROJECT-ITEM-MISSING", "read back the Bootstrap Verification Project item", []EvidenceKind{EvidenceGitHubProjectItem}},
	{"github.contract-issue", "AGX-EVIDENCE-GITHUB-CONTRACT-ISSUE-MISSING", "read back the Bootstrap Verification Issue", []EvidenceKind{EvidenceGitHubContractIssue}},
	{"github.first-write", "AGX-EVIDENCE-GITHUB-FIRST-WRITE-MISSING", "read back the agent first write or current-work pointer", []EvidenceKind{EvidenceGitHubAgentFirstWrite, EvidenceGitHubCurrentWork}},
	{"github.delivery", "AGX-EVIDENCE-GITHUB-DELIVERY-RESULT-MISSING", "read back an open delivery PR or delivery result", []EvidenceKind{EvidenceGitHubDeliveryPROpen, EvidenceGitHubDeliveryResult}},
	{"github.verifier", "AGX-EVIDENCE-GITHUB-VERIFIER-MISSING", "read back all required checks or an independent verifier", []EvidenceKind{EvidenceGitHubChecksPassed, EvidenceGitHubIndependentVerifier}},
}

var multicaRequirements = []evidenceRequirement{
	{"multica.workspace", "AGX-EVIDENCE-MULTICA-WORKSPACE-MISSING", "read back the selected Multica Workspace", []EvidenceKind{EvidenceMulticaWorkspace}},
	{"multica.runtime", "AGX-EVIDENCE-MULTICA-RUNTIME-MISSING", "read back the selected Multica Runtime as online", []EvidenceKind{EvidenceMulticaRuntimeOnline}},
	{"multica.agent", "AGX-EVIDENCE-MULTICA-AGENT-MISSING", "read back the selected Multica Agent", []EvidenceKind{EvidenceMulticaAgent}},
	{"multica.execution", "AGX-EVIDENCE-MULTICA-EXECUTION-MISSING", "read back a completed Multica Task or Run", []EvidenceKind{EvidenceMulticaTaskCompleted, EvidenceMulticaRunCompleted}},
}

var (
	hex64Pattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hex40Pattern   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	installPattern = regexp.MustCompile(`^install-[0-9a-f]{16}$`)
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

func DecodeEvaluationInput(data []byte) (EvaluationInput, error) {
	if len(data) > MaxEvidenceInputBytes {
		return EvaluationInput{}, fmt.Errorf("AGX-EVIDENCE-INPUT-TOO-LARGE")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input EvaluationInput
	if err := decoder.Decode(&input); err != nil {
		return EvaluationInput{}, fmt.Errorf("AGX-EVIDENCE-INPUT-INVALID")
	}
	if len(bytes.TrimSpace(data[decoder.InputOffset():])) != 0 {
		return EvaluationInput{}, fmt.Errorf("AGX-EVIDENCE-INPUT-TRAILING-DATA")
	}
	if len(input.Observations) > MaxEvidenceObservations {
		return EvaluationInput{}, fmt.Errorf("AGX-EVIDENCE-OBSERVATION-LIMIT")
	}
	return input, nil
}

func EvaluateEvidence(input EvaluationInput) EvidenceReceipt {
	receipt := EvidenceReceipt{
		SchemaVersion: EvidenceReceiptSchemaV1, EvaluatorVersion: input.EvaluatorVersion,
		InstallationID: input.InstallationID, DeploymentDigest: input.DeploymentDigest,
		SubjectDigest: input.SubjectDigest, Profile: input.Profile, Phase: PhaseBlockedPreflight,
		EvaluatedAt: input.EvaluatedAt, Satisfied: []RequirementResult{}, Missing: []RequirementResult{},
		Diagnostics: []Diagnostic{}, NextSteps: []string{}, Evidence: []ObservationRef{},
	}
	requirements, profileOK := profileRequirements(input.Profile)
	preflight := append(validateEvaluationEnvelope(input, profileOK), input.Diagnostics...)
	preflight = dedupeDiagnostics(preflight)
	if len(preflight) > 0 {
		receipt.Diagnostics = preflight
		appendMissing(&receipt, requirements)
		return receipt
	}

	observations := append([]EvidenceObservation(nil), input.Observations...)
	sort.Slice(observations, func(i, j int) bool { return observationSortKey(observations[i]) < observationSortKey(observations[j]) })
	validByKind := make(map[EvidenceKind][]EvidenceObservation)
	identity := make(map[string]EvidenceObservation)
	ambiguousIdentity := make(map[string]bool)
	for _, observation := range observations {
		if diagnostics := validateObservationEnvelope(observation); len(diagnostics) > 0 {
			receipt.Phase = PhaseBlockedPreflight
			receipt.Diagnostics = append(receipt.Diagnostics, diagnostics...)
			continue
		}
		if !kindRelevant(input.Profile, observation.Kind) {
			continue
		}
		if observation.Source != sourceForKind(observation.Kind) {
			addDiagnostic(&receipt, "AGX-EVIDENCE-SOURCE-MISMATCH", "evidence source does not match its kind")
			continue
		}
		if observation.InstallationID != input.InstallationID {
			addDiagnostic(&receipt, "AGX-EVIDENCE-INSTALLATION-MISMATCH", "evidence belongs to another installation")
			continue
		}
		if observation.DeploymentDigest != input.DeploymentDigest {
			addDiagnostic(&receipt, "AGX-EVIDENCE-DEPLOYMENT-MISMATCH", "evidence belongs to another deployment")
			continue
		}
		if observation.SubjectDigest != input.SubjectDigest {
			addDiagnostic(&receipt, "AGX-EVIDENCE-SUBJECT-MISMATCH", "evidence belongs to another subject")
			continue
		}
		if observation.ObservedAt.After(input.EvaluatedAt) {
			addDiagnostic(&receipt, "AGX-EVIDENCE-OBSERVATION-FUTURE", "evidence observation is in the future")
			continue
		}
		if !input.EvaluatedAt.Before(observation.ObservedAt.Add(evidenceMaxAge)) {
			addDiagnostic(&receipt, "AGX-EVIDENCE-OBSERVATION-EXPIRED", "evidence observation is stale")
			continue
		}
		if observation.Outcome != ObservationMatched {
			addDiagnostic(&receipt, outcomeDiagnostic(observation.Outcome), "evidence observation did not match")
			continue
		}
		key := observationIdentityKey(observation)
		if previous, exists := identity[key]; exists {
			if observationSortKey(previous) != observationSortKey(observation) {
				ambiguousIdentity[key] = true
			}
			continue
		}
		identity[key] = observation
	}
	for key, observation := range identity {
		if ambiguousIdentity[key] {
			addDiagnostic(&receipt, "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS", "conflicting evidence observations share one identity")
			continue
		}
		validByKind[observation.Kind] = append(validByKind[observation.Kind], observation)
	}
	for kind, values := range validByKind {
		if len(values) > 1 {
			addDiagnostic(&receipt, "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS", "multiple evidence observations satisfy one singleton kind")
			delete(validByKind, kind)
		}
	}

	revision := ""
	revisionMismatch := false
	for kind, values := range validByKind {
		if !requiresRevision(kind) || len(values) != 1 {
			continue
		}
		if revision == "" {
			revision = values[0].Ref.Revision
		} else if revision != values[0].Ref.Revision {
			revisionMismatch = true
		}
	}
	if revisionMismatch {
		addDiagnostic(&receipt, "AGX-EVIDENCE-REVISION-MISMATCH", "correlated evidence revisions do not match")
	}

	for _, requirement := range requirements {
		var selected *EvidenceObservation
		for _, kind := range requirement.kinds {
			values := validByKind[kind]
			if len(values) == 1 && (!revisionMismatch || !requiresRevision(kind)) {
				value := values[0]
				selected = &value
				break
			}
		}
		result := RequirementResult{ID: requirement.id, Code: requirement.code}
		if selected == nil {
			receipt.Missing = append(receipt.Missing, result)
			receipt.NextSteps = append(receipt.NextSteps, requirement.next)
			addDiagnostic(&receipt, requirement.code, "required evidence is missing")
			continue
		}
		receipt.Satisfied = append(receipt.Satisfied, result)
		receipt.Evidence = append(receipt.Evidence, ObservationRef{
			Source: selected.Source, Kind: selected.Kind, Fingerprint: selected.Fingerprint,
			Ref: selected.Ref, ObservedAt: selected.ObservedAt,
		})
	}
	if hasPreflightDiagnostic(receipt.Diagnostics) {
		receipt.Phase = PhaseBlockedPreflight
	} else if len(receipt.Missing) == 0 {
		receipt.Phase = PhaseVerified
	} else {
		receipt.Phase = PhaseAwaitingVerification
	}
	return receipt
}

func profileRequirements(profile EvidenceProfileID) ([]evidenceRequirement, bool) {
	switch profile {
	case EvidenceProfileGitHubDeliveryV1:
		return append([]evidenceRequirement(nil), githubRequirements...), true
	case EvidenceProfileMulticaExecutionV1:
		result := append([]evidenceRequirement(nil), githubRequirements...)
		return append(result, multicaRequirements...), true
	default:
		return nil, false
	}
}

func validateEvaluationEnvelope(input EvaluationInput, profileOK bool) []Diagnostic {
	var diagnostics []Diagnostic
	add := func(code, message string) { diagnostics = append(diagnostics, evidenceDiagnostic(code, message)) }
	if input.SchemaVersion != EvidenceInputSchemaV1 {
		add("AGX-EVIDENCE-SCHEMA-UNSUPPORTED", "unsupported evidence input schema")
	}
	if input.EvaluatorVersion != EvidenceEvaluatorV1 {
		add("AGX-EVIDENCE-EVALUATOR-UNSUPPORTED", "unsupported evidence evaluator")
	}
	if input.Profile == "" {
		add("AGX-EVIDENCE-PROFILE-REQUIRED", "an explicit evidence profile is required")
	} else if !profileOK {
		add("AGX-EVIDENCE-PROFILE-UNSUPPORTED", "unsupported evidence profile")
	}
	if !installPattern.MatchString(string(input.InstallationID)) {
		add("AGX-EVIDENCE-INSTALLATION-INVALID", "invalid installation identity")
	}
	if !hex64Pattern.MatchString(input.DeploymentDigest) || !hex64Pattern.MatchString(input.SubjectDigest) {
		add("AGX-EVIDENCE-SUBJECT-INCOMPLETE", "deployment and subject digests are required")
	}
	if input.EvaluatedAt.IsZero() || !isUTC(input.EvaluatedAt) {
		add("AGX-EVIDENCE-EVALUATED-AT-INVALID", "evaluation time must be non-zero UTC")
	}
	if len(input.Observations) > MaxEvidenceObservations {
		add("AGX-EVIDENCE-OBSERVATION-LIMIT", "too many evidence observations")
	}
	for _, observation := range input.Observations {
		diagnostics = append(diagnostics, validateObservationEnvelope(observation)...)
	}
	return dedupeDiagnostics(diagnostics)
}

func validateObservationEnvelope(observation EvidenceObservation) []Diagnostic {
	var diagnostics []Diagnostic
	add := func(code, message string) { diagnostics = append(diagnostics, evidenceDiagnostic(code, message)) }
	if observation.SchemaVersion != EvidenceObservationSchemaV1 {
		add("AGX-EVIDENCE-SCHEMA-UNSUPPORTED", "unsupported evidence observation schema")
	}
	if observation.EvaluatorVersion != EvidenceEvaluatorV1 {
		add("AGX-EVIDENCE-EVALUATOR-UNSUPPORTED", "unsupported evidence observation evaluator")
	}
	if !knownKind(observation.Kind) {
		add("AGX-EVIDENCE-KIND-UNSUPPORTED", "unsupported evidence kind")
		return diagnostics
	}
	if !installPattern.MatchString(string(observation.InstallationID)) {
		add("AGX-EVIDENCE-INSTALLATION-INVALID", "invalid observation installation identity")
	}
	if !hex64Pattern.MatchString(observation.DeploymentDigest) || !hex64Pattern.MatchString(observation.SubjectDigest) || !hex64Pattern.MatchString(observation.Fingerprint) {
		add("AGX-EVIDENCE-OBSERVATION-INVALID", "invalid observation digest")
	}
	if observation.ObservedAt.IsZero() || !isUTC(observation.ObservedAt) {
		add("AGX-EVIDENCE-OBSERVATION-INVALID", "observation time must be non-zero UTC")
	}
	switch observation.Outcome {
	case ObservationMatched, ObservationAbsent, ObservationAmbiguous, ObservationDrifted, ObservationRejected:
	default:
		add("AGX-EVIDENCE-OBSERVATION-INVALID", "invalid observation outcome")
	}
	if err := validateEvidenceRef(observation.Kind, observation.Ref); err != "" {
		add("AGX-EVIDENCE-OBSERVATION-INVALID", err)
	}
	return diagnostics
}

func validateEvidenceRef(kind EvidenceKind, ref EvidenceRef) string {
	if ref.ResourceType != resourceTypeForKind(kind) {
		return "evidence resource type does not match kind"
	}
	if ref.IdentitySHA256 != "" && !hex64Pattern.MatchString(ref.IdentitySHA256) {
		return "invalid hashed evidence identity"
	}
	if ref.UUID != "" && !uuidPattern.MatchString(ref.UUID) {
		return "invalid evidence UUID"
	}
	if ref.Revision != "" && !hex40Pattern.MatchString(ref.Revision) {
		return "invalid evidence revision"
	}
	if requiresRevision(kind) && ref.Revision == "" {
		return "evidence revision is required"
	}
	if !requiresRevision(kind) && ref.Revision != "" {
		return "evidence revision is not allowed"
	}
	switch kind {
	case EvidenceGitHubContractIssue, EvidenceGitHubDeliveryPROpen, EvidenceGitHubDeliveryResult:
		if ref.Number == 0 {
			return "positive evidence number is required"
		}
		if ref.UUID != "" {
			return "UUID is not allowed for GitHub numbered evidence"
		}
	case EvidenceMulticaWorkspace, EvidenceMulticaRuntimeOnline, EvidenceMulticaAgent:
		if ref.UUID == "" || ref.IdentitySHA256 != "" || ref.Number != 0 {
			return "strict UUID is required for selected Multica evidence"
		}
	case EvidenceMulticaTaskCompleted, EvidenceMulticaRunCompleted:
		if ref.UUID == "" && ref.IdentitySHA256 == "" {
			return "typed task or run identity is required"
		}
		if ref.UUID != "" && ref.IdentitySHA256 != "" {
			return "task or run identity must use exactly one representation"
		}
	default:
		if ref.IdentitySHA256 == "" {
			return "hashed evidence identity is required"
		}
		if ref.UUID != "" || ref.Number != 0 {
			return "unexpected evidence identity field"
		}
	}
	return ""
}

func kindRelevant(profile EvidenceProfileID, kind EvidenceKind) bool {
	if profile == EvidenceProfileMulticaExecutionV1 {
		return true
	}
	return sourceForKind(kind) == EvidenceSourceGitHub
}

func sourceForKind(kind EvidenceKind) EvidenceSource {
	if strings.HasPrefix(string(kind), "multica.") {
		return EvidenceSourceMultica
	}
	return EvidenceSourceGitHub
}

func knownKind(kind EvidenceKind) bool {
	for _, requirement := range append(append([]evidenceRequirement(nil), githubRequirements...), multicaRequirements...) {
		for _, candidate := range requirement.kinds {
			if kind == candidate {
				return true
			}
		}
	}
	return false
}

func resourceTypeForKind(kind EvidenceKind) EvidenceResourceType {
	switch kind {
	case EvidenceGitHubControlRepository, EvidenceGitHubContractsRepository:
		return ResourceRepository
	case EvidenceGitHubProject:
		return ResourceProject
	case EvidenceGitHubProjectItem:
		return ResourceProjectItem
	case EvidenceGitHubContractIssue:
		return ResourceIssue
	case EvidenceGitHubAgentFirstWrite, EvidenceGitHubCurrentWork:
		return ResourceCommit
	case EvidenceGitHubDeliveryPROpen, EvidenceGitHubDeliveryResult:
		return ResourcePullRequest
	case EvidenceGitHubChecksPassed, EvidenceGitHubIndependentVerifier:
		return ResourceCheck
	case EvidenceMulticaWorkspace:
		return ResourceWorkspace
	case EvidenceMulticaRuntimeOnline:
		return ResourceRuntime
	case EvidenceMulticaAgent:
		return ResourceAgent
	case EvidenceMulticaTaskCompleted:
		return ResourceTask
	case EvidenceMulticaRunCompleted:
		return ResourceRun
	default:
		return ""
	}
}

func requiresRevision(kind EvidenceKind) bool {
	switch kind {
	case EvidenceGitHubAgentFirstWrite, EvidenceGitHubCurrentWork, EvidenceGitHubDeliveryPROpen,
		EvidenceGitHubDeliveryResult, EvidenceGitHubChecksPassed, EvidenceGitHubIndependentVerifier:
		return true
	default:
		return false
	}
}

func observationIdentityKey(observation EvidenceObservation) string {
	data, _ := json.Marshal(struct {
		Source           EvidenceSource `json:"source"`
		Kind             EvidenceKind   `json:"kind"`
		InstallationID   InstallationID `json:"installation_id"`
		DeploymentDigest string         `json:"deployment_digest"`
		SubjectDigest    string         `json:"subject_digest"`
		Ref              EvidenceRef    `json:"ref"`
	}{observation.Source, observation.Kind, observation.InstallationID, observation.DeploymentDigest, observation.SubjectDigest, observation.Ref})
	return string(data)
}

func observationSortKey(observation EvidenceObservation) string {
	data, _ := json.Marshal(observation)
	return string(data)
}

func outcomeDiagnostic(outcome ObservationOutcome) string {
	switch outcome {
	case ObservationAbsent:
		return "AGX-EVIDENCE-OBSERVATION-ABSENT"
	case ObservationAmbiguous:
		return "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS"
	case ObservationDrifted:
		return "AGX-EVIDENCE-OBSERVATION-DRIFTED"
	default:
		return "AGX-EVIDENCE-OBSERVATION-REJECTED"
	}
}

func evidenceDiagnostic(code, message string) Diagnostic {
	return Diagnostic{Code: DiagnosticCode(code), Category: DiagnosticCategoryPreflight, Severity: SeverityError, Message: message}
}

func addDiagnostic(receipt *EvidenceReceipt, code, message string) {
	for _, diagnostic := range receipt.Diagnostics {
		if string(diagnostic.Code) == code {
			return
		}
	}
	receipt.Diagnostics = append(receipt.Diagnostics, evidenceDiagnostic(code, message))
}

func dedupeDiagnostics(values []Diagnostic) []Diagnostic {
	result := make([]Diagnostic, 0, len(values))
	seen := map[DiagnosticCode]bool{}
	for _, value := range values {
		if !seen[value.Code] {
			seen[value.Code] = true
			result = append(result, value)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Code != result[j].Code {
			return result[i].Code < result[j].Code
		}
		if result[i].Category != result[j].Category {
			return result[i].Category < result[j].Category
		}
		if result[i].Severity != result[j].Severity {
			return result[i].Severity < result[j].Severity
		}
		return result[i].Message < result[j].Message
	})
	return result
}

func hasPreflightDiagnostic(values []Diagnostic) bool {
	for _, value := range values {
		switch value.Code {
		case "AGX-EVIDENCE-SCHEMA-UNSUPPORTED",
			"AGX-EVIDENCE-EVALUATOR-UNSUPPORTED",
			"AGX-EVIDENCE-PROFILE-REQUIRED",
			"AGX-EVIDENCE-PROFILE-UNSUPPORTED",
			"AGX-EVIDENCE-INSTALLATION-INVALID",
			"AGX-EVIDENCE-SUBJECT-INCOMPLETE",
			"AGX-EVIDENCE-OBSERVATION-LIMIT",
			"AGX-EVIDENCE-KIND-UNSUPPORTED",
			"AGX-EVIDENCE-OBSERVATION-INVALID",
			"AGX-EVIDENCE-SOURCE-MISMATCH",
			"AGX-EVIDENCE-INSTALLATION-MISMATCH",
			"AGX-EVIDENCE-DEPLOYMENT-MISMATCH",
			"AGX-EVIDENCE-SUBJECT-MISMATCH":
			return true
		}
	}
	return false
}

func appendMissing(receipt *EvidenceReceipt, requirements []evidenceRequirement) {
	for _, requirement := range requirements {
		receipt.Missing = append(receipt.Missing, RequirementResult{ID: requirement.id, Code: requirement.code})
		receipt.NextSteps = append(receipt.NextSteps, requirement.next)
	}
}

func isUTC(value time.Time) bool { _, offset := value.Zone(); return offset == 0 }

func NamespacedIdentitySHA256(source, resourceType, raw string) string {
	digest := sha256.Sum256([]byte(source + "\x00" + resourceType + "\x00" + raw))
	return hex.EncodeToString(digest[:])
}

func ComputeDeploymentDigest(binding DeploymentBindingV1) (string, error) {
	if binding.SchemaVersion != DeploymentBindingSchemaV1 || !installPattern.MatchString(string(binding.InstallationID)) {
		return "", fmt.Errorf("AGX-EVIDENCE-DEPLOYMENT-BINDING-INVALID")
	}
	for _, value := range []string{binding.BundleSHA256, binding.TemplateSHA256, binding.ControlRepository.IdentitySHA256, binding.ControlRepository.TemplateSHA256, binding.ContractsRepository.IdentitySHA256, binding.ContractsRepository.TemplateSHA256, binding.ProjectIdentitySHA256, binding.FirstUseContractSHA256} {
		if !hex64Pattern.MatchString(value) {
			return "", fmt.Errorf("AGX-EVIDENCE-DEPLOYMENT-BINDING-INVALID")
		}
	}
	copyBinding := binding
	copyBinding.SelectedProviders = append([]string(nil), binding.SelectedProviders...)
	sort.Strings(copyBinding.SelectedProviders)
	data, err := json.Marshal(copyBinding)
	if err != nil {
		return "", fmt.Errorf("AGX-EVIDENCE-DEPLOYMENT-BINDING-INVALID")
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

func ComputeSubjectDigest(binding SubjectBindingV1) (string, error) {
	if binding.SchemaVersion != EvidenceSubjectSchemaV1 || !hex64Pattern.MatchString(binding.DeploymentDigest) || binding.Profile == "" {
		return "", fmt.Errorf("AGX-EVIDENCE-SUBJECT-INCOMPLETE")
	}
	values := []string{binding.InstallationMarkerSHA256, binding.GitHubSelectors.ControlRepositorySHA256, binding.GitHubSelectors.ContractsRepositorySHA256, binding.GitHubSelectors.ProjectSelectorSHA256, binding.GitHubSelectors.IssueSelectorSHA256, binding.GitHubSelectors.PullRequestSelectorSHA256, binding.GitHubSelectors.BranchSelectorSHA256, binding.GitHubSelectors.WorkflowSHA256, binding.GitHubSelectors.CheckSelectorSHA256}
	for _, value := range values {
		if !hex64Pattern.MatchString(value) {
			return "", fmt.Errorf("AGX-EVIDENCE-SUBJECT-INCOMPLETE")
		}
	}
	if binding.Profile == EvidenceProfileMulticaExecutionV1 {
		if binding.MulticaSelectors == nil || !uuidPattern.MatchString(binding.MulticaSelectors.WorkspaceUUID) || !uuidPattern.MatchString(binding.MulticaSelectors.RuntimeUUID) || !uuidPattern.MatchString(binding.MulticaSelectors.AgentUUID) || !hex64Pattern.MatchString(binding.MulticaSelectors.ExecutionMarkerSHA256) {
			return "", fmt.Errorf("AGX-EVIDENCE-SUBJECT-INCOMPLETE")
		}
	} else if binding.Profile != EvidenceProfileGitHubDeliveryV1 || binding.MulticaSelectors != nil {
		return "", fmt.Errorf("AGX-EVIDENCE-SUBJECT-INCOMPLETE")
	}
	data, err := json.Marshal(binding)
	if err != nil {
		return "", fmt.Errorf("AGX-EVIDENCE-SUBJECT-INCOMPLETE")
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

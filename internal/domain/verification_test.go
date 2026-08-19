package domain_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/2233admin/agx/internal/domain"
)

const (
	installationID   = domain.InstallationID("install-0123456789abcdef")
	deploymentDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	subjectDigest    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	fingerprint      = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	revision         = "dddddddddddddddddddddddddddddddddddddddd"
	identity         = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
)

var evaluatedAt = time.Date(2026, 8, 19, 1, 0, 0, 0, time.UTC)

func TestValidateEvidenceProfileSelectionRequiresStrictMulticaUUIDs(t *testing.T) {
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileGitHubDeliveryV1, "", "", ""); err != nil {
		t.Fatalf("GitHub profile selection err=%v", err)
	}
	valid := "123e4567-e89b-42d3-a456-426614174000"
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileMulticaExecutionV1, valid, valid, valid); err != nil {
		t.Fatalf("Multica profile selection err=%v", err)
	}
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileMulticaExecutionV1, valid, "runtime", valid); err == nil || err.Error() != "AGX-EVIDENCE-SUBJECT-INCOMPLETE" {
		t.Fatalf("invalid Multica selection err=%v", err)
	}
}

func TestEvaluateEvidenceGitHubProfileVerifiesCompleteObservationsWithoutMultica(t *testing.T) {
	input := githubInput()
	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseVerified || len(receipt.Missing) != 0 || len(receipt.Satisfied) != 8 {
		t.Fatalf("EvaluateEvidence() = phase %q, satisfied %d, missing %#v, diagnostics %#v", receipt.Phase, len(receipt.Satisfied), receipt.Missing, receipt.Diagnostics)
	}

	input.Observations = append(input.Observations, observation(domain.EvidenceMulticaRuntimeOnline, domain.ObservationRejected))
	receiptWithIrrelevantMultica := domain.EvaluateEvidence(input)
	if receiptWithIrrelevantMultica.Phase != domain.PhaseVerified {
		t.Fatalf("GitHub profile with recognized Multica rejection = %q, want verified", receiptWithIrrelevantMultica.Phase)
	}
}

func TestEvaluateEvidenceMulticaProfileRequiresGitHubBaseAndEveryExtension(t *testing.T) {
	input := githubInput()
	input.Profile = domain.EvidenceProfileMulticaExecutionV1
	input.Observations = append(input.Observations,
		observation(domain.EvidenceMulticaWorkspace, domain.ObservationMatched),
		observation(domain.EvidenceMulticaRuntimeOnline, domain.ObservationMatched),
		observation(domain.EvidenceMulticaAgent, domain.ObservationMatched),
	)
	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseAwaitingVerification || len(receipt.Missing) != 1 || receipt.Missing[0].Code != "AGX-EVIDENCE-MULTICA-EXECUTION-MISSING" {
		t.Fatalf("missing Multica execution = phase %q, missing %#v", receipt.Phase, receipt.Missing)
	}

	input.Observations = append(input.Observations, observation(domain.EvidenceMulticaTaskCompleted, domain.ObservationMatched))
	receipt = domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseVerified || len(receipt.Satisfied) != 12 {
		t.Fatalf("complete Multica profile = phase %q, satisfied %d, diagnostics %#v", receipt.Phase, len(receipt.Satisfied), receipt.Diagnostics)
	}

	input.Observations = input.Observations[len(githubInput().Observations):]
	receipt = domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseAwaitingVerification || len(receipt.Missing) != 8 {
		t.Fatalf("Multica-only observations = phase %q, missing %#v", receipt.Phase, receipt.Missing)
	}
}

func TestEvaluateEvidenceSingleClaimsNeverVerify(t *testing.T) {
	for _, kind := range []domain.EvidenceKind{
		domain.EvidenceGitHubDeliveryPROpen,
		domain.EvidenceMulticaRuntimeOnline,
		domain.EvidenceMulticaTaskCompleted,
	} {
		t.Run(string(kind), func(t *testing.T) {
			input := githubInput()
			input.Observations = []domain.EvidenceObservation{observation(kind, domain.ObservationMatched)}
			if receipt := domain.EvaluateEvidence(input); receipt.Phase == domain.PhaseVerified {
				t.Fatalf("single %s observation produced verified", kind)
			}
		})
	}
	for _, kind := range []domain.EvidenceKind{"agent.self-report/v1", "model.score/v1"} {
		input := githubInput()
		input.Observations = []domain.EvidenceObservation{observation(kind, domain.ObservationMatched)}
		if receipt := domain.EvaluateEvidence(input); receipt.Phase != domain.PhaseBlockedPreflight || !hasDiagnostic(receipt, "AGX-EVIDENCE-KIND-UNSUPPORTED") {
			t.Fatalf("unknown claim %q = phase %q, diagnostics %#v", kind, receipt.Phase, receipt.Diagnostics)
		}
	}
}

func TestEvaluateEvidenceRejectsWrongBindingsOutcomesAndTime(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*domain.EvidenceObservation)
		code   string
	}{
		{"source", func(value *domain.EvidenceObservation) { value.Source = domain.EvidenceSourceMultica }, "AGX-EVIDENCE-SOURCE-MISMATCH"},
		{"installation", func(value *domain.EvidenceObservation) { value.InstallationID = "install-fedcba9876543210" }, "AGX-EVIDENCE-INSTALLATION-MISMATCH"},
		{"deployment", func(value *domain.EvidenceObservation) { value.DeploymentDigest = strings.Repeat("f", 64) }, "AGX-EVIDENCE-DEPLOYMENT-MISMATCH"},
		{"subject", func(value *domain.EvidenceObservation) { value.SubjectDigest = strings.Repeat("f", 64) }, "AGX-EVIDENCE-SUBJECT-MISMATCH"},
		{"future", func(value *domain.EvidenceObservation) { value.ObservedAt = evaluatedAt.Add(time.Second) }, "AGX-EVIDENCE-OBSERVATION-FUTURE"},
		{"exact expiry", func(value *domain.EvidenceObservation) { value.ObservedAt = evaluatedAt.Add(-15 * time.Minute) }, "AGX-EVIDENCE-OBSERVATION-EXPIRED"},
		{"drifted", func(value *domain.EvidenceObservation) { value.Outcome = domain.ObservationDrifted }, "AGX-EVIDENCE-OBSERVATION-DRIFTED"},
		{"ambiguous", func(value *domain.EvidenceObservation) { value.Outcome = domain.ObservationAmbiguous }, "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS"},
		{"rejected", func(value *domain.EvidenceObservation) { value.Outcome = domain.ObservationRejected }, "AGX-EVIDENCE-OBSERVATION-REJECTED"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := githubInput()
			test.mutate(&input.Observations[0])
			receipt := domain.EvaluateEvidence(input)
			if receipt.Phase == domain.PhaseVerified || !hasDiagnostic(receipt, test.code) {
				t.Fatalf("EvaluateEvidence() = phase %q, diagnostics %#v, want %s", receipt.Phase, receipt.Diagnostics, test.code)
			}
		})
	}
}

func TestEvaluateEvidenceBlocksVerifiedWhenForeignEvidenceIsMixedWithCompleteEvidence(t *testing.T) {
	input := githubInput()
	foreign := input.Observations[0]
	foreign.InstallationID = "install-fedcba9876543210"
	foreign.Fingerprint = strings.Repeat("f", 64)
	input.Observations = append(input.Observations, foreign)

	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseBlockedPreflight || !hasDiagnostic(receipt, "AGX-EVIDENCE-INSTALLATION-MISMATCH") {
		t.Fatalf("EvaluateEvidence() = phase %q, diagnostics %#v, want foreign evidence to block verified", receipt.Phase, receipt.Diagnostics)
	}
}

func TestEvaluateEvidenceBlocksUnsupportedOrMalformedEnvelopes(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*domain.EvaluationInput)
		code   string
	}{
		{"input schema", func(input *domain.EvaluationInput) { input.SchemaVersion = "agx/evidence-input/v2" }, "AGX-EVIDENCE-SCHEMA-UNSUPPORTED"},
		{"observation schema", func(input *domain.EvaluationInput) {
			input.Observations[0].SchemaVersion = "agx/evidence-observation/v2"
		}, "AGX-EVIDENCE-SCHEMA-UNSUPPORTED"},
		{"evaluator", func(input *domain.EvaluationInput) { input.EvaluatorVersion = "agx/evidence-evaluator/v2" }, "AGX-EVIDENCE-EVALUATOR-UNSUPPORTED"},
		{"profile required", func(input *domain.EvaluationInput) { input.Profile = "" }, "AGX-EVIDENCE-PROFILE-REQUIRED"},
		{"profile unsupported", func(input *domain.EvaluationInput) { input.Profile = "github-delivery/v2" }, "AGX-EVIDENCE-PROFILE-UNSUPPORTED"},
		{"installation format", func(input *domain.EvaluationInput) { input.InstallationID = "install-test" }, "AGX-EVIDENCE-INSTALLATION-INVALID"},
		{"kind resource mismatch", func(input *domain.EvaluationInput) {
			input.Observations[0].Ref.ResourceType = domain.ResourceRuntime
		}, "AGX-EVIDENCE-OBSERVATION-INVALID"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := githubInput()
			test.mutate(&input)
			receipt := domain.EvaluateEvidence(input)
			if receipt.Phase != domain.PhaseBlockedPreflight || !hasDiagnostic(receipt, test.code) {
				t.Fatalf("EvaluateEvidence() = phase %q, diagnostics %#v", receipt.Phase, receipt.Diagnostics)
			}
		})
	}
}

func TestEvaluateEvidenceIsDeterministicAcrossPermutationAndDuplicates(t *testing.T) {
	input := githubInput()
	baseline, err := json.Marshal(domain.EvaluateEvidence(input))
	if err != nil {
		t.Fatal(err)
	}

	for left, right := 0, len(input.Observations)-1; left < right; left, right = left+1, right-1 {
		input.Observations[left], input.Observations[right] = input.Observations[right], input.Observations[left]
	}
	input.Observations = append(input.Observations, input.Observations[0])
	permuted, err := json.Marshal(domain.EvaluateEvidence(input))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(baseline, permuted) {
		t.Fatalf("permuted receipt differs\nbaseline: %s\npermuted: %s", baseline, permuted)
	}
}

func TestEvaluateEvidenceRejectsConflictingIdentityAndRevision(t *testing.T) {
	input := githubInput()
	conflict := input.Observations[0]
	conflict.Fingerprint = strings.Repeat("f", 64)
	input.Observations = append(input.Observations, conflict)
	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase == domain.PhaseVerified || !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS") {
		t.Fatalf("conflicting identity = phase %q, diagnostics %#v", receipt.Phase, receipt.Diagnostics)
	}

	input = githubInput()
	for index := range input.Observations {
		if input.Observations[index].Kind == domain.EvidenceGitHubChecksPassed {
			input.Observations[index].Ref.Revision = strings.Repeat("f", 40)
		}
	}
	receipt = domain.EvaluateEvidence(input)
	if receipt.Phase == domain.PhaseVerified || !hasDiagnostic(receipt, "AGX-EVIDENCE-REVISION-MISMATCH") {
		t.Fatalf("revision mismatch = phase %q, diagnostics %#v", receipt.Phase, receipt.Diagnostics)
	}
}

func TestDecodeEvaluationInputIsBoundedAndStrict(t *testing.T) {
	input := githubInput()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := domain.DecodeEvaluationInput(data); err != nil {
		t.Fatalf("DecodeEvaluationInput() error = %v", err)
	}

	for name, payload := range map[string][]byte{
		"unknown field":   []byte(`{"schema_version":"agx/evidence-input/v1","unexpected":true}`),
		"second document": append(append([]byte(nil), data...), []byte(` {}`)...),
		"oversize":        bytes.Repeat([]byte("x"), domain.MaxEvidenceInputBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := domain.DecodeEvaluationInput(payload); err == nil {
				t.Fatal("DecodeEvaluationInput() error = nil")
			}
		})
	}
}

func TestEvidenceBindingDigestsAreCanonicalAndSensitive(t *testing.T) {
	binding := deploymentBinding()
	first, err := domain.ComputeDeploymentDigest(binding)
	if err != nil {
		t.Fatal(err)
	}
	binding.SelectedProviders = []string{"codex", "claude"}
	second, err := domain.ComputeDeploymentDigest(binding)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("provider permutation changed digest: %s != %s", first, second)
	}

	subject := subjectBinding(first, domain.EvidenceProfileGitHubDeliveryV1)
	firstSubject, err := domain.ComputeSubjectDigest(subject)
	if err != nil {
		t.Fatal(err)
	}
	if first == firstSubject || !isLowerHex(firstSubject, 64) {
		t.Fatalf("subject digest = %q", firstSubject)
	}

	subject.Profile = domain.EvidenceProfileMulticaExecutionV1
	if _, err := domain.ComputeSubjectDigest(subject); err == nil {
		t.Fatal("Multica subject without selectors was accepted")
	}
	subject.MulticaSelectors = &domain.MulticaSubjectSelectorsV1{
		WorkspaceUUID:         "11111111-1111-4111-8111-111111111111",
		RuntimeUUID:           "22222222-2222-4222-8222-222222222222",
		AgentUUID:             "33333333-3333-4333-8333-333333333333",
		ExecutionMarkerSHA256: strings.Repeat("f", 64),
	}
	if _, err := domain.ComputeSubjectDigest(subject); err != nil {
		t.Fatalf("valid Multica subject rejected: %v", err)
	}
}

func TestLegacyReceiptRemainsReadableWithoutProducingEvidenceVerdict(t *testing.T) {
	payload := []byte(`{"installation_id":"install-001","phase":"verified","verification":{"github":{"source":"github","installation_id":"install-001","evidence_id":"repo-node"},"multica":{"source":"multica","installation_id":"install-001","evidence_id":"task-id"}}}`)
	var receipt domain.Receipt
	if err := json.Unmarshal(payload, &receipt); err != nil {
		t.Fatalf("legacy receipt decode: %v", err)
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, encoded) {
		t.Fatalf("legacy receipt round trip = %s", encoded)
	}

	evidence := domain.EvaluateEvidence(domain.EvaluationInput{
		SchemaVersion: domain.EvidenceInputSchemaV1, EvaluatorVersion: domain.EvidenceEvaluatorV1,
		InstallationID: installationID, DeploymentDigest: deploymentDigest, SubjectDigest: subjectDigest,
		EvaluatedAt: evaluatedAt,
	})
	if evidence.Phase != domain.PhaseBlockedPreflight || !hasDiagnostic(evidence, "AGX-EVIDENCE-PROFILE-REQUIRED") {
		t.Fatalf("legacy profile-less evidence = phase %q, diagnostics %#v", evidence.Phase, evidence.Diagnostics)
	}
}

func githubInput() domain.EvaluationInput {
	return domain.EvaluationInput{
		SchemaVersion: domain.EvidenceInputSchemaV1, EvaluatorVersion: domain.EvidenceEvaluatorV1,
		InstallationID: installationID, DeploymentDigest: deploymentDigest, SubjectDigest: subjectDigest,
		Profile: domain.EvidenceProfileGitHubDeliveryV1, EvaluatedAt: evaluatedAt,
		Observations: []domain.EvidenceObservation{
			observation(domain.EvidenceGitHubControlRepository, domain.ObservationMatched),
			observation(domain.EvidenceGitHubContractsRepository, domain.ObservationMatched),
			observation(domain.EvidenceGitHubProject, domain.ObservationMatched),
			observation(domain.EvidenceGitHubProjectItem, domain.ObservationMatched),
			observation(domain.EvidenceGitHubContractIssue, domain.ObservationMatched),
			observation(domain.EvidenceGitHubCurrentWork, domain.ObservationMatched),
			observation(domain.EvidenceGitHubDeliveryPROpen, domain.ObservationMatched),
			observation(domain.EvidenceGitHubChecksPassed, domain.ObservationMatched),
		},
	}
}

func observation(kind domain.EvidenceKind, outcome domain.ObservationOutcome) domain.EvidenceObservation {
	ref := domain.EvidenceRef{ResourceType: resourceType(kind), IdentitySHA256: identity}
	switch kind {
	case domain.EvidenceGitHubContractIssue:
		ref = domain.EvidenceRef{ResourceType: domain.ResourceIssue, Number: 42}
	case domain.EvidenceGitHubDeliveryPROpen, domain.EvidenceGitHubDeliveryResult:
		ref = domain.EvidenceRef{ResourceType: domain.ResourcePullRequest, Number: 48, Revision: revision}
	case domain.EvidenceGitHubAgentFirstWrite, domain.EvidenceGitHubCurrentWork:
		ref.Revision = revision
	case domain.EvidenceGitHubChecksPassed, domain.EvidenceGitHubIndependentVerifier:
		ref.Revision = revision
	case domain.EvidenceMulticaWorkspace:
		ref = domain.EvidenceRef{ResourceType: domain.ResourceWorkspace, UUID: "11111111-1111-4111-8111-111111111111"}
	case domain.EvidenceMulticaRuntimeOnline:
		ref = domain.EvidenceRef{ResourceType: domain.ResourceRuntime, UUID: "22222222-2222-4222-8222-222222222222"}
	case domain.EvidenceMulticaAgent:
		ref = domain.EvidenceRef{ResourceType: domain.ResourceAgent, UUID: "33333333-3333-4333-8333-333333333333"}
	case domain.EvidenceMulticaTaskCompleted:
		ref = domain.EvidenceRef{ResourceType: domain.ResourceTask, UUID: "44444444-4444-4444-8444-444444444444"}
	case domain.EvidenceMulticaRunCompleted:
		ref = domain.EvidenceRef{ResourceType: domain.ResourceRun, IdentitySHA256: identity}
	}
	return domain.EvidenceObservation{
		SchemaVersion: domain.EvidenceObservationSchemaV1, EvaluatorVersion: domain.EvidenceEvaluatorV1,
		Source: source(kind), Kind: kind, InstallationID: installationID,
		DeploymentDigest: deploymentDigest, SubjectDigest: subjectDigest, Ref: ref,
		Fingerprint: fingerprint, Outcome: outcome, ObservedAt: evaluatedAt.Add(-time.Minute),
	}
}

func source(kind domain.EvidenceKind) domain.EvidenceSource {
	if strings.HasPrefix(string(kind), "multica.") {
		return domain.EvidenceSourceMultica
	}
	return domain.EvidenceSourceGitHub
}

func resourceType(kind domain.EvidenceKind) domain.EvidenceResourceType {
	switch kind {
	case domain.EvidenceGitHubControlRepository, domain.EvidenceGitHubContractsRepository:
		return domain.ResourceRepository
	case domain.EvidenceGitHubProject:
		return domain.ResourceProject
	case domain.EvidenceGitHubProjectItem:
		return domain.ResourceProjectItem
	case domain.EvidenceGitHubChecksPassed, domain.EvidenceGitHubIndependentVerifier:
		return domain.ResourceCheck
	default:
		return domain.ResourceCommit
	}
}

func hasDiagnostic(receipt domain.EvidenceReceipt, code string) bool {
	for _, diagnostic := range receipt.Diagnostics {
		if string(diagnostic.Code) == code {
			return true
		}
	}
	return false
}

func deploymentBinding() domain.DeploymentBindingV1 {
	return domain.DeploymentBindingV1{
		SchemaVersion: domain.DeploymentBindingSchemaV1, InstallationID: installationID,
		BundleSHA256: strings.Repeat("1", 64), TemplateVersion: "agx/bootstrap/v1", TemplateSHA256: strings.Repeat("2", 64),
		ProviderProfile: "core", SelectedProviders: []string{"claude", "codex"},
		ControlRepository:     domain.RepositoryBindingV1{IdentitySHA256: strings.Repeat("3", 64), TemplateSHA256: strings.Repeat("4", 64)},
		ContractsRepository:   domain.RepositoryBindingV1{IdentitySHA256: strings.Repeat("5", 64), TemplateSHA256: strings.Repeat("6", 64)},
		ProjectIdentitySHA256: strings.Repeat("7", 64), FirstUseContractSHA256: strings.Repeat("8", 64),
	}
}

func subjectBinding(deployment string, profile domain.EvidenceProfileID) domain.SubjectBindingV1 {
	return domain.SubjectBindingV1{
		SchemaVersion: domain.EvidenceSubjectSchemaV1, Profile: profile, DeploymentDigest: deployment,
		InstallationMarkerSHA256: strings.Repeat("1", 64),
		GitHubSelectors: domain.GitHubSubjectSelectorsV1{
			ControlRepositorySHA256: strings.Repeat("2", 64), ContractsRepositorySHA256: strings.Repeat("3", 64),
			ProjectSelectorSHA256: strings.Repeat("4", 64), IssueSelectorSHA256: strings.Repeat("5", 64),
			PullRequestSelectorSHA256: strings.Repeat("6", 64), BranchSelectorSHA256: strings.Repeat("7", 64),
			WorkflowSHA256: strings.Repeat("8", 64), CheckSelectorSHA256: strings.Repeat("9", 64),
		},
	}
}

func isLowerHex(value string, size int) bool {
	if len(value) != size {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

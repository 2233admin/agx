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

func TestLegacyNewVerifiedReceiptRemainsReadable(t *testing.T) {
	installationID := domain.InstallationID("install-legacy")
	receipt, err := domain.NewVerifiedReceipt(installationID, domain.Verification{
		GitHub:  domain.Readback{Source: domain.ReadbackSourceGitHub, InstallationID: installationID, EvidenceID: "github-readback"},
		Multica: domain.Readback{Source: domain.ReadbackSourceMultica, InstallationID: installationID, EvidenceID: "multica-readback"},
	})
	if err != nil || receipt.Phase != domain.PhaseVerified {
		t.Fatalf("legacy verified receipt = %+v, %v", receipt, err)
	}
}

func TestValidateEvidenceProfileSelectionRequiresStrictMulticaUUIDs(t *testing.T) {
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileGitHubDeliveryV1, "", "", ""); err != nil {
		t.Fatalf("GitHub profile selection err=%v", err)
	}
	valid := "123e4567-e89b-42d3-a456-426614174000"
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileGitHubDeliveryV1, valid, "", ""); err == nil || err.Error() != "AGX-EVIDENCE-SUBJECT-INCOMPLETE" {
		t.Fatalf("GitHub profile with Multica selector err=%v", err)
	}
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileMulticaExecutionV1, valid, valid, valid); err != nil {
		t.Fatalf("Multica profile selection err=%v", err)
	}
	if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileMulticaExecutionV1, valid, "runtime", valid); err == nil || err.Error() != "AGX-EVIDENCE-SUBJECT-INCOMPLETE" {
		t.Fatalf("invalid Multica selection err=%v", err)
	}
	for _, nonCanonical := range []string{strings.ToUpper(valid), " " + valid, valid + " "} {
		if err := domain.ValidateEvidenceProfileSelection(domain.EvidenceProfileMulticaExecutionV1, valid, nonCanonical, valid); err == nil || err.Error() != "AGX-EVIDENCE-SUBJECT-INCOMPLETE" {
			t.Fatalf("non-canonical Multica selection %q err=%v", nonCanonical, err)
		}
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
		t.Fatalf("missing Multica execution = phase %q, missing %#v, diagnostics %#v", receipt.Phase, receipt.Missing, receipt.Diagnostics)
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

func TestEvaluateEvidenceRebuildsInputDiagnosticsWithoutCallerText(t *testing.T) {
	input := githubInput()
	secretText := "Authorization: Bearer " + "diagnostic-secret-marker"
	windowsPath := "C:" + `\Users\example\private\receipt.json`
	unixPath := "/" + "home/example/private/receipt.json"
	input.Diagnostics = []domain.Diagnostic{
		{
			Code:     "AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED",
			Category: domain.DiagnosticCategoryOutcome,
			Severity: domain.SeverityWarning,
			Message:  secretText + " " + windowsPath,
		},
		{
			Code:     "CALLER-CONTROLLED-CODE",
			Category: domain.DiagnosticCategoryFreshness,
			Severity: domain.SeverityWarning,
			Message:  unixPath,
		},
	}

	receipt := domain.EvaluateEvidence(input)
	encoded, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{secretText, windowsPath, unixPath, "CALLER-CONTROLLED-CODE"} {
		if strings.Contains(text, forbidden) {
			t.Fatal("EvaluateEvidence retained caller-controlled diagnostic material")
		}
	}
	for _, code := range []string{"AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED", "AGX-EVIDENCE-DIAGNOSTIC-UNSUPPORTED"} {
		if !strings.Contains(text, code) {
			t.Fatalf("EvaluateEvidence omitted safe diagnostic code %q", code)
		}
	}
}

func TestEvaluateEvidenceClassifiesBindingMismatchAsOutcome(t *testing.T) {
	for _, mutate := range []func(*domain.EvidenceObservation){
		func(value *domain.EvidenceObservation) { value.InstallationID = "install-fedcba9876543210" },
		func(value *domain.EvidenceObservation) { value.DeploymentDigest = strings.Repeat("f", 64) },
		func(value *domain.EvidenceObservation) { value.SubjectDigest = strings.Repeat("f", 64) },
	} {
		input := githubInput()
		mutate(&input.Observations[0])
		if receipt := domain.EvaluateEvidence(input); receipt.Phase != domain.PhaseBlockedOutcome {
			t.Fatalf("binding mismatch phase = %q, want %q", receipt.Phase, domain.PhaseBlockedOutcome)
		}
	}
}

func TestEvaluateEvidenceRejectedAndExpiredUsesOutcomePrecedence(t *testing.T) {
	input := githubInput()
	input.Observations[0].Outcome = domain.ObservationRejected
	input.Observations[0].ObservedAt = input.EvaluatedAt.Add(-time.Hour)
	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseBlockedOutcome || !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-REJECTED") ||
		len(receipt.Satisfied) != 7 || len(receipt.Missing) != 1 {
		t.Fatalf("rejected expired evidence = phase %q diagnostics %#v", receipt.Phase, receipt.Diagnostics)
	}
}

func TestEvaluateEvidenceBlocksVerifiedWhenForeignEvidenceIsMixedWithCompleteEvidence(t *testing.T) {
	input := githubInput()
	foreign := input.Observations[0]
	foreign.InstallationID = "install-fedcba9876543210"
	foreign.Fingerprint = strings.Repeat("f", 64)
	input.Observations = append(input.Observations, foreign)

	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase == domain.PhaseVerified || !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS") ||
		len(receipt.Satisfied) != 7 || len(receipt.Missing) != 1 {
		t.Fatalf("EvaluateEvidence() = phase %q, diagnostics %#v, want foreign identity conflict to block verified", receipt.Phase, receipt.Diagnostics)
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
		{"numbered GitHub excess hash", func(input *domain.EvaluationInput) {
			for index := range input.Observations {
				if input.Observations[index].Kind == domain.EvidenceGitHubContractIssue {
					input.Observations[index].Ref.IdentitySHA256 = strings.Repeat("f", 64)
				}
			}
		}, "AGX-EVIDENCE-OBSERVATION-INVALID"},
		{"Multica task excess number", func(input *domain.EvaluationInput) {
			value := observation(domain.EvidenceMulticaTaskCompleted, domain.ObservationMatched)
			value.Ref.Number = 1
			input.Observations = append(input.Observations, value)
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

func TestEvaluateEvidenceEnforcesExactRefShapeForEveryKind(t *testing.T) {
	kinds := []domain.EvidenceKind{
		domain.EvidenceGitHubControlRepository,
		domain.EvidenceGitHubContractsRepository,
		domain.EvidenceGitHubProject,
		domain.EvidenceGitHubProjectItem,
		domain.EvidenceGitHubContractIssue,
		domain.EvidenceGitHubAgentFirstWrite,
		domain.EvidenceGitHubCurrentWork,
		domain.EvidenceGitHubDeliveryPROpen,
		domain.EvidenceGitHubDeliveryResult,
		domain.EvidenceGitHubChecksPassed,
		domain.EvidenceGitHubIndependentVerifier,
		domain.EvidenceMulticaWorkspace,
		domain.EvidenceMulticaRuntimeOnline,
		domain.EvidenceMulticaAgent,
		domain.EvidenceMulticaTaskCompleted,
		domain.EvidenceMulticaRunCompleted,
	}
	for _, kind := range kinds {
		t.Run(string(kind), func(t *testing.T) {
			valid := observation(kind, domain.ObservationMatched)
			input := githubInput()
			input.Observations = []domain.EvidenceObservation{valid}
			if valid.Source == domain.EvidenceSourceMultica {
				input.Profile = domain.EvidenceProfileMulticaExecutionV1
			}
			if receipt := domain.EvaluateEvidence(input); hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-INVALID") {
				t.Fatal("valid typed evidence reference was rejected")
			}

			wrongResource := valid
			wrongResource.Ref.ResourceType = domain.ResourceRepository
			if valid.Ref.ResourceType == domain.ResourceRepository {
				wrongResource.Ref.ResourceType = domain.ResourceRun
			}
			input.Observations = []domain.EvidenceObservation{wrongResource}
			if receipt := domain.EvaluateEvidence(input); !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-INVALID") {
				t.Fatal("wrong resource type was accepted")
			}

			excess := valid
			switch {
			case excess.Ref.Number != 0:
				excess.Ref.IdentitySHA256 = identity
			case excess.Ref.UUID != "":
				excess.Ref.Number = 1
			default:
				excess.Ref.UUID = "123e4567-e89b-42d3-a456-426614174000"
			}
			input.Observations = []domain.EvidenceObservation{excess}
			if receipt := domain.EvaluateEvidence(input); !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-INVALID") {
				t.Fatal("excess evidence identity field was accepted")
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
	for _, test := range []struct {
		name   string
		mutate func(*domain.EvidenceObservation)
	}{
		{name: "fingerprint", mutate: func(value *domain.EvidenceObservation) { value.Fingerprint = strings.Repeat("f", 64) }},
		{name: "outcome", mutate: func(value *domain.EvidenceObservation) { value.Outcome = domain.ObservationRejected }},
		{name: "freshness", mutate: func(value *domain.EvidenceObservation) { value.ObservedAt = evaluatedAt.Add(-15 * time.Minute) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			forward := githubInput()
			conflict := forward.Observations[0]
			test.mutate(&conflict)
			forward.Observations = append(forward.Observations, conflict)
			backward := githubInput()
			backward.Observations = append([]domain.EvidenceObservation{conflict}, backward.Observations...)

			forwardReceipt := domain.EvaluateEvidence(forward)
			backwardReceipt := domain.EvaluateEvidence(backward)
			if forwardReceipt.Phase == domain.PhaseVerified || !hasDiagnostic(forwardReceipt, "AGX-EVIDENCE-OBSERVATION-AMBIGUOUS") {
				t.Fatalf("conflicting identity = phase %q, diagnostics %#v", forwardReceipt.Phase, forwardReceipt.Diagnostics)
			}
			forwardJSON, err := json.Marshal(forwardReceipt)
			if err != nil {
				t.Fatal(err)
			}
			backwardJSON, err := json.Marshal(backwardReceipt)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(forwardJSON, backwardJSON) {
				t.Fatal("conflicting identity verdict changed with input permutation")
			}
		})
	}

	input := githubInput()
	for index := range input.Observations {
		if input.Observations[index].Kind == domain.EvidenceGitHubChecksPassed {
			input.Observations[index].Ref.Revision = strings.Repeat("f", 40)
		}
	}
	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase == domain.PhaseVerified || !hasDiagnostic(receipt, "AGX-EVIDENCE-REVISION-MISMATCH") {
		t.Fatalf("revision mismatch = phase %q, diagnostics %#v", receipt.Phase, receipt.Diagnostics)
	}
}

func TestEvaluateEvidenceOrdersOutcomeBeforeFreshnessAndMissing(t *testing.T) {
	input := githubInput()
	for index := range input.Observations {
		switch input.Observations[index].Kind {
		case domain.EvidenceGitHubDeliveryPROpen:
			input.Observations[index].Outcome = domain.ObservationRejected
		case domain.EvidenceGitHubProject:
			input.Observations[index].ObservedAt = input.EvaluatedAt.Add(-time.Hour)
		}
	}
	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseBlockedOutcome || !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-REJECTED") || !hasDiagnostic(receipt, "AGX-EVIDENCE-OBSERVATION-EXPIRED") ||
		len(receipt.Satisfied) != 6 || len(receipt.Missing) != 2 {
		t.Fatalf("phase precedence = phase %q, diagnostics %#v", receipt.Phase, receipt.Diagnostics)
	}
}

func TestEvaluateEvidenceValidatesSourceBeforeProfileRelevance(t *testing.T) {
	input := githubInput()
	irrelevant := observation(domain.EvidenceMulticaRuntimeOnline, domain.ObservationMatched)
	irrelevant.Source = domain.EvidenceSourceGitHub
	input.Observations = append(input.Observations, irrelevant)

	receipt := domain.EvaluateEvidence(input)
	if receipt.Phase != domain.PhaseBlockedPreflight || !hasDiagnostic(receipt, "AGX-EVIDENCE-SOURCE-MISMATCH") {
		t.Fatalf("wrong-source irrelevant evidence = phase %q, diagnostics %#v", receipt.Phase, receipt.Diagnostics)
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

	for name, test := range map[string]struct {
		payload []byte
		code    string
	}{
		"unknown field":   {[]byte(`{"schema_version":"agx/evidence-input/v1","unexpected":true}`), "AGX-EVIDENCE-INPUT-INVALID"},
		"second document": {append(append([]byte(nil), data...), []byte(` {}`)...), "AGX-EVIDENCE-INPUT-TRAILING-DATA"},
		"oversize":        {bytes.Repeat([]byte("x"), domain.MaxEvidenceInputBytes+1), "AGX-EVIDENCE-INPUT-TOO-LARGE"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := domain.DecodeEvaluationInput(test.payload)
			if err == nil || err.Error() != test.code {
				t.Fatalf("DecodeEvaluationInput() error = %v, want %s", err, test.code)
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
	const goldenDeploymentDigest = "322a674f6332784674db997fc32823401d3a45eb53d9bedadfb21ec2ebb03b12"
	if first != goldenDeploymentDigest {
		t.Fatalf("deployment digest = %s", first)
	}
	for name, mutate := range map[string]func(*domain.DeploymentBindingV1){
		"empty template": func(value *domain.DeploymentBindingV1) { value.TemplateVersion = "" },
		"non-canonical template": func(value *domain.DeploymentBindingV1) {
			value.TemplateVersion = " agx/bootstrap/v1"
		},
		"unknown profile":     func(value *domain.DeploymentBindingV1) { value.ProviderProfile = "unknown" },
		"missing providers":   func(value *domain.DeploymentBindingV1) { value.SelectedProviders = nil },
		"duplicate providers": func(value *domain.DeploymentBindingV1) { value.SelectedProviders = []string{"codex", "codex"} },
		"unknown provider":    func(value *domain.DeploymentBindingV1) { value.SelectedProviders = []string{"other"} },
		"duplicate repository identity": func(value *domain.DeploymentBindingV1) {
			value.ContractsRepository.IdentitySHA256 = value.ControlRepository.IdentitySHA256
		},
	} {
		t.Run(name, func(t *testing.T) {
			invalid := deploymentBinding()
			mutate(&invalid)
			if _, err := domain.ComputeDeploymentDigest(invalid); err == nil {
				t.Fatal("ComputeDeploymentDigest() accepted invalid binding")
			}
		})
	}
	sensitive := deploymentBinding()
	sensitive.ProjectIdentitySHA256 = strings.Repeat("a", 64)
	changed, err := domain.ComputeDeploymentDigest(sensitive)
	if err != nil {
		t.Fatal(err)
	}
	if changed == first {
		t.Fatal("deployment digest did not change with a canonical binding field")
	}

	subject := subjectBinding(first, domain.EvidenceProfileGitHubDeliveryV1)
	firstSubject, err := domain.ComputeSubjectDigest(subject)
	if err != nil {
		t.Fatal(err)
	}
	const goldenSubjectDigest = "69748646b1df4590da7b76f7fef8748a7996f1f5349b80ecf59d0f9355ede7c1"
	if first == firstSubject || !isLowerHex(firstSubject, 64) || firstSubject != goldenSubjectDigest {
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
		BundleSHA256: strings.Repeat("1", 64), TemplateVersion: "agx/bootstrap/v1", TemplateSetSHA256: strings.Repeat("2", 64),
		ProviderProfile: "core", SelectedProviders: []string{"claude", "codex"},
		ControlRepository:     domain.RepositoryBindingV1{IdentitySHA256: strings.Repeat("3", 64), RenderedContentSHA256: strings.Repeat("4", 64)},
		ContractsRepository:   domain.RepositoryBindingV1{IdentitySHA256: strings.Repeat("5", 64), RenderedContentSHA256: strings.Repeat("6", 64)},
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

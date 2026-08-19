package domain_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/domain"
)

const testTimestamp = "2026-08-19T00:00:00Z"

func githubObservation(kind domain.ObservationKind, installationID domain.InstallationID, evidenceID string, status domain.ObservationStatus) domain.Observation {
	return domain.Observation{
		Source:         domain.ObservationSourceGitHub,
		Kind:           kind,
		InstallationID: installationID,
		ResourceID:     "resource-" + string(kind),
		EvidenceID:     evidenceID,
		Status:         status,
		SchemaVersion:  domain.ObservationSchemaVersion,
		ObservedAt:     testTimestamp,
	}
}

func multicaObservation(kind domain.ObservationKind, installationID domain.InstallationID, evidenceID string, status domain.ObservationStatus) domain.Observation {
	return domain.Observation{
		Source:         domain.ObservationSourceMultica,
		Kind:           kind,
		InstallationID: installationID,
		ResourceID:     "resource-" + string(kind),
		EvidenceID:     evidenceID,
		Status:         status,
		SchemaVersion:  domain.ObservationSchemaVersion,
		ObservedAt:     testTimestamp,
	}
}

func fullGitHubDeliveryObservations(installationID domain.InstallationID) []domain.Observation {
	return []domain.Observation{
		githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusSatisfied),
		githubObservation(domain.ObservationKindGitHubContractIssue, installationID, "issue-1", domain.ObservationStatusSatisfied),
		githubObservation(domain.ObservationKindGitHubFirstWrite, installationID, "first-write-1", domain.ObservationStatusSatisfied),
		githubObservation(domain.ObservationKindGitHubDelivery, installationID, "pr-1", domain.ObservationStatusSatisfied),
		githubObservation(domain.ObservationKindGitHubChecks, installationID, "checks-1", domain.ObservationStatusSatisfied),
	}
}

func fullMulticaObservations(installationID domain.InstallationID) []domain.Observation {
	return []domain.Observation{
		multicaObservation(domain.ObservationKindMulticaWorkspace, installationID, "workspace-1", domain.ObservationStatusSatisfied),
		multicaObservation(domain.ObservationKindMulticaRuntime, installationID, "runtime-1", domain.ObservationStatusSatisfied),
		multicaObservation(domain.ObservationKindMulticaAgent, installationID, "agent-1", domain.ObservationStatusSatisfied),
		multicaObservation(domain.ObservationKindMulticaTaskRun, installationID, "task-1", domain.ObservationStatusSatisfied),
	}
}

// 1. github-delivery/v1 全部事实匹配 → verified.
func TestEvaluateGitHubDeliveryV1FullMatchIsVerified(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, fullGitHubDeliveryObservations(installationID))
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if receipt.Phase != domain.PhaseVerified {
		t.Fatalf("phase = %q, want %q; receipt = %+v", receipt.Phase, domain.PhaseVerified, receipt)
	}
	if len(receipt.Missing) != 0 {
		t.Fatalf("missing = %+v, want none", receipt.Missing)
	}
	if len(receipt.Satisfied) != 5 {
		t.Fatalf("satisfied = %+v, want 5 kinds", receipt.Satisfied)
	}
	if receipt.ProfileID != domain.EvidenceProfileGitHubDeliveryV1 || receipt.EvaluatorVersion != domain.CurrentEvaluatorVersion {
		t.Fatalf("receipt metadata = %+v", receipt)
	}
}

// 2. GitHub first-write, PR/result 或 CI/verifier 任一缺失 → awaiting_verification, 并给出精确下一步.
func TestEvaluateGitHubDeliveryV1MissingAnyRequirementIsAwaitingWithNextStep(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	full := fullGitHubDeliveryObservations(installationID)
	for _, drop := range []domain.ObservationKind{
		domain.ObservationKindGitHubProject,
		domain.ObservationKindGitHubContractIssue,
		domain.ObservationKindGitHubFirstWrite,
		domain.ObservationKindGitHubDelivery,
		domain.ObservationKindGitHubChecks,
	} {
		t.Run(string(drop), func(t *testing.T) {
			var partial []domain.Observation
			for _, obs := range full {
				if obs.Kind != drop {
					partial = append(partial, obs)
				}
			}
			receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, partial)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			if receipt.Phase != domain.PhaseAwaitingVerification {
				t.Fatalf("phase = %q, want %q", receipt.Phase, domain.PhaseAwaitingVerification)
			}
			if len(receipt.Missing) != 1 || receipt.Missing[0].Kind != drop || receipt.Missing[0].NextStep == "" {
				t.Fatalf("missing = %+v, want exactly %q with a next step", receipt.Missing, drop)
			}
		})
	}
}

// 3. multica-execution/v1 全部 GitHub + Multica 事实匹配 → verified.
func TestEvaluateMulticaExecutionV1FullMatchIsVerified(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	observations := append(fullGitHubDeliveryObservations(installationID), fullMulticaObservations(installationID)...)
	receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileMulticaExecutionV1, domain.CurrentEvaluatorVersion, observations)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if receipt.Phase != domain.PhaseVerified {
		t.Fatalf("phase = %q, want %q; receipt = %+v", receipt.Phase, domain.PhaseVerified, receipt)
	}
	if len(receipt.Satisfied) != 9 {
		t.Fatalf("satisfied = %+v, want 9 kinds", receipt.Satisfied)
	}
}

// 4. Multica profile 缺 Workspace、Runtime、Agent 或 Task/Run 任一事实 → awaiting_verification.
func TestEvaluateMulticaExecutionV1MissingAnyMulticaRequirementIsAwaiting(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	full := append(fullGitHubDeliveryObservations(installationID), fullMulticaObservations(installationID)...)
	for _, drop := range []domain.ObservationKind{
		domain.ObservationKindMulticaWorkspace,
		domain.ObservationKindMulticaRuntime,
		domain.ObservationKindMulticaAgent,
		domain.ObservationKindMulticaTaskRun,
	} {
		t.Run(string(drop), func(t *testing.T) {
			var partial []domain.Observation
			for _, obs := range full {
				if obs.Kind != drop {
					partial = append(partial, obs)
				}
			}
			receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileMulticaExecutionV1, domain.CurrentEvaluatorVersion, partial)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			if receipt.Phase != domain.PhaseAwaitingVerification {
				t.Fatalf("phase = %q, want %q", receipt.Phase, domain.PhaseAwaitingVerification)
			}
			if len(receipt.Missing) != 1 || receipt.Missing[0].Kind != drop {
				t.Fatalf("missing = %+v, want exactly %q", receipt.Missing, drop)
			}
		})
	}
}

// 5. GitHub profile 没有任何 Multica 事实仍可 verified.
func TestEvaluateGitHubDeliveryV1VerifiesWithoutAnyMulticaObservation(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, fullGitHubDeliveryObservations(installationID))
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if receipt.Phase != domain.PhaseVerified {
		t.Fatalf("phase = %q, want %q", receipt.Phase, domain.PhaseVerified)
	}
}

// 6. 发现 Multica 但 profile 为 GitHub 时，不改变结论 -- including when the
// discovered Multica observation is itself malformed/failed, which must not
// leak into the GitHub-only result.
func TestEvaluateGitHubDeliveryV1IgnoresDiscoveredMulticaObservations(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	observations := fullGitHubDeliveryObservations(installationID)
	observations = append(observations, multicaObservation(domain.ObservationKindMulticaRuntime, installationID, "runtime-1", domain.ObservationStatusFailed))
	observations = append(observations, domain.Observation{
		Source: domain.ObservationSourceMultica, Kind: domain.ObservationKindMulticaWorkspace,
		InstallationID: installationID, EvidenceID: "", Status: domain.ObservationStatusSatisfied,
		SchemaVersion: "bogus", ObservedAt: "not-a-timestamp",
	})

	receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, observations)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if receipt.Phase != domain.PhaseVerified {
		t.Fatalf("phase = %q, want %q", receipt.Phase, domain.PhaseVerified)
	}
	if len(receipt.Diagnostics) != 0 {
		t.Fatalf("diagnostics = %+v, want none: out-of-profile observations must not be evaluated at all", receipt.Diagnostics)
	}
}

// 7. Runtime online、Task completed、PR opened、模型分数或 Agent self-report 单独存在时均不能 verified.
func TestEvaluateSingleObservationAloneNeverVerifies(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	cases := map[string]domain.Observation{
		"runtime online alone":    multicaObservation(domain.ObservationKindMulticaRuntime, installationID, "runtime-1", domain.ObservationStatusSatisfied),
		"task completed alone":    multicaObservation(domain.ObservationKindMulticaTaskRun, installationID, "task-1", domain.ObservationStatusSatisfied),
		"PR opened alone":         githubObservation(domain.ObservationKindGitHubDelivery, installationID, "pr-1", domain.ObservationStatusSatisfied),
		"checks passed alone":     githubObservation(domain.ObservationKindGitHubChecks, installationID, "checks-1", domain.ObservationStatusSatisfied),
		"agent self-report alone": githubObservation(domain.ObservationKindGitHubFirstWrite, installationID, "first-write-1", domain.ObservationStatusSatisfied),
	}
	for name, obs := range cases {
		t.Run(name, func(t *testing.T) {
			receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileMulticaExecutionV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			if receipt.Phase == domain.PhaseVerified {
				t.Fatalf("phase = %q, want anything but verified for a single observation", receipt.Phase)
			}
		})
	}
}

// 8. Installation ID 不匹配、空 evidence、模糊匹配、漂移、过期、未知 schema → 拒绝并产生稳定诊断.
func TestEvaluateRejectsInvalidObservationsWithStableDiagnostics(t *testing.T) {
	installationID := domain.InstallationID("install-1")

	t.Run("installation id mismatch", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, "other-install", "project-1", domain.ObservationStatusSatisfied)
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceInstallationMismatch)
		if receipt.Phase == domain.PhaseVerified {
			t.Fatalf("mismatched installation must not verify")
		}
	})

	t.Run("empty evidence id", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "", domain.ObservationStatusSatisfied)
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceEmpty)
	})

	t.Run("ambiguous conflicting observations", func(t *testing.T) {
		observations := []domain.Observation{
			githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusSatisfied),
			githubObservation(domain.ObservationKindGitHubProject, installationID, "project-2", domain.ObservationStatusSatisfied),
		}
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, observations)
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceAmbiguous)
	})

	t.Run("adapter-declared ambiguous status", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusAmbiguous)
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceNotSatisfied)
	})

	t.Run("drifted", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusDrifted)
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceNotSatisfied)
	})

	t.Run("expired", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusExpired)
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceNotSatisfied)
	})

	t.Run("unknown schema version", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusSatisfied)
		obs.SchemaVersion = "agx.observation/v0-unknown"
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceUnknownSchema)
	})

	t.Run("source mismatch", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusSatisfied)
		obs.Source = domain.ObservationSourceMultica
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceSourceMismatch)
	})

	t.Run("malformed timestamp", func(t *testing.T) {
		obs := githubObservation(domain.ObservationKindGitHubProject, installationID, "project-1", domain.ObservationStatusSatisfied)
		obs.ObservedAt = "yesterday"
		receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, []domain.Observation{obs})
		if err != nil {
			t.Fatalf("Evaluate() error = %v", err)
		}
		assertDiagnosticCode(t, receipt, domain.DiagnosticCodeEvidenceMalformedTimestamp)
	})
}

func assertDiagnosticCode(t *testing.T, receipt domain.EvidenceReceipt, want domain.DiagnosticCode) {
	t.Helper()
	for _, d := range receipt.Diagnostics {
		if d.Code == want {
			return
		}
	}
	t.Fatalf("diagnostics = %+v, want one with code %q", receipt.Diagnostics, want)
}

// 9. Observation 顺序变化与重复输入不改变确定性结果.
func TestEvaluateIsOrderIndependentAndIdempotentUnderDuplicates(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	base := fullGitHubDeliveryObservations(installationID)

	forward, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, base)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}

	reversed := make([]domain.Observation, len(base))
	for i, obs := range base {
		reversed[len(base)-1-i] = obs
	}
	backward, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, reversed)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}

	duplicated := append(append([]domain.Observation{}, base...), base...)
	withDuplicates, err := domain.Evaluate(installationID, domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, duplicated)
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}

	forwardJSON, _ := json.Marshal(forward)
	backwardJSON, _ := json.Marshal(backward)
	duplicatesJSON, _ := json.Marshal(withDuplicates)
	if string(forwardJSON) != string(backwardJSON) {
		t.Fatalf("result changed under reordering:\n%s\nvs\n%s", forwardJSON, backwardJSON)
	}
	if string(forwardJSON) != string(duplicatesJSON) {
		t.Fatalf("result changed under duplication:\n%s\nvs\n%s", forwardJSON, duplicatesJSON)
	}
}

// 10. legacy receipt 可读，但不会被静默升级为新 profile receipt.
func TestLegacyVerifiedReceiptRemainsReadableAndUnrelatedToEvaluate(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	legacy, err := domain.NewVerifiedReceipt(installationID, domain.Verification{
		GitHub: domain.Readback{
			Source: domain.ReadbackSourceGitHub, InstallationID: installationID, EvidenceID: "github-issue-42",
		},
		Multica: domain.Readback{
			Source: domain.ReadbackSourceMultica, InstallationID: installationID, EvidenceID: "multica-task-7",
		},
	})
	if err != nil {
		t.Fatalf("NewVerifiedReceipt() error = %v", err)
	}
	if legacy.Phase != domain.PhaseVerified {
		t.Fatalf("legacy receipt phase = %q, want %q", legacy.Phase, domain.PhaseVerified)
	}

	// The legacy receipt has no evidence profile or evaluator version: it
	// must not be reinterpreted as an EvidenceReceipt, and Evaluate must
	// not be able to derive one from it implicitly.
	if legacy.Verification.GitHub.EvidenceID == "" || legacy.Verification.Multica.EvidenceID == "" {
		t.Fatalf("legacy receipt lost its readbacks: %+v", legacy)
	}

	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	var decoded domain.Receipt
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if decoded != legacy {
		t.Fatalf("legacy receipt round trip = %+v, want %+v", decoded, legacy)
	}
}

// 11. JSON round-trip 保留 profile/evaluator/schema version 和 evidence 摘要，不包含凭据或用户绝对路径.
func TestEvidenceReceiptJSONRoundTripPreservesMetadataAndCarriesNoSensitiveFields(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	want, err := domain.Evaluate(installationID, domain.EvidenceProfileMulticaExecutionV1, domain.CurrentEvaluatorVersion,
		append(fullGitHubDeliveryObservations(installationID), fullMulticaObservations(installationID)[:2]...))
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}

	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	raw := string(encoded)
	lowered := strings.ToLower(raw)
	for _, forbidden := range []string{"token", "cookie", "oauth", "password", "c:\\", "/home/", "/users/"} {
		if strings.Contains(lowered, forbidden) {
			t.Fatalf("encoded receipt contains forbidden substring %q: %s", forbidden, raw)
		}
	}

	var got domain.EvidenceReceipt
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if got.ProfileID != want.ProfileID || got.EvaluatorVersion != want.EvaluatorVersion || got.Phase != want.Phase {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	if len(got.Missing) != len(want.Missing) {
		t.Fatalf("missing round trip = %+v, want %+v", got.Missing, want.Missing)
	}
}

// 12. Adapter contract tests only verify structured input/output elsewhere
// (multica/repository packages); this file only covers the domain seam.

// Explicit profile selection: unknown profile IDs fail closed rather than
// silently falling back to a default.
func TestEvaluateRejectsUnknownProfile(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	if _, err := domain.Evaluate(installationID, domain.EvidenceProfileID("not-a-real-profile"), domain.CurrentEvaluatorVersion, nil); err == nil {
		t.Fatal("expected an error for an unknown evidence profile")
	}
}

func TestEvaluateRejectsMissingInstallationIDOrEvaluatorVersion(t *testing.T) {
	if _, err := domain.Evaluate("", domain.EvidenceProfileGitHubDeliveryV1, domain.CurrentEvaluatorVersion, nil); err == nil {
		t.Fatal("expected an error for an empty installation ID")
	}
	if _, err := domain.Evaluate("install-1", domain.EvidenceProfileGitHubDeliveryV1, "", nil); err == nil {
		t.Fatal("expected an error for an empty evaluator version")
	}
}

func TestKnownEvidenceProfile(t *testing.T) {
	if !domain.KnownEvidenceProfile(domain.EvidenceProfileGitHubDeliveryV1) {
		t.Error("github-delivery/v1 should be known")
	}
	if !domain.KnownEvidenceProfile(domain.EvidenceProfileMulticaExecutionV1) {
		t.Error("multica-execution/v1 should be known")
	}
	if domain.KnownEvidenceProfile(domain.EvidenceProfileID("unknown/v1")) {
		t.Error("an unregistered profile must not be reported as known")
	}
}

// multica-execution/v1 must compose every github-delivery/v1 requirement,
// per #54's contract, not redeclare a parallel but divergent list.
func TestMulticaExecutionV1ComposesGitHubDeliveryV1Requirements(t *testing.T) {
	installationID := domain.InstallationID("install-1")
	// Only the GitHub half is present; Multica-only kinds are missing.
	receipt, err := domain.Evaluate(installationID, domain.EvidenceProfileMulticaExecutionV1, domain.CurrentEvaluatorVersion, fullGitHubDeliveryObservations(installationID))
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if len(receipt.Satisfied) != 5 {
		t.Fatalf("satisfied = %+v, want the 5 github-delivery/v1 kinds carried over", receipt.Satisfied)
	}
	if len(receipt.Missing) != 4 {
		t.Fatalf("missing = %+v, want exactly the 4 multica-only kinds", receipt.Missing)
	}
}

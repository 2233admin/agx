package domain_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/2233admin/agx/internal/domain"
)

func TestNewVerifiedReceiptAcceptsMatchingGitHubAndMulticaReadbacks(t *testing.T) {
	installationID := domain.InstallationID("install-001")

	receipt, err := domain.NewVerifiedReceipt(installationID, domain.Verification{
		GitHub: domain.Readback{
			Source:         domain.ReadbackSourceGitHub,
			InstallationID: installationID,
			EvidenceID:     "github-issue-42",
		},
		Multica: domain.Readback{
			Source:         domain.ReadbackSourceMultica,
			InstallationID: installationID,
			EvidenceID:     "multica-task-7",
		},
	})
	if err != nil {
		t.Fatalf("NewVerifiedReceipt() error = %v", err)
	}

	if receipt.Phase != domain.PhaseVerified {
		t.Fatalf("receipt phase = %q, want %q", receipt.Phase, domain.PhaseVerified)
	}
}

func TestInstallationContractsRoundTrip(t *testing.T) {
	installationID := domain.InstallationID("install-001")
	receipt, err := domain.NewVerifiedReceipt(installationID, domain.Verification{
		GitHub: domain.Readback{
			Source:         domain.ReadbackSourceGitHub,
			InstallationID: installationID,
			EvidenceID:     "github-issue-42",
		},
		Multica: domain.Readback{
			Source:         domain.ReadbackSourceMultica,
			InstallationID: installationID,
			EvidenceID:     "multica-task-7",
		},
	})
	if err != nil {
		t.Fatalf("NewVerifiedReceipt() error = %v", err)
	}

	want := domain.InstallationContract{
		Desired: domain.DesiredState{
			InstallationID: installationID,
			BundleID:       "bundle-001",
			DesiredHash:    "sha256:desired",
			Ownership:      domain.OwnershipUser,
			Idempotency:    domain.IdempotencySafe,
			Risk:           domain.RiskReversible,
		},
		Observed: domain.ObservedState{
			InstallationID: installationID,
			Phase:          domain.PhaseVerified,
			Verification:   receipt.Verification,
		},
		Plan: domain.Plan{
			InstallationID: installationID,
			DesiredHash:    "sha256:desired",
			Steps: []domain.Step{{
				ID:           "step-001",
				Kind:         domain.StepKindConfigure,
				Risk:         domain.RiskReversible,
				Compensation: domain.CompensationRollback,
			}},
		},
		StepResults: []domain.StepResult{{
			StepID: "step-001",
			Phase:  domain.PhaseConfigured,
		}},
		Diagnostics: []domain.Diagnostic{{
			Code:     "AGX-PREFLIGHT-001",
			Category: domain.DiagnosticCategoryPreflight,
			Severity: domain.SeverityWarning,
			Message:  "runtime is not connected",
		}},
		Receipt: receipt,
	}

	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	var got domain.InstallationContract
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip = %#v, want %#v", got, want)
	}
}

func TestNewVerifiedReceiptRejectsIncompleteOrMismatchedReadbacks(t *testing.T) {
	installationID := domain.InstallationID("install-001")
	valid := domain.Verification{
		GitHub: domain.Readback{
			Source:         domain.ReadbackSourceGitHub,
			InstallationID: installationID,
			EvidenceID:     "github-issue-42",
		},
		Multica: domain.Readback{
			Source:         domain.ReadbackSourceMultica,
			InstallationID: installationID,
			EvidenceID:     "multica-task-7",
		},
	}

	tests := []struct {
		name         string
		verification domain.Verification
	}{
		{
			name: "missing GitHub source",
			verification: domain.Verification{
				GitHub:  domain.Readback{InstallationID: installationID, EvidenceID: "github-issue-42"},
				Multica: valid.Multica,
			},
		},
		{
			name: "mismatched Multica installation",
			verification: domain.Verification{
				GitHub: valid.GitHub,
				Multica: domain.Readback{
					Source:         domain.ReadbackSourceMultica,
					InstallationID: "install-other",
					EvidenceID:     "multica-task-7",
				},
			},
		},
		{
			name: "missing Multica evidence",
			verification: domain.Verification{
				GitHub:  valid.GitHub,
				Multica: domain.Readback{Source: domain.ReadbackSourceMultica, InstallationID: installationID},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := domain.NewVerifiedReceipt(installationID, test.verification); err == nil {
				t.Fatal("NewVerifiedReceipt() error = nil, want rejection")
			}
		})
	}
}

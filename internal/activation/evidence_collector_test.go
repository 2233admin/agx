package activation_test

import (
	"context"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/domain"
	"github.com/2233admin/agx/internal/project"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
)

func initializedGitHubDeliveryReceipt(t *testing.T, root string, providerRunner provider.Runner, repositoryRunner *deploymentRepositoryRunner) activation.Receipt {
	t.Helper()
	receipt, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	return receipt
}

// 1. Before the Agent has done any first-use work, only the repositories and
// Project are confirmed: the collector must not fabricate the remaining
// requirements, and status must stay awaiting_verification.
func TestGitHubEvidenceCollectorOmitsUnstartedFirstUseWork(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	receipt := initializedGitHubDeliveryReceipt(t, root, providerRunner, repositoryRunner)

	batch := activation.NewGitHubEvidenceCollector(repositoryRunner).Collect(context.Background(), receipt)
	if len(batch.Diagnostics) != 0 {
		t.Fatalf("Collect() diagnostics = %+v, want none for an unstarted (not yet failed) installation", batch.Diagnostics)
	}
	kinds := map[domain.EvidenceKind]bool{}
	for _, observation := range batch.Observations {
		kinds[observation.Kind] = true
	}
	if !kinds[domain.EvidenceGitHubControlRepository] || !kinds[domain.EvidenceGitHubContractsRepository] || !kinds[domain.EvidenceGitHubProject] {
		t.Fatalf("Collect() kinds = %+v, want repositories and Project already confirmed", kinds)
	}
	for _, missing := range []domain.EvidenceKind{
		domain.EvidenceGitHubContractIssue, domain.EvidenceGitHubProjectItem, domain.EvidenceGitHubCurrentWork,
		domain.EvidenceGitHubDeliveryPROpen, domain.EvidenceGitHubChecksPassed,
	} {
		if kinds[missing] {
			t.Fatalf("Collect() reported %q before the Agent did any first-use work", missing)
		}
	}

	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		Collectors: []activation.EvidenceCollector{activation.NewGitHubEvidenceCollector(repositoryRunner)},
	}, repositoryRunner)
	if err != nil {
		t.Fatalf("StatusWithEvidence() error = %v", err)
	}
	if state.Evidence.Phase != domain.PhaseAwaitingVerification {
		t.Fatalf("phase = %q, want %q; evidence=%+v", state.Evidence.Phase, domain.PhaseAwaitingVerification, state.Evidence)
	}
	if len(state.Evidence.Missing) == 0 {
		t.Fatal("expected missing requirements before first-use work is done")
	}
}

// 2. Once the Agent completes the Bootstrap Verification Issue, Project item,
// current-work pointer, delivery PR, and passing checks, the collector must
// report every requirement and StatusWithEvidence must reach verified.
func TestGitHubEvidenceCollectorReachesVerifiedAfterFirstUseCompletes(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	receipt := initializedGitHubDeliveryReceipt(t, root, providerRunner, repositoryRunner)
	repositoryRunner.smokeComplete = true

	batch := activation.NewGitHubEvidenceCollector(repositoryRunner).Collect(context.Background(), receipt)
	if len(batch.Diagnostics) != 0 {
		t.Fatalf("Collect() diagnostics = %+v, want none", batch.Diagnostics)
	}
	wantKinds := []domain.EvidenceKind{
		domain.EvidenceGitHubControlRepository, domain.EvidenceGitHubContractsRepository, domain.EvidenceGitHubProject,
		domain.EvidenceGitHubProjectItem, domain.EvidenceGitHubContractIssue, domain.EvidenceGitHubCurrentWork,
		domain.EvidenceGitHubDeliveryPROpen, domain.EvidenceGitHubChecksPassed,
	}
	if len(batch.Observations) != len(wantKinds) {
		t.Fatalf("Collect() observations = %+v, want exactly %d kinds", batch.Observations, len(wantKinds))
	}
	seen := map[domain.EvidenceKind]domain.EvidenceObservation{}
	for _, observation := range batch.Observations {
		seen[observation.Kind] = observation
		if observation.InstallationID != domain.InstallationID(receipt.InstallationID) {
			t.Fatalf("observation %q installation = %q, want %q", observation.Kind, observation.InstallationID, receipt.InstallationID)
		}
		if observation.DeploymentDigest != receipt.DeploymentDigest || observation.SubjectDigest != receipt.SubjectDigest {
			t.Fatalf("observation %q digests = %+v, want receipt digests", observation.Kind, observation)
		}
		if observation.Outcome != domain.ObservationMatched {
			t.Fatalf("observation %q outcome = %q, want matched", observation.Kind, observation.Outcome)
		}
	}
	for _, kind := range wantKinds {
		if _, ok := seen[kind]; !ok {
			t.Fatalf("Collect() missing kind %q; got %+v", kind, seen)
		}
	}
	// The delivery PR, checks, and current-work pointer are one work item and
	// must correlate on the same revision.
	revision := seen[domain.EvidenceGitHubDeliveryPROpen].Ref.Revision
	if revision == "" || seen[domain.EvidenceGitHubChecksPassed].Ref.Revision != revision ||
		seen[domain.EvidenceGitHubCurrentWork].Ref.Revision != revision {
		t.Fatalf("correlated revisions do not match: %+v", seen)
	}

	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		Collectors: []activation.EvidenceCollector{activation.NewGitHubEvidenceCollector(repositoryRunner)},
	}, repositoryRunner)
	if err != nil {
		t.Fatalf("StatusWithEvidence() error = %v", err)
	}
	if state.Evidence.Phase != domain.PhaseVerified {
		t.Fatalf("phase = %q, want %q; evidence=%+v", state.Evidence.Phase, domain.PhaseVerified, state.Evidence)
	}
	if len(state.Evidence.Missing) != 0 {
		t.Fatalf("missing = %+v, want none", state.Evidence.Missing)
	}
}

// 3. Discovering Multica evidence never changes the github-delivery/v1
// result: the GitHub collector alone must still reach verified when no
// Multica collector is present at all.
func TestGitHubEvidenceCollectorAloneIsSufficientForGitHubDeliveryV1(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	repositoryRunner.smokeComplete = true
	initializedGitHubDeliveryReceipt(t, root, providerRunner, repositoryRunner)

	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		Collectors: []activation.EvidenceCollector{activation.NewGitHubEvidenceCollector(repositoryRunner)},
	}, repositoryRunner)
	if err != nil {
		t.Fatalf("StatusWithEvidence() error = %v", err)
	}
	if state.Evidence.Phase != domain.PhaseVerified {
		t.Fatalf("phase = %q, want %q without any Multica collector", state.Evidence.Phase, domain.PhaseVerified)
	}
}

// 4. A repository whose persisted receipt is not readback-verified, was
// never created, or has no initial commit must never be reported Matched.
func TestGitHubEvidenceCollectorRejectsUncertainRepository(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	repositoryRunner.smokeComplete = true
	receipt := initializedGitHubDeliveryReceipt(t, root, providerRunner, repositoryRunner)

	tests := map[string]func(*repository.Receipt){
		"uncertain verification": func(r *repository.Receipt) { r.Verification = repository.VerificationUncertain },
		"not created":            func(r *repository.Receipt) { r.Created = false },
		"empty initial commit":   func(r *repository.Receipt) { r.InitialCommit = "" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			mutated := receipt
			mutated.Repositories = append([]repository.Receipt(nil), receipt.Repositories...)
			mutate(&mutated.Repositories[0])

			batch := activation.NewGitHubEvidenceCollector(repositoryRunner).Collect(context.Background(), mutated)
			for _, observation := range batch.Observations {
				if observation.Kind == domain.EvidenceGitHubControlRepository {
					t.Fatalf("Collect() reported the control repository as matched despite %s: %+v", name, observation)
				}
			}
		})
	}
}

// 5. A Project that is not linked or not readback-verified must never be
// reported Matched.
func TestGitHubEvidenceCollectorRejectsUnlinkedProject(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	receipt := initializedGitHubDeliveryReceipt(t, root, providerRunner, repositoryRunner)

	tests := map[string]func(*project.Receipt){
		"unverified linkage": func(p *project.Receipt) { p.Verification = project.VerificationCreated },
		"not linked":         func(p *project.Receipt) { p.Linked = false },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			mutated := receipt
			projectCopy := *receipt.Project
			mutate(&projectCopy)
			mutated.Project = &projectCopy

			batch := activation.NewGitHubEvidenceCollector(repositoryRunner).Collect(context.Background(), mutated)
			for _, observation := range batch.Observations {
				if observation.Kind == domain.EvidenceGitHubProject {
					t.Fatalf("Collect() reported the Project as matched despite %s: %+v", name, observation)
				}
			}
		})
	}
}

// 6. Legacy (pre-v4) receipts never trigger any GitHub call at all: the
// collector must return immediately.
func TestGitHubEvidenceCollectorIgnoresLegacyReceipt(t *testing.T) {
	runner := newDeploymentRepositoryRunner()
	legacy := activation.Receipt{SchemaVersion: "agx.initialization/v3", InstallationID: "install-0123456789abcdef"}

	batch := activation.NewGitHubEvidenceCollector(runner).Collect(context.Background(), legacy)
	if len(batch.Observations) != 0 || len(batch.Diagnostics) != 0 {
		t.Fatalf("Collect() = %+v, want an empty batch for a legacy receipt", batch)
	}
	if runner.runCalls != 0 {
		t.Fatalf("Collect() made %d GitHub calls for a legacy receipt, want zero", runner.runCalls)
	}
}

// 7. A genuine adapter failure (first-use readback errors) is reported as a
// collector Diagnostic rather than silently treated as absent evidence, and
// StatusWithEvidence surfaces the dedicated collector-failed diagnostic code.
func TestGitHubEvidenceCollectorReportsDiagnosticOnReadbackFailure(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	receipt := initializedGitHubDeliveryReceipt(t, root, providerRunner, repositoryRunner)
	repositoryRunner.smokeComplete = true
	repositoryRunner.failIssueList = true

	batch := activation.NewGitHubEvidenceCollector(repositoryRunner).Collect(context.Background(), receipt)
	if len(batch.Diagnostics) == 0 {
		t.Fatal("Collect() diagnostics = none, want a collector failure diagnostic")
	}

	state, err := activation.StatusWithEvidence(context.Background(), root, providerRunner, activation.StatusOptions{
		Collectors: []activation.EvidenceCollector{activation.NewGitHubEvidenceCollector(repositoryRunner)},
	}, repositoryRunner)
	if err != nil {
		t.Fatalf("StatusWithEvidence() error = %v", err)
	}
	found := false
	for _, diagnostic := range state.Evidence.Diagnostics {
		if diagnostic.Code == "AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED" {
			found = true
		}
	}
	if !found {
		t.Fatalf("evidence diagnostics = %+v, want AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED", state.Evidence.Diagnostics)
	}
	if state.Evidence.Phase == domain.PhaseVerified {
		t.Fatal("phase must not be verified when the GitHub collector failed")
	}
}

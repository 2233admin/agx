package activation

import (
	"context"
	"strconv"
	"time"

	"github.com/2233admin/agx/internal/domain"
	"github.com/2233admin/agx/internal/project"
	"github.com/2233admin/agx/internal/repository"
	"github.com/2233admin/agx/internal/smoke"
)

// githubEvidenceCollector converts an installation's already-recorded GitHub
// deployment (repositories, Project) and a live first-use readback (contract
// Issue, Project item, current-work pointer, delivery PR, checks) into
// domain.EvidenceObservation values for the Evidence Evaluator.
//
// It reuses the exact structured readback #42 established — repository.Verify,
// project.Verify, and smoke.Inspect — rather than inventing new GitHub calls.
// It never reports an observation for state it cannot positively confirm: a
// repository, Project, Issue, Project item, delivery PR, or check set that is
// uncertain, not created, drifted, or simply not there yet is left out of the
// batch entirely, so the corresponding requirement stays Missing (awaiting
// verification) instead of being claimed Matched or escalated to a blocked
// outcome. Only a genuine adapter failure (the first-use contract cannot be
// built, or the GitHub readback call itself errors) is reported as a
// collector Diagnostic.
type githubEvidenceCollector struct {
	runner repository.Runner
}

// NewGitHubEvidenceCollector returns the production GitHub EvidenceCollector.
// runner may be nil; repository.Verify, project.Verify, and smoke.Inspect all
// fall back to the real gh/git CLI in that case.
func NewGitHubEvidenceCollector(runner repository.Runner) EvidenceCollector {
	return githubEvidenceCollector{runner: runner}
}

func (githubEvidenceCollector) Source() domain.EvidenceSource { return domain.EvidenceSourceGitHub }

func (c githubEvidenceCollector) Collect(ctx context.Context, receipt Receipt) domain.ObservationBatch {
	if receipt.SchemaVersion != receiptSchemaV4 || receipt.DeploymentBinding == nil ||
		receipt.DeploymentDigest == "" || receipt.SubjectDigest == "" {
		return domain.ObservationBatch{}
	}

	now := time.Now().UTC()
	var observations []domain.EvidenceObservation
	add := func(kind domain.EvidenceKind, resourceType domain.EvidenceResourceType, identity string, number uint64, revision, fingerprintSeed string) {
		observations = append(observations, domain.EvidenceObservation{
			SchemaVersion: domain.EvidenceObservationSchemaV1, EvaluatorVersion: domain.EvidenceEvaluatorV1,
			Source: domain.EvidenceSourceGitHub, Kind: kind,
			InstallationID:   domain.InstallationID(receipt.InstallationID),
			DeploymentDigest: receipt.DeploymentDigest, SubjectDigest: receipt.SubjectDigest,
			Ref:         domain.EvidenceRef{ResourceType: resourceType, IdentitySHA256: identity, Number: number, Revision: revision},
			Fingerprint: domain.NamespacedIdentitySHA256("github", string(resourceType), fingerprintSeed),
			Outcome:     domain.ObservationMatched, ObservedAt: now,
		})
	}

	for index, item := range receipt.Repositories {
		if item.Verification != repository.VerificationReadback || !item.Created || item.InitialCommit == "" {
			continue
		}
		if repository.Verify(ctx, item, c.runner) != nil {
			continue
		}
		kind := domain.EvidenceGitHubControlRepository
		identity := receipt.DeploymentBinding.ControlRepository.IdentitySHA256
		if index == 1 {
			kind = domain.EvidenceGitHubContractsRepository
			identity = receipt.DeploymentBinding.ContractsRepository.IdentitySHA256
		}
		add(kind, domain.ResourceRepository, identity, 0, "", item.NameWithOwner+"|"+item.InitialCommit+"|"+item.TemplateDigest)
	}

	if receipt.Project != nil && receipt.Project.Linked && receipt.Project.Verification == project.VerificationReadback {
		target := buildProjectTarget(Options{
			GitHubOwner: receipt.GitHubOwner, ControlRepository: receipt.ControlRepository, Visibility: receipt.Visibility,
		}, receipt.InstallationID)
		if project.Verify(ctx, target, *receipt.Project, c.runner) == nil {
			add(domain.EvidenceGitHubProject, domain.ResourceProject, receipt.DeploymentBinding.ProjectIdentitySHA256, 0, "",
				receipt.Project.URL+"|"+receipt.Project.NodeID)
		}
	}

	contract, contractErr := FirstUseContract(receipt)
	if contractErr != nil {
		return domain.ObservationBatch{Observations: observations}
	}
	evidence, inspectErr := smoke.Inspect(ctx, contract, c.runner)
	if inspectErr != nil {
		return domain.ObservationBatch{
			Observations: observations,
			Diagnostics: []domain.Diagnostic{{
				Code: "AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED", Category: domain.DiagnosticCategoryPreflight,
				Severity: domain.SeverityError, Message: "GitHub first-use readback failed",
			}},
		}
	}

	branchIdentity := domain.NamespacedIdentitySHA256("github", "branch", contract.Branch)
	checkIdentity := domain.NamespacedIdentitySHA256("github", "check", contract.ValidationCheck)

	if evidence.IssueURL != "" && evidence.IssueNumber > 0 {
		add(domain.EvidenceGitHubContractIssue, domain.ResourceIssue, "", uint64(evidence.IssueNumber), "",
			contract.IssueTitle+"|"+strconv.Itoa(evidence.IssueNumber))
	}
	if evidence.ProjectItem != "" {
		add(domain.EvidenceGitHubProjectItem, domain.ResourceProjectItem,
			domain.NamespacedIdentitySHA256("github", "project_item", evidence.ProjectItem), 0, "", evidence.ProjectItem)
	}
	if evidence.WorkPointer != "" && evidence.Revision != "" {
		add(domain.EvidenceGitHubCurrentWork, domain.ResourceCommit, branchIdentity, 0, evidence.Revision,
			contract.Branch+"|"+evidence.Revision)
	}
	if evidence.PullRequestURL != "" && evidence.PullRequestNumber > 0 && evidence.Revision != "" {
		add(domain.EvidenceGitHubDeliveryPROpen, domain.ResourcePullRequest, "", uint64(evidence.PullRequestNumber), evidence.Revision,
			contract.PullRequestTitle+"|"+strconv.Itoa(evidence.PullRequestNumber))
	}
	if evidence.ValidationResult == "passed" && evidence.Revision != "" {
		add(domain.EvidenceGitHubChecksPassed, domain.ResourceCheck, checkIdentity, 0, evidence.Revision,
			contract.ValidationCheck+"|"+evidence.Revision)
	}

	return domain.ObservationBatch{Observations: observations}
}

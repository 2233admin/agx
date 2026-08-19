// Package activation initializes an installed Bundle for provider use while
// retaining enough ownership evidence to reverse only AGX-created objects.
package activation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/domain"
	installer "github.com/2233admin/agx/internal/install"
	"github.com/2233admin/agx/internal/project"
	"github.com/2233admin/agx/internal/provider"
	"github.com/2233admin/agx/internal/repository"
	"github.com/2233admin/agx/internal/smoke"
)

const (
	receiptSchemaV2    = "agx.initialization/v2"
	receiptSchemaV3    = "agx.initialization/v3"
	receiptSchemaV4    = "agx.initialization/v4"
	receiptSchema      = receiptSchemaV3
	initializationFile = "initialization.json"
	PhaseInitialized   = "initialized"
	PhaseProvisioning  = "provisioning"
	PhaseNeedsResume   = "needs_resume"
	PhaseManualCleanup = "needs_manual_cleanup"
	StatusAbsent       = "absent"
	StatusDrifted      = "drifted"
)

type Profile string

const (
	ProfileCore   Profile = "core"
	ProfileGitHub Profile = "github"
	ProfileTeam   Profile = "team"
	ProfileFull   Profile = "full"
)

var corePlugins = []string{
	"grilling",
	"self-improvement",
	"knowledge-maintenance",
	"adaptive-problem-solving",
}

func ParseProfile(value string) (Profile, error) {
	profile := Profile(strings.ToLower(strings.TrimSpace(value)))
	switch profile {
	case ProfileCore, ProfileGitHub, ProfileTeam, ProfileFull:
		return profile, nil
	default:
		return "", fmt.Errorf("AGX-INIT-PROFILE: unsupported profile %q", value)
	}
}

func Plugins(profile Profile) ([]string, error) {
	plugins := append([]string(nil), corePlugins...)
	switch profile {
	case ProfileCore:
	case ProfileGitHub:
		plugins = append(plugins, "github-collaboration")
	case ProfileTeam:
		plugins = append(plugins, "github-collaboration", "orchestrated-collaboration")
	case ProfileFull:
		plugins = append(plugins, "github-collaboration", "orchestrated-collaboration", "resource-observability")
	default:
		return nil, fmt.Errorf("AGX-INIT-PROFILE: unsupported profile %q", profile)
	}
	return plugins, nil
}

type ProviderReceipt struct {
	Name             provider.Name `json:"name"`
	MarketplaceAdded bool          `json:"marketplace_added"`
	SelectedPlugins  []string      `json:"selected_plugins"`
	AddedPlugins     []string      `json:"added_plugins"`
}

type Receipt struct {
	SchemaVersion         string                      `json:"schema_version"`
	InstallationID        string                      `json:"installation_id"`
	Phase                 string                      `json:"phase"`
	GitHubOwner           string                      `json:"github_owner,omitempty"`
	ControlRepository     string                      `json:"control_repository,omitempty"`
	ContractsRepository   string                      `json:"contracts_repository,omitempty"`
	Visibility            repository.Visibility       `json:"visibility,omitempty"`
	TemplateVersion       string                      `json:"template_version,omitempty"`
	TemplateContentSHA256 string                      `json:"template_content_sha256,omitempty"`
	Profile               Profile                     `json:"profile"`
	EvidenceProfile       domain.EvidenceProfileID    `json:"evidence_profile,omitempty"`
	DeploymentBinding     *domain.DeploymentBindingV1 `json:"deployment_binding,omitempty"`
	DeploymentDigest      string                      `json:"deployment_digest,omitempty"`
	SubjectBinding        *domain.SubjectBindingV1    `json:"subject_binding,omitempty"`
	SubjectDigest         string                      `json:"subject_digest,omitempty"`
	Repositories          []repository.Receipt        `json:"repositories,omitempty"`
	Project               *project.Receipt            `json:"project,omitempty"`
	Providers             []ProviderReceipt           `json:"providers"`
}

type State struct {
	Status            string                 `json:"status"`
	Profile           Profile                `json:"profile,omitempty"`
	Providers         []provider.Name        `json:"providers,omitempty"`
	Repositories      []string               `json:"repositories,omitempty"`
	RepositoryDetails []repository.Receipt   `json:"repository_details,omitempty"`
	Project           *project.Receipt       `json:"project,omitempty"`
	Smoke             smoke.Evidence         `json:"smoke,omitempty"`
	Evidence          domain.EvidenceReceipt `json:"evidence"`
	Problems          []string               `json:"problems,omitempty"`
}

type Options struct {
	Root                string
	GitHubOwner         string
	ControlRepository   string
	ContractsRepository string
	Visibility          repository.Visibility
	Profile             Profile
	EvidenceProfile     domain.EvidenceProfileID
	MulticaWorkspaceID  string
	MulticaRuntimeID    string
	MulticaAgentID      string
	Providers           []provider.Name
	Runner              provider.Runner
	RepositoryRunner    repository.Runner
}

type EvidenceCollector interface {
	Source() domain.EvidenceSource
	Collect(context.Context, Receipt) domain.ObservationBatch
}

type StatusOptions struct {
	EvidenceProfileOverride domain.EvidenceProfileID
	MulticaWorkspaceID      string
	MulticaRuntimeID        string
	MulticaAgentID          string
	EvaluatedAt             time.Time
	Collectors              []EvidenceCollector
}

type PluginPlan struct {
	Name   string `json:"name"`
	Action string `json:"action"`
}

type ProviderPlan struct {
	Name              provider.Name `json:"name"`
	MarketplaceAction string        `json:"marketplace_action"`
	Plugins           []PluginPlan  `json:"plugins"`
}

type RepositoryPlan struct {
	Kind            bootstrap.Kind        `json:"kind"`
	Owner           string                `json:"owner"`
	Name            string                `json:"name"`
	Visibility      repository.Visibility `json:"visibility"`
	Action          string                `json:"action"`
	TemplateVersion string                `json:"template_version"`
	TemplateDigest  string                `json:"template_digest"`
}

type ProjectPlan struct {
	Owner            string             `json:"owner"`
	Title            string             `json:"title"`
	Visibility       project.Visibility `json:"visibility"`
	LinkedRepository string             `json:"linked_repository"`
	Action           string             `json:"action"`
	Retained         bool               `json:"retained_on_uninstall"`
}

type InitializationPlan struct {
	InstallationID        string                   `json:"installation_id"`
	TemplateVersion       string                   `json:"template_version"`
	TemplateContentSHA256 string                   `json:"template_content_sha256"`
	PluginSource          string                   `json:"plugin_source"`
	Profile               Profile                  `json:"profile"`
	EvidenceProfile       domain.EvidenceProfileID `json:"evidence_profile"`
	DeploymentDigest      string                   `json:"deployment_digest"`
	SubjectDigest         string                   `json:"subject_digest"`
	Providers             []ProviderPlan           `json:"providers"`
	Repositories          []RepositoryPlan         `json:"repositories"`
	Project               ProjectPlan              `json:"project"`
}

type UninitializeResult struct {
	Changed              bool                 `json:"changed"`
	ReceiptRemoved       bool                 `json:"receipt_removed"`
	RetainedRepositories []repository.Receipt `json:"retained_repositories"`
	RetainedProject      *project.Receipt     `json:"retained_project,omitempty"`
	RetainedMarketplaces []provider.Name      `json:"retained_marketplaces,omitempty"`
}

type target struct {
	name      provider.Name
	before    provider.Inventory
	receipt   ProviderReceipt
	toInstall []string
}

// Plan performs every installation, repository, and provider preflight without
// writing local or external state.
func Plan(ctx context.Context, options Options) (InitializationPlan, error) {
	prepared, err := prepareDeployment(ctx, options)
	if err != nil {
		return InitializationPlan{}, err
	}
	plan := InitializationPlan{
		InstallationID:        prepared.installation.InstallationID,
		TemplateVersion:       bootstrap.TemplateSetVersion,
		TemplateContentSHA256: bootstrap.TemplateSetContentSHA256,
		PluginSource:          prepared.pluginRepository,
		Profile:               prepared.options.Profile,
		EvidenceProfile:       prepared.options.EvidenceProfile,
		DeploymentDigest:      prepared.deploymentDigest,
		SubjectDigest:         prepared.subjectDigest,
	}
	recorded := map[string]bool{}
	for _, item := range prepared.existing.Repositories {
		recorded[strings.ToLower(item.NameWithOwner)] = true
	}
	for index, item := range prepared.repositoryTargets {
		kind := bootstrap.KindAgentControl
		if index == 1 {
			kind = bootstrap.KindAgentContracts
		}
		action := "create"
		if recorded[strings.ToLower(item.Owner+"/"+item.Name)] {
			action = "verify"
		}
		plan.Repositories = append(plan.Repositories, RepositoryPlan{
			Kind: kind, Owner: item.Owner, Name: item.Name, Visibility: item.Visibility,
			Action: action, TemplateVersion: item.Seed.Version, TemplateDigest: item.Seed.Digest,
		})
	}
	projectAction := "create"
	if prepared.existing.Project != nil {
		projectAction = "verify"
	}
	plan.Project = ProjectPlan{
		Owner: prepared.projectTarget.Owner, Title: prepared.projectTarget.Title,
		Visibility: prepared.projectTarget.Visibility, LinkedRepository: prepared.projectTarget.LinkedRepository,
		Action: projectAction, Retained: true,
	}
	for _, item := range prepared.providerTargets {
		providerPlan := ProviderPlan{Name: item.name, MarketplaceAction: "keep"}
		if item.receipt.MarketplaceAdded {
			providerPlan.MarketplaceAction = "add"
		}
		for _, pluginName := range item.receipt.SelectedPlugins {
			action := "keep"
			if contains(item.toInstall, pluginName) {
				action = "install"
			}
			providerPlan.Plugins = append(providerPlan.Plugins, PluginPlan{Name: pluginName, Action: action})
		}
		plan.Providers = append(plan.Providers, providerPlan)
	}
	return plan, nil
}

func Initialize(ctx context.Context, options Options) (Receipt, bool, error) {
	if strings.TrimSpace(options.GitHubOwner) != "" {
		return initializeDeployment(ctx, options)
	}
	// Internal compatibility for provider lifecycle tests and existing local
	// callers. The public CLI always requires an explicit GitHub owner and uses
	// the deployment path above.
	return initializeProvidersOnly(ctx, options)
}

func FirstUseContract(receipt Receipt) (smoke.Contract, error) {
	if receipt.Project == nil || receipt.Project.Verification != project.VerificationReadback {
		return smoke.Contract{}, fmt.Errorf("AGX-FIRST-USE-PROJECT: Project readback evidence is required")
	}
	var controlURL, contractsURL string
	for _, item := range receipt.Repositories {
		switch strings.ToLower(item.NameWithOwner) {
		case strings.ToLower(receipt.GitHubOwner + "/" + receipt.ControlRepository):
			controlURL = item.URL
		case strings.ToLower(receipt.GitHubOwner + "/" + receipt.ContractsRepository):
			contractsURL = item.URL
		}
	}
	if controlURL == "" || contractsURL == "" {
		return smoke.Contract{}, fmt.Errorf("AGX-FIRST-USE-REPOSITORIES: both deployment repository receipts are required")
	}
	title := "Bootstrap Verification [" + receipt.InstallationID + "]"
	marker := "AGX-Installation: " + receipt.InstallationID
	return smoke.Contract{
		SchemaVersion: smoke.ContractVersionV1, InstallationID: receipt.InstallationID,
		ProjectURL: receipt.Project.URL, ProjectTitle: receipt.Project.Title,
		ControlRepositoryURL: controlURL, ContractsRepositoryURL: contractsURL,
		Profile: string(receipt.Profile), Objective: "complete bootstrap verification",
		IssueTitle: title, PullRequestTitle: title, Marker: marker,
		Branch:                   "agx/bootstrap-verification-" + receipt.InstallationID,
		ValidationCommand:        "python tools/validate.py",
		ValidationWorkflow:       "Validate control baseline",
		ValidationCheck:          "validate",
		ValidationWorkflowSHA256: bootstrap.AgentControlValidationWorkflowSHA256,
		RequiredActions: []string{
			"read README.md, AGENTS.md, and authority/00-map.md in the control repository",
			"create the bounded Bootstrap Verification Issue with the contract marker",
			"add the Issue to the deployment Project",
			"create the contract branch and update work/current.md to point at the Issue",
			"run python tools/validate.py and preserve the result",
			"open an unmerged pull request with the contract title and marker",
		},
		RequiredOutputs: []string{"issue_url", "project_item", "pull_request_url", "validation_result"},
		Cleanup:         "operator-owned",
	}, nil
}

type preparedDeployment struct {
	installation      installer.Receipt
	source            string
	pluginRepository  string
	options           Options
	repositoryTargets []repository.Target
	projectTarget     project.Target
	providerTargets   []target
	deploymentBinding domain.DeploymentBindingV1
	deploymentDigest  string
	subjectBinding    domain.SubjectBindingV1
	subjectDigest     string
	existing          Receipt
	present           bool
}

func prepareDeployment(ctx context.Context, options Options) (preparedDeployment, error) {
	options.GitHubOwner = strings.TrimSpace(options.GitHubOwner)
	if options.GitHubOwner == "" {
		return preparedDeployment{}, fmt.Errorf("AGX-INIT-GITHUB-OWNER: --github-owner is required")
	}
	if options.ControlRepository == "" {
		options.ControlRepository = "agent-control"
	}
	if options.ContractsRepository == "" {
		options.ContractsRepository = "agent-contracts"
	}
	if options.Visibility == "" {
		options.Visibility = repository.VisibilityPrivate
	}
	evidenceProfile := strings.TrimSpace(string(options.EvidenceProfile))
	options.EvidenceProfile = domain.EvidenceProfileID(evidenceProfile)
	if evidenceProfile != "" {
		profile, err := domain.ParseEvidenceProfile(evidenceProfile)
		if err != nil {
			return preparedDeployment{}, err
		}
		options.EvidenceProfile = profile
		if err := domain.ValidateEvidenceProfileSelection(profile, options.MulticaWorkspaceID, options.MulticaRuntimeID, options.MulticaAgentID); err != nil {
			return preparedDeployment{}, err
		}
	}
	selected, err := Plugins(options.Profile)
	if err != nil {
		return preparedDeployment{}, err
	}
	providers, err := normalizeProviders(options.Providers)
	if err != nil {
		return preparedDeployment{}, err
	}
	options.Providers = providers
	installation, source, err := resolveInstallation(options.Root, true)
	if err != nil {
		return preparedDeployment{}, err
	}
	if installation.TemplateVersion != bootstrap.TemplateSetVersion || installation.TemplateContentSHA256 != bootstrap.TemplateSetContentSHA256 {
		return preparedDeployment{}, fmt.Errorf("AGX-INIT-TEMPLATE-DRIFT: installed template metadata does not match this AGX binary")
	}
	pluginRepository := ""
	for _, component := range installation.Components {
		if component.Name == "agent-plugins" {
			pluginRepository = component.Repository
		}
	}
	if pluginRepository == "" {
		return preparedDeployment{}, fmt.Errorf("AGX-INIT-INSTALLATION: agent-plugins upstream repository is missing")
	}
	repositoryTargets, err := buildRepositoryTargets(options, pluginRepository)
	if err != nil {
		return preparedDeployment{}, err
	}
	var deploymentBinding domain.DeploymentBindingV1
	var deploymentDigest string
	var subjectBinding domain.SubjectBindingV1
	var subjectDigest string
	if evidenceProfile != "" {
		deploymentBinding, deploymentDigest, subjectBinding, subjectDigest, err = buildEvidenceBindings(options, installation, repositoryTargets)
		if err != nil {
			return preparedDeployment{}, err
		}
	}
	existing, present, err := readReceipt(options.Root)
	if err != nil {
		return preparedDeployment{}, err
	}
	if present {
		if err := validateDeploymentIdentity(existing, installation, options, deploymentDigest, subjectDigest); err != nil {
			return preparedDeployment{}, err
		}
		if existing.Phase == PhaseManualCleanup {
			return preparedDeployment{}, fmt.Errorf("AGX-INIT-MANUAL-CLEANUP: unresolved provider changes require cleanup before initialization")
		}
		verified := make([]repository.Receipt, 0, len(existing.Repositories))
		for _, item := range existing.Repositories {
			if item.Verification == repository.VerificationUncertain {
				owner, name, ok := strings.Cut(item.NameWithOwner, "/")
				if !ok {
					return preparedDeployment{}, fmt.Errorf("AGX-INIT-REPOSITORY-DRIFT: uncertain repository identity is invalid")
				}
				_, inspectErr := repository.Inspect(ctx, owner, name, options.RepositoryRunner)
				if confirmedRepositoryAbsent(inspectErr) {
					// Direct confirmed absence is the sole retryable uncertain case;
					// omit it so normal preflight/create can retry.
					continue
				}
				if inspectErr != nil {
					return preparedDeployment{}, fmt.Errorf("AGX-INIT-REPOSITORY-DRIFT: uncertain repository absence could not be confirmed: %w", inspectErr)
				}
			}
			if err := repository.Verify(ctx, item, options.RepositoryRunner); err != nil {
				return preparedDeployment{}, fmt.Errorf("AGX-INIT-REPOSITORY-DRIFT: %w", err)
			}
			verified = append(verified, item)
		}
		existing.Repositories = verified
	}

	recorded := map[string]bool{}
	for _, item := range existing.Repositories {
		recorded[strings.ToLower(item.NameWithOwner)] = true
	}
	var missing []repository.Target
	for _, item := range repositoryTargets {
		if !recorded[strings.ToLower(item.Owner+"/"+item.Name)] {
			missing = append(missing, item)
		}
	}
	if len(missing) > 0 {
		if err := repository.Preflight(ctx, missing, options.RepositoryRunner); err != nil {
			return preparedDeployment{}, err
		}
	}
	projectTarget := buildProjectTarget(options, installation.InstallationID)
	if existing.Project == nil {
		if err := project.Preflight(ctx, projectTarget, options.RepositoryRunner); err != nil {
			return preparedDeployment{}, err
		}
	} else if existing.Project.Linked && existing.Project.Verification == project.VerificationReadback {
		if err := project.Verify(ctx, projectTarget, *existing.Project, options.RepositoryRunner); err != nil {
			return preparedDeployment{}, fmt.Errorf("AGX-INIT-PROJECT-DRIFT: %w", err)
		}
	} else if err := project.Revalidate(ctx, projectTarget, *existing.Project, options.RepositoryRunner); err != nil {
		return preparedDeployment{}, fmt.Errorf("AGX-INIT-PROJECT-DRIFT: %w", err)
	}
	providerRunner := options.Runner
	if providerRunner == nil {
		providerRunner = provider.OSRunner{}
	}
	providerTargets, err := prepareProviderTargets(ctx, selected, providers, source, providerRunner)
	if err != nil {
		return preparedDeployment{}, err
	}
	options.Runner = providerRunner
	return preparedDeployment{
		installation: installation, source: source, pluginRepository: pluginRepository, options: options,
		repositoryTargets: repositoryTargets, projectTarget: projectTarget,
		providerTargets: providerTargets, deploymentBinding: deploymentBinding, deploymentDigest: deploymentDigest,
		subjectBinding: subjectBinding, subjectDigest: subjectDigest, existing: existing, present: present,
	}, nil
}

func buildProjectTarget(options Options, installationID string) project.Target {
	visibility := project.VisibilityPrivate
	if options.Visibility == repository.VisibilityPublic {
		visibility = project.VisibilityPublic
	}
	return project.Target{
		Owner: options.GitHubOwner, Title: options.ControlRepository + " deployment (" + installationID + ")",
		Visibility: visibility, LinkedRepository: options.GitHubOwner + "/" + options.ControlRepository,
		InstallationID: installationID,
	}
}

func buildRepositoryTargets(options Options, pluginRepository string) ([]repository.Target, error) {
	definitions := []struct {
		kind        bootstrap.Kind
		name        string
		description string
	}{
		{bootstrap.KindAgentControl, options.ControlRepository, "AGX deployment control repository"},
		{bootstrap.KindAgentContracts, options.ContractsRepository, "AGX deployment contract repository"},
	}
	targets := make([]repository.Target, 0, len(definitions))
	for _, definition := range definitions {
		rendered, err := bootstrap.Render(definition.kind, bootstrap.Params{
			Owner: options.GitHubOwner, Repository: definition.name, PluginSource: pluginRepository,
		})
		if err != nil {
			return nil, err
		}
		files := make([]repository.File, 0, len(rendered.Files))
		for _, file := range rendered.Files {
			files = append(files, repository.File{Path: file.Path, Content: append([]byte(nil), file.Content...)})
		}
		targets = append(targets, repository.Target{
			Owner: options.GitHubOwner, Name: definition.name, Description: definition.description,
			Visibility: options.Visibility,
			Seed:       repository.Seed{Version: rendered.Version, Digest: rendered.Digest, Files: files},
		})
	}
	return targets, nil
}

func buildEvidenceBindings(options Options, installation installer.Receipt, targets []repository.Target) (domain.DeploymentBindingV1, string, domain.SubjectBindingV1, string, error) {
	if len(targets) != 2 {
		return domain.DeploymentBindingV1{}, "", domain.SubjectBindingV1{}, "", fmt.Errorf("AGX-EVIDENCE-DEPLOYMENT-BINDING-INVALID")
	}
	providerNames := make([]string, 0, len(options.Providers))
	for _, item := range options.Providers {
		providerNames = append(providerNames, string(item))
	}
	projectTarget := buildProjectTarget(options, installation.InstallationID)
	projectSelector := strings.Join([]string{projectTarget.Owner, projectTarget.Title, projectTarget.LinkedRepository, string(projectTarget.Visibility)}, "\x00")
	contractTitle := "Bootstrap Verification [" + installation.InstallationID + "]"
	contractMarker := "AGX-Installation: " + installation.InstallationID
	firstUseSelector := strings.Join([]string{contractTitle, contractMarker, "agx/bootstrap-verification-" + installation.InstallationID, "python tools/validate.py", "Validate control baseline", "validate"}, "\x00")
	deployment := domain.DeploymentBindingV1{
		SchemaVersion: domain.DeploymentBindingSchemaV1, InstallationID: domain.InstallationID(installation.InstallationID),
		BundleSHA256: installation.BundleSHA256, TemplateVersion: bootstrap.TemplateSetVersion, TemplateSetSHA256: bootstrap.TemplateSetContentSHA256,
		ProviderProfile: string(options.Profile), SelectedProviders: providerNames,
		ControlRepository: domain.RepositoryBindingV1{
			IdentitySHA256: domain.NamespacedIdentitySHA256("github", "repository", targets[0].Owner+"/"+targets[0].Name), RenderedContentSHA256: targets[0].Seed.Digest,
		},
		ContractsRepository: domain.RepositoryBindingV1{
			IdentitySHA256: domain.NamespacedIdentitySHA256("github", "repository", targets[1].Owner+"/"+targets[1].Name), RenderedContentSHA256: targets[1].Seed.Digest,
		},
		ProjectIdentitySHA256:  domain.NamespacedIdentitySHA256("github", "project", projectSelector),
		FirstUseContractSHA256: domain.NamespacedIdentitySHA256("agx", "first-use-contract", firstUseSelector),
	}
	deploymentDigest, err := domain.ComputeDeploymentDigest(deployment)
	if err != nil {
		return domain.DeploymentBindingV1{}, "", domain.SubjectBindingV1{}, "", err
	}
	subject := domain.SubjectBindingV1{
		SchemaVersion: domain.EvidenceSubjectSchemaV1, Profile: options.EvidenceProfile, DeploymentDigest: deploymentDigest,
		InstallationMarkerSHA256: domain.NamespacedIdentitySHA256("agx", "installation", installation.InstallationID),
		GitHubSelectors: domain.GitHubSubjectSelectorsV1{
			ControlRepositorySHA256:   deployment.ControlRepository.IdentitySHA256,
			ContractsRepositorySHA256: deployment.ContractsRepository.IdentitySHA256,
			ProjectSelectorSHA256:     deployment.ProjectIdentitySHA256,
			IssueSelectorSHA256:       domain.NamespacedIdentitySHA256("github", "issue", contractTitle+"\x00"+contractMarker),
			PullRequestSelectorSHA256: domain.NamespacedIdentitySHA256("github", "pull_request", contractTitle+"\x00"+contractMarker),
			BranchSelectorSHA256:      domain.NamespacedIdentitySHA256("github", "branch", "agx/bootstrap-verification-"+installation.InstallationID),
			WorkflowSHA256:            domain.NamespacedIdentitySHA256("github", "workflow", bootstrap.AgentControlValidationWorkflowSHA256),
			CheckSelectorSHA256:       domain.NamespacedIdentitySHA256("github", "check", "validate"),
		},
	}
	if options.EvidenceProfile == domain.EvidenceProfileMulticaExecutionV1 {
		subject.MulticaSelectors = &domain.MulticaSubjectSelectorsV1{
			WorkspaceUUID: strings.ToLower(strings.TrimSpace(options.MulticaWorkspaceID)), RuntimeUUID: strings.ToLower(strings.TrimSpace(options.MulticaRuntimeID)),
			AgentUUID:             strings.ToLower(strings.TrimSpace(options.MulticaAgentID)),
			ExecutionMarkerSHA256: domain.NamespacedIdentitySHA256("multica", "execution", installation.InstallationID),
		}
	}
	subjectDigest, err := domain.ComputeSubjectDigest(subject)
	if err != nil {
		return domain.DeploymentBindingV1{}, "", domain.SubjectBindingV1{}, "", err
	}
	return deployment, deploymentDigest, subject, subjectDigest, nil
}

func validateDeploymentIdentity(receipt Receipt, installation installer.Receipt, options Options, deploymentDigest, subjectDigest string) error {
	if receipt.SchemaVersion != receiptSchemaV4 && options.EvidenceProfile != "" {
		return fmt.Errorf("AGX-EVIDENCE-PROFILE-LEGACY-RECEIPT: existing legacy initialization receipt cannot be upgraded in place; initialize a new deployment with a new root and unused repository names")
	}
	if receipt.SchemaVersion == receiptSchemaV4 && options.EvidenceProfile == "" {
		return fmt.Errorf("AGX-EVIDENCE-PROFILE-REQUIRED: existing initialization receipt requires --evidence-profile %s; rerun the original init command with the same profile", receipt.EvidenceProfile)
	}
	if receipt.SchemaVersion == receiptSchemaV4 &&
		(receipt.DeploymentDigest != deploymentDigest || receipt.SubjectDigest != subjectDigest) {
		return fmt.Errorf("AGX-INIT-EVIDENCE-BINDING-CONFLICT: existing initialization receipt is bound to different provider or selector parameters; rerun the original init command unchanged")
	}
	if receipt.InstallationID != installation.InstallationID || receipt.GitHubOwner != options.GitHubOwner ||
		receipt.ControlRepository != options.ControlRepository || receipt.ContractsRepository != options.ContractsRepository ||
		receipt.Visibility != options.Visibility || receipt.TemplateVersion != bootstrap.TemplateSetVersion ||
		receipt.TemplateContentSHA256 != bootstrap.TemplateSetContentSHA256 || receipt.Profile != options.Profile ||
		(receipt.EvidenceProfile != "" && receipt.EvidenceProfile != options.EvidenceProfile) ||
		(!sameProviders(receipt.Providers, options.Providers) && len(receipt.Providers) > 0) {
		return fmt.Errorf("AGX-INIT-CONFLICT: existing initialization receipt has different deployment parameters")
	}
	return nil
}

func initializeDeployment(ctx context.Context, options Options) (Receipt, bool, error) {
	prepared, err := prepareDeployment(ctx, options)
	if err != nil {
		return Receipt{}, false, err
	}
	receipt := prepared.existing
	if prepared.present && receipt.Phase == PhaseInitialized && receipt.Project != nil {
		if problems := verifyReceipt(ctx, receipt, prepared.source, prepared.options.Runner); len(problems) > 0 {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-DRIFT: %s", strings.Join(problems, "; "))
		}
		return receipt, true, nil
	}
	if !prepared.present {
		receipt = Receipt{
			SchemaVersion: receiptSchema, InstallationID: prepared.installation.InstallationID,
			Phase: PhaseProvisioning, GitHubOwner: prepared.options.GitHubOwner,
			ControlRepository: prepared.options.ControlRepository, ContractsRepository: prepared.options.ContractsRepository,
			Visibility: prepared.options.Visibility, TemplateVersion: bootstrap.TemplateSetVersion,
			TemplateContentSHA256: bootstrap.TemplateSetContentSHA256, Profile: prepared.options.Profile,
		}
		if prepared.options.EvidenceProfile != "" {
			receipt.SchemaVersion = receiptSchemaV4
			receipt.EvidenceProfile = prepared.options.EvidenceProfile
			receipt.DeploymentBinding = &prepared.deploymentBinding
			receipt.DeploymentDigest = prepared.deploymentDigest
			receipt.SubjectBinding = &prepared.subjectBinding
			receipt.SubjectDigest = prepared.subjectDigest
		}
		if err := writeReceipt(prepared.options.Root, receipt); err != nil {
			return Receipt{}, false, err
		}
	}
	recorded := map[string]bool{}
	for _, item := range receipt.Repositories {
		recorded[strings.ToLower(item.NameWithOwner)] = true
	}
	for _, item := range prepared.repositoryTargets {
		if recorded[strings.ToLower(item.Owner+"/"+item.Name)] {
			continue
		}
		created, createErr := repository.Create(ctx, item, prepared.options.RepositoryRunner)
		if created.NameWithOwner != "" {
			receipt.Repositories = append(receipt.Repositories, created)
		}
		if createErr != nil {
			receipt.Phase = PhaseNeedsResume
			if writeErr := writeReceipt(prepared.options.Root, receipt); writeErr != nil {
				return Receipt{}, false, fmt.Errorf("%v; recovery receipt failed: %w", createErr, writeErr)
			}
			return receipt, false, createErr
		}
		if err := writeReceipt(prepared.options.Root, receipt); err != nil {
			return receipt, false, err
		}
	}
	var existingProject *project.Receipt
	if receipt.Project != nil {
		copy := *receipt.Project
		existingProject = &copy
	}
	projectReceipt, projectErr := project.Provision(ctx, prepared.projectTarget, existingProject, prepared.options.RepositoryRunner, func(value project.Receipt) error {
		receipt.Project = &value
		receipt.Phase = PhaseProvisioning
		return writeReceipt(prepared.options.Root, receipt)
	})
	if projectErr != nil {
		if projectReceipt.NodeID != "" {
			receipt.Project = &projectReceipt
		}
		receipt.Phase = PhaseNeedsResume
		if writeErr := writeReceipt(prepared.options.Root, receipt); writeErr != nil {
			return Receipt{}, false, fmt.Errorf("%v; recovery receipt failed: %w", projectErr, writeErr)
		}
		return receipt, false, projectErr
	}
	receipt.Project = &projectReceipt
	// Repository creation may take long enough for provider inventory to change.
	// Recheck it immediately before the first provider mutation.
	selected, _ := Plugins(prepared.options.Profile)
	providerTargets, providerPreflightErr := prepareProviderTargets(
		ctx, selected, prepared.options.Providers, prepared.source, prepared.options.Runner,
	)
	if providerPreflightErr != nil {
		receipt.Phase = PhaseNeedsResume
		if writeErr := writeReceipt(prepared.options.Root, receipt); writeErr != nil {
			return Receipt{}, false, fmt.Errorf("%v; recovery receipt failed: %w", providerPreflightErr, writeErr)
		}
		return receipt, false, providerPreflightErr
	}
	mergeProviderOwnership(providerTargets, receipt.Providers)
	// Persist ownership intent before provider mutation. An interrupted command
	// can then be reconciled or safely uninitialized without guessing which
	// objects AGX intended to add.
	receipt.Providers = make([]ProviderReceipt, 0, len(providerTargets))
	for index := range providerTargets {
		item := &providerTargets[index]
		for _, pluginName := range item.toInstall {
			if !contains(item.receipt.AddedPlugins, pluginName) {
				item.receipt.AddedPlugins = append(item.receipt.AddedPlugins, pluginName)
			}
		}
		receipt.Providers = append(receipt.Providers, item.receipt)
	}
	receipt.Phase = PhaseProvisioning
	if err := writeReceipt(prepared.options.Root, receipt); err != nil {
		return Receipt{}, false, err
	}
	providerReceipts, activationErr := activateDeploymentProviders(ctx, providerTargets, prepared.source, prepared.options.Runner)
	if activationErr != nil {
		receipt.Providers = providerReceipts
		cleanupErr := compensate(ctx, providerReceipts, prepared.source, prepared.options.Runner)
		if cleanupErr == nil {
			receipt.Providers = nil
			receipt.Phase = PhaseNeedsResume
		} else {
			receipt.Phase = PhaseManualCleanup
			activationErr = fmt.Errorf("%v; compensation failed: %v", activationErr, cleanupErr)
		}
		if writeErr := writeReceipt(prepared.options.Root, receipt); writeErr != nil {
			return Receipt{}, false, fmt.Errorf("%v; recovery receipt failed: %w", activationErr, writeErr)
		}
		return receipt, false, activationErr
	}
	receipt.Providers = providerReceipts
	if problems := verifyReceipt(ctx, receipt, prepared.source, prepared.options.Runner); len(problems) > 0 {
		readbackErr := fmt.Errorf("AGX-INIT-READBACK: %s", strings.Join(problems, "; "))
		if cleanupErr := compensate(ctx, providerReceipts, prepared.source, prepared.options.Runner); cleanupErr == nil {
			receipt.Providers = nil
			receipt.Phase = PhaseNeedsResume
		} else {
			receipt.Phase = PhaseManualCleanup
			readbackErr = fmt.Errorf("%v; compensation failed: %v", readbackErr, cleanupErr)
		}
		if err := writeReceipt(prepared.options.Root, receipt); err != nil {
			return Receipt{}, false, err
		}
		return receipt, false, readbackErr
	}
	receipt.Phase = PhaseInitialized
	if err := writeReceipt(prepared.options.Root, receipt); err != nil {
		return Receipt{}, false, err
	}
	return receipt, false, nil
}

func prepareProviderTargets(ctx context.Context, selected []string, providers []provider.Name, source string, runner provider.Runner) ([]target, error) {
	targets := make([]target, 0, len(providers))
	for _, name := range providers {
		inventory, err := provider.Inspect(ctx, name, runner)
		if err != nil {
			return nil, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return nil, fmt.Errorf("AGX-INIT-SOURCE-CONFLICT: %s Marketplace %q is already bound to a different source", name, provider.MarketplaceName)
		}
		item := target{name: name, before: inventory, receipt: ProviderReceipt{
			Name: name, MarketplaceAdded: !inventory.Marketplace.Present, SelectedPlugins: append([]string(nil), selected...),
		}}
		for _, pluginName := range selected {
			plugin, present := inventory.Plugin(pluginName)
			if present && !plugin.Enabled {
				return nil, fmt.Errorf("AGX-INIT-PLUGIN-DISABLED: %s plugin %q already exists but is disabled", name, pluginName)
			}
			if !present {
				item.toInstall = append(item.toInstall, pluginName)
			}
		}
		targets = append(targets, item)
	}
	return targets, nil
}

func activateDeploymentProviders(ctx context.Context, targets []target, source string, runner provider.Runner) ([]ProviderReceipt, error) {
	var receipts []ProviderReceipt
	for index := range targets {
		item := &targets[index]
		if item.receipt.MarketplaceAdded && !item.before.Marketplace.Present {
			if err := provider.AddMarketplace(ctx, item.name, source, runner); err != nil {
				return candidateReceipts(targets, index, ""), err
			}
		}
		for _, pluginName := range item.toInstall {
			if err := provider.InstallPlugin(ctx, item.name, pluginName, runner); err != nil {
				return candidateReceipts(targets, index, pluginName), err
			}
			if !contains(item.receipt.AddedPlugins, pluginName) {
				item.receipt.AddedPlugins = append(item.receipt.AddedPlugins, pluginName)
			}
		}
		receipts = append(receipts, item.receipt)
	}
	return receipts, nil
}

func mergeProviderOwnership(targets []target, existing []ProviderReceipt) {
	byName := make(map[provider.Name]ProviderReceipt, len(existing))
	for _, item := range existing {
		byName[item.Name] = item
	}
	for index := range targets {
		if item, present := byName[targets[index].name]; present {
			targets[index].receipt = item
		}
	}
}

func initializeProvidersOnly(ctx context.Context, options Options) (Receipt, bool, error) {
	runner := options.Runner
	if runner == nil {
		runner = provider.OSRunner{}
	}
	selected, err := Plugins(options.Profile)
	if err != nil {
		return Receipt{}, false, err
	}
	providers, err := normalizeProviders(options.Providers)
	if err != nil {
		return Receipt{}, false, err
	}
	installation, source, err := resolveInstallation(options.Root, true)
	if err != nil {
		return Receipt{}, false, err
	}

	existing, present, err := readReceipt(options.Root)
	if err != nil {
		return Receipt{}, false, err
	}
	if present {
		if existing.Phase == PhaseManualCleanup {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-MANUAL-CLEANUP: unresolved provider changes require cleanup before initialization")
		}
		if existing.InstallationID != installation.InstallationID || existing.Profile != options.Profile || !sameProviders(existing.Providers, providers) {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-CONFLICT: existing initialization receipt has a different Installation, profile, or provider set")
		}
		if problems := verifyReceipt(ctx, existing, source, runner); len(problems) > 0 {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-DRIFT: %s", strings.Join(problems, "; "))
		}
		return existing, true, nil
	}

	targets := make([]target, 0, len(providers))
	for _, name := range providers {
		inventory, err := provider.Inspect(ctx, name, runner)
		if err != nil {
			return Receipt{}, false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return Receipt{}, false, fmt.Errorf("AGX-INIT-SOURCE-CONFLICT: %s Marketplace %q is already bound to a different source", name, provider.MarketplaceName)
		}
		item := target{
			name:   name,
			before: inventory,
			receipt: ProviderReceipt{
				Name:             name,
				MarketplaceAdded: !inventory.Marketplace.Present,
				SelectedPlugins:  append([]string(nil), selected...),
			},
		}
		for _, pluginName := range selected {
			plugin, present := inventory.Plugin(pluginName)
			if present && !plugin.Enabled {
				return Receipt{}, false, fmt.Errorf("AGX-INIT-PLUGIN-DISABLED: %s plugin %q already exists but is disabled", name, pluginName)
			}
			if !present {
				item.toInstall = append(item.toInstall, pluginName)
			}
		}
		targets = append(targets, item)
	}

	receipt := Receipt{
		SchemaVersion:  receiptSchemaV3,
		InstallationID: installation.InstallationID,
		Phase:          PhaseInitialized,
		Profile:        options.Profile,
	}
	for index := range targets {
		item := &targets[index]
		if item.receipt.MarketplaceAdded {
			if err := provider.AddMarketplace(ctx, item.name, source, runner); err != nil {
				receipt.Providers = candidateReceipts(targets, index, "")
				return failedInitialization(ctx, options.Root, receipt, source, runner, err)
			}
		}
		for _, pluginName := range item.toInstall {
			if err := provider.InstallPlugin(ctx, item.name, pluginName, runner); err != nil {
				receipt.Providers = candidateReceipts(targets, index, pluginName)
				return failedInitialization(ctx, options.Root, receipt, source, runner, err)
			}
			item.receipt.AddedPlugins = append(item.receipt.AddedPlugins, pluginName)
		}
		receipt.Providers = append(receipt.Providers, item.receipt)
	}

	if problems := verifyReceipt(ctx, receipt, source, runner); len(problems) > 0 {
		return failedInitialization(ctx, options.Root, receipt, source, runner, fmt.Errorf("AGX-INIT-READBACK: %s", strings.Join(problems, "; ")))
	}
	if err := writeReceipt(options.Root, receipt); err != nil {
		return failedInitialization(ctx, options.Root, receipt, source, runner, err)
	}
	return receipt, false, nil
}

func Status(ctx context.Context, root string, runner provider.Runner, repositoryRunners ...repository.Runner) (State, error) {
	return StatusWithEvidence(ctx, root, runner, StatusOptions{}, repositoryRunners...)
}

func StatusWithEvidence(ctx context.Context, root string, runner provider.Runner, options StatusOptions, repositoryRunners ...repository.Runner) (State, error) {
	receipt, present, err := readReceipt(root)
	if err != nil {
		return State{}, err
	}
	if !present {
		return State{Status: StatusAbsent}, nil
	}
	state := State{Status: receipt.Phase, Profile: receipt.Profile, Project: receipt.Project}
	state.Evidence = evaluateStatusEvidence(ctx, receipt, options)
	for _, item := range receipt.Providers {
		state.Providers = append(state.Providers, item.Name)
	}
	var repositoryRunner repository.Runner
	if len(repositoryRunners) > 0 {
		repositoryRunner = repositoryRunners[0]
	}
	for _, item := range receipt.Repositories {
		state.Repositories = append(state.Repositories, item.NameWithOwner)
		state.RepositoryDetails = append(state.RepositoryDetails, item)
		if item.Verification == repository.VerificationUncertain && !item.Created &&
			(receipt.Phase == PhaseNeedsResume || receipt.Phase == PhaseProvisioning) {
			owner, name, ok := strings.Cut(item.NameWithOwner, "/")
			if ok {
				_, inspectErr := repository.Inspect(ctx, owner, name, repositoryRunner)
				if statusErr := statusContextError(ctx); statusErr != nil {
					return state, statusErr
				}
				if confirmedRepositoryAbsent(inspectErr) {
					continue
				}
				if inspectErr == nil {
					verifyErr := repository.Verify(ctx, item, repositoryRunner)
					if statusErr := statusContextError(ctx); statusErr != nil {
						return state, statusErr
					}
					if verifyErr == nil {
						continue
					}
				}
			}
			state.Problems = append(state.Problems, fmt.Sprintf("repository %s drifted", item.NameWithOwner))
			continue
		}
		verifyErr := repository.Verify(ctx, item, repositoryRunner)
		if statusErr := statusContextError(ctx); statusErr != nil {
			return state, statusErr
		}
		if verifyErr != nil {
			state.Problems = append(state.Problems, fmt.Sprintf("repository %s drifted", item.NameWithOwner))
		}
	}
	if receipt.GitHubOwner != "" {
		if receipt.Project == nil {
			if receipt.Phase == PhaseInitialized {
				state.Status = PhaseNeedsResume
			}
		} else {
			target := buildProjectTarget(Options{
				GitHubOwner: receipt.GitHubOwner, ControlRepository: receipt.ControlRepository, Visibility: receipt.Visibility,
			}, receipt.InstallationID)
			if receipt.Project.Linked && receipt.Project.Verification == project.VerificationReadback {
				verifyErr := project.Verify(ctx, target, *receipt.Project, repositoryRunner)
				if statusErr := statusContextError(ctx); statusErr != nil {
					return state, statusErr
				}
				if verifyErr != nil {
					state.Problems = append(state.Problems, "GitHub Project or control repository link drifted")
				}
			} else {
				revalidateErr := project.Revalidate(ctx, target, *receipt.Project, repositoryRunner)
				if statusErr := statusContextError(ctx); statusErr != nil {
					return state, statusErr
				}
				if revalidateErr != nil {
					state.Problems = append(state.Problems, "GitHub Project identity or visibility drifted")
				} else if receipt.Phase != PhaseNeedsResume && receipt.Phase != PhaseProvisioning {
					state.Problems = append(state.Problems, "GitHub Project or control repository link drifted")
				}
			}
		}
	}
	if receipt.Phase == PhaseManualCleanup {
		if len(state.Problems) > 0 {
			state.Status = StatusDrifted
		}
		return state, nil
	}
	installation, source, err := resolveInstallation(root, false)
	if err != nil {
		state.Status = StatusDrifted
		state.Problems = append(state.Problems, "installed agent-plugins component is unavailable")
		return state, nil
	}
	if receipt.InstallationID != installation.InstallationID {
		state.Status = StatusDrifted
		state.Problems = append(state.Problems, "initialization receipt belongs to a different Installation")
		return state, nil
	}
	if runner == nil {
		runner = provider.OSRunner{}
	}
	providerProblems := verifyReceipt(ctx, receipt, source, runner)
	if statusErr := statusContextError(ctx); statusErr != nil {
		return state, statusErr
	}
	state.Problems = append(state.Problems, providerProblems...)
	if len(state.Problems) > 0 {
		state.Status = StatusDrifted
		return state, nil
	}
	if receipt.Project != nil {
		contract, contractErr := FirstUseContract(receipt)
		if contractErr != nil {
			state.Smoke = smoke.Evidence{Status: smoke.StatusAwaiting, Problems: []string{contractErr.Error()}}
		} else {
			evidence, smokeErr := smoke.Inspect(ctx, contract, repositoryRunner)
			if statusErr := statusContextError(ctx); statusErr != nil {
				return state, statusErr
			}
			if smokeErr != nil {
				state.Smoke = smoke.Evidence{Status: smoke.StatusAwaiting, Problems: []string{smokeErr.Error()}}
			} else {
				state.Smoke = evidence
			}
		}
	}
	return state, nil
}

func evaluateStatusEvidence(ctx context.Context, receipt Receipt, options StatusOptions) domain.EvidenceReceipt {
	profile := receipt.EvidenceProfile
	deploymentDigest := receipt.DeploymentDigest
	subjectDigest := receipt.SubjectDigest
	var diagnostics []domain.Diagnostic
	if receipt.SchemaVersion != receiptSchemaV4 {
		profile = domain.EvidenceProfileID(strings.ToLower(strings.TrimSpace(string(options.EvidenceProfileOverride))))
		if profile != "" {
			if err := domain.ValidateEvidenceProfileSelection(profile, options.MulticaWorkspaceID, options.MulticaRuntimeID, options.MulticaAgentID); err != nil {
				diagnostics = append(diagnostics, domain.Diagnostic{
					Code: "AGX-EVIDENCE-SUBJECT-INCOMPLETE", Category: domain.DiagnosticCategoryPreflight,
					Severity: domain.SeverityError, Message: "temporary evidence profile selectors are invalid",
				})
			} else {
				diagnostics = append(diagnostics, domain.Diagnostic{
					Code: "AGX-EVIDENCE-PROFILE-LEGACY-RECEIPT", Category: domain.DiagnosticCategoryPreflight,
					Severity: domain.SeverityError, Message: "legacy initialization receipts cannot accept an evidence profile override; rerun agx init with an explicit evidence profile",
				})
			}
		}
		deploymentDigest = domain.NamespacedIdentitySHA256("agx", "legacy-deployment", strings.Join([]string{
			receipt.SchemaVersion, receipt.InstallationID, receipt.TemplateVersion, receipt.TemplateContentSHA256,
			receipt.GitHubOwner, receipt.ControlRepository, receipt.ContractsRepository, string(receipt.Profile),
		}, "\x00"))
		subjectDigest = domain.NamespacedIdentitySHA256("agx", "legacy-evidence-subject", strings.Join([]string{
			string(profile), deploymentDigest, strings.ToLower(strings.TrimSpace(options.MulticaWorkspaceID)),
			strings.ToLower(strings.TrimSpace(options.MulticaRuntimeID)), strings.ToLower(strings.TrimSpace(options.MulticaAgentID)),
		}, "\x00"))
	} else if profile == "" {
		diagnostics = append(diagnostics, domain.Diagnostic{
			Code: "AGX-EVIDENCE-PROFILE-MISSING", Category: domain.DiagnosticCategoryPreflight,
			Severity: domain.SeverityError, Message: "persisted v4 receipt is missing its evidence profile",
		})
	} else {
		selectorOverride := options.EvidenceProfileOverride != "" || options.MulticaWorkspaceID != "" || options.MulticaRuntimeID != "" || options.MulticaAgentID != ""
		selectedProfile := profile
		if options.EvidenceProfileOverride != "" {
			selectedProfile = options.EvidenceProfileOverride
		}
		if selectorOverride {
			if err := domain.ValidateEvidenceProfileSelection(selectedProfile, options.MulticaWorkspaceID, options.MulticaRuntimeID, options.MulticaAgentID); err != nil {
				diagnostics = append(diagnostics, domain.Diagnostic{
					Code: "AGX-EVIDENCE-SUBJECT-INCOMPLETE", Category: domain.DiagnosticCategoryPreflight,
					Severity: domain.SeverityError, Message: "temporary evidence profile selectors are invalid",
				})
			}
		}
		if options.EvidenceProfileOverride != "" && options.EvidenceProfileOverride != profile {
			diagnostics = append(diagnostics, domain.Diagnostic{
				Code: "AGX-EVIDENCE-PROFILE-MISMATCH", Category: domain.DiagnosticCategoryPreflight,
				Severity: domain.SeverityError, Message: "temporary evidence profile override conflicts with the persisted profile",
			})
		}
		if profile == domain.EvidenceProfileMulticaExecutionV1 && selectorOverride && receipt.SubjectBinding != nil && receipt.SubjectBinding.MulticaSelectors != nil {
			persisted := receipt.SubjectBinding.MulticaSelectors
			if !strings.EqualFold(strings.TrimSpace(options.MulticaWorkspaceID), persisted.WorkspaceUUID) ||
				!strings.EqualFold(strings.TrimSpace(options.MulticaRuntimeID), persisted.RuntimeUUID) ||
				!strings.EqualFold(strings.TrimSpace(options.MulticaAgentID), persisted.AgentUUID) {
				diagnostics = append(diagnostics, domain.Diagnostic{
					Code: "AGX-EVIDENCE-SUBJECT-MISMATCH", Category: domain.DiagnosticCategoryPreflight,
					Severity: domain.SeverityError, Message: "temporary Multica selectors conflict with the persisted evidence subject",
				})
			}
		}
	}
	var observations []domain.EvidenceObservation
	if len(diagnostics) == 0 && profile != "" {
		for _, collector := range options.Collectors {
			if collector == nil {
				continue
			}
			batch := collector.Collect(ctx, receipt)
			observations = append(observations, batch.Observations...)
			for range batch.Diagnostics {
				diagnostics = append(diagnostics, collectorDiagnostic(collector.Source()))
			}
		}
	}
	evaluatedAt := options.EvaluatedAt
	if evaluatedAt.IsZero() {
		evaluatedAt = time.Now().UTC()
	}
	return domain.EvaluateEvidence(domain.EvaluationInput{
		SchemaVersion: domain.EvidenceInputSchemaV1, EvaluatorVersion: domain.EvidenceEvaluatorV1,
		InstallationID: domain.InstallationID(receipt.InstallationID), DeploymentDigest: deploymentDigest,
		SubjectDigest: subjectDigest, Profile: profile, EvaluatedAt: evaluatedAt,
		Observations: observations, Diagnostics: diagnostics,
	})
}

func collectorDiagnostic(source domain.EvidenceSource) domain.Diagnostic {
	code := domain.DiagnosticCode("AGX-EVIDENCE-COLLECTOR-SOURCE-INVALID")
	message := "evidence collector returned diagnostics without a supported source"
	switch source {
	case domain.EvidenceSourceGitHub:
		code = "AGX-EVIDENCE-GITHUB-COLLECTOR-FAILED"
		message = "GitHub evidence collector failed"
	case domain.EvidenceSourceMultica:
		code = "AGX-EVIDENCE-MULTICA-COLLECTOR-FAILED"
		message = "Multica evidence collector failed"
	}
	return domain.Diagnostic{Code: code, Category: domain.DiagnosticCategoryPreflight, Severity: domain.SeverityError, Message: message}
}

func statusContextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("AGX-STATUS-INCONCLUSIVE: remote readback was canceled or timed out; rerun agx status or agx diagnose; no changes were made: %w", err)
	}
	return nil
}

// UninitializeDetailed reverses only AGX-owned provider mutations and reports
// the deployment repositories that are deliberately retained. The legacy
// Uninitialize wrapper below remains for internal callers that only need a
// changed boolean.
func UninitializeDetailed(ctx context.Context, root string, runner provider.Runner) (UninitializeResult, error) {
	receipt, present, err := readReceipt(root)
	if err != nil || !present {
		return UninitializeResult{}, err
	}
	result := UninitializeResult{
		RetainedRepositories: append([]repository.Receipt(nil), receipt.Repositories...),
		RetainedProject:      receipt.Project,
	}
	providerRunner := runner
	if providerRunner == nil {
		providerRunner = provider.OSRunner{}
	}
	_, source, sourceErr := resolveInstallation(root, false)
	beforeCount, _, beforeOK := inspectOwnedProviderState(ctx, receipt, source, providerRunner, sourceErr == nil)
	changed, err := Uninitialize(ctx, root, runner)
	afterCount, retainedMarketplaces, afterOK := inspectOwnedProviderState(ctx, receipt, source, providerRunner, sourceErr == nil)
	result.Changed = changed || (beforeOK && afterOK && afterCount < beforeCount)
	result.ReceiptRemoved = changed
	result.RetainedMarketplaces = retainedMarketplaces
	return result, err
}

func inspectOwnedProviderState(ctx context.Context, receipt Receipt, source string, runner provider.Runner, sourceAvailable bool) (int, []provider.Name, bool) {
	if !sourceAvailable {
		return 0, nil, false
	}
	count := 0
	var retained []provider.Name
	for _, item := range receipt.Providers {
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return 0, nil, false
		}
		if inventory.Marketplace.Present && provider.SameSource(inventory.Marketplace.Source, source) {
			if item.MarketplaceAdded {
				count++
			} else {
				retained = append(retained, item.Name)
			}
		}
		for _, pluginName := range item.AddedPlugins {
			if _, present := inventory.Plugin(pluginName); present {
				count++
			}
		}
	}
	return count, retained, true
}

func Uninitialize(ctx context.Context, root string, runner provider.Runner) (bool, error) {
	receipt, present, err := readReceipt(root)
	if err != nil || !present {
		return false, err
	}
	if runner == nil {
		runner = provider.OSRunner{}
	}
	installation, source, err := resolveInstallation(root, false)
	if err != nil {
		return false, err
	}
	if receipt.InstallationID != installation.InstallationID {
		return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-OWNERSHIP: initialization receipt belongs to a different Installation")
	}

	// Complete every read-only source check before the first mutation. A
	// pre-existing Marketplace that still references this Installation blocks
	// Bundle removal, but it must not block cleanup of plugins AGX added through
	// that Marketplace.
	for _, item := range receipt.Providers {
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed; provider cleanup stopped", item.Name)
		}
	}

	var retainedMarketplaces []string
	for index := len(receipt.Providers) - 1; index >= 0; index-- {
		item := receipt.Providers[index]
		for pluginIndex := len(item.AddedPlugins) - 1; pluginIndex >= 0; pluginIndex-- {
			pluginName := item.AddedPlugins[pluginIndex]
			inventory, err := provider.Inspect(ctx, item.Name, runner)
			if err != nil {
				return false, err
			}
			if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
				return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed during provider cleanup", item.Name)
			}
			if _, present := inventory.Plugin(pluginName); !present {
				continue
			}
			if err := provider.RemovePlugin(ctx, item.Name, pluginName, runner); err != nil {
				return false, err
			}
		}
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed during provider cleanup", item.Name)
		}
		if item.MarketplaceAdded && inventory.Marketplace.Present {
			if err := provider.RemoveMarketplace(ctx, item.Name, runner); err != nil {
				return false, err
			}
		}
		inventory, err = provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			return false, err
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-SOURCE: %s Marketplace source changed during provider cleanup", item.Name)
		}
		if item.MarketplaceAdded && inventory.Marketplace.Present {
			return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-READBACK: %s Marketplace is still present", item.Name)
		}
		for _, pluginName := range item.AddedPlugins {
			if _, present := inventory.Plugin(pluginName); present {
				return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-READBACK: %s plugin %q is still present", item.Name, pluginName)
			}
		}
		if !item.MarketplaceAdded && inventory.Marketplace.Present {
			retainedMarketplaces = append(retainedMarketplaces, string(item.Name))
		}
	}

	if len(retainedMarketplaces) > 0 {
		return false, fmt.Errorf("AGX-UNINSTALL-PROVIDER-OWNERSHIP: %s Marketplace predates AGX initialization and still references this Installation", strings.Join(retainedMarketplaces, ", "))
	}

	safeReceiptPath, present, _, err := inspectReceiptPath(root)
	if err != nil {
		return false, err
	}
	if !present {
		return false, fmt.Errorf("AGX-INIT-RECEIPT-READ: initialization receipt disappeared before removal")
	}
	if err := os.Remove(safeReceiptPath); err != nil {
		return false, fmt.Errorf("AGX-INIT-RECEIPT-REMOVE: %w", err)
	}
	return true, nil
}

func failedInitialization(ctx context.Context, root string, receipt Receipt, source string, runner provider.Runner, original error) (Receipt, bool, error) {
	cleanupErr := compensate(ctx, receipt.Providers, source, runner)
	if cleanupErr == nil {
		return Receipt{}, false, original
	}
	receipt.Phase = PhaseManualCleanup
	if writeErr := writeReceipt(root, receipt); writeErr != nil {
		return Receipt{}, false, fmt.Errorf("%v; compensation failed: %v; manual-cleanup receipt failed: %v", original, cleanupErr, writeErr)
	}
	return receipt, false, fmt.Errorf("%v; compensation failed: %v", original, cleanupErr)
}

func compensate(ctx context.Context, receipts []ProviderReceipt, source string, runner provider.Runner) error {
	var failures []string
	for index := len(receipts) - 1; index >= 0; index-- {
		item := receipts[index]
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s inventory unavailable", item.Name))
			continue
		}
		if inventory.Marketplace.Present && !provider.SameSource(inventory.Marketplace.Source, source) {
			failures = append(failures, fmt.Sprintf("%s source changed", item.Name))
			continue
		}
		for pluginIndex := len(item.AddedPlugins) - 1; pluginIndex >= 0; pluginIndex-- {
			pluginName := item.AddedPlugins[pluginIndex]
			if _, present := inventory.Plugin(pluginName); !present {
				continue
			}
			if err := provider.RemovePlugin(ctx, item.Name, pluginName, runner); err != nil {
				failures = append(failures, fmt.Sprintf("%s plugin cleanup failed", item.Name))
			}
		}
		inventory, err = provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s readback unavailable", item.Name))
			continue
		}
		if item.MarketplaceAdded && inventory.Marketplace.Present {
			if err := provider.RemoveMarketplace(ctx, item.Name, runner); err != nil {
				failures = append(failures, fmt.Sprintf("%s Marketplace cleanup failed", item.Name))
			}
		}
		if inventory, err = provider.Inspect(ctx, item.Name, runner); err != nil {
			failures = append(failures, fmt.Sprintf("%s final readback unavailable", item.Name))
		} else {
			if item.MarketplaceAdded && inventory.Marketplace.Present {
				failures = append(failures, fmt.Sprintf("%s Marketplace remains after cleanup", item.Name))
			}
			for _, pluginName := range item.AddedPlugins {
				if _, present := inventory.Plugin(pluginName); present {
					failures = append(failures, fmt.Sprintf("%s plugin remains after cleanup", item.Name))
				}
			}
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func candidateReceipts(targets []target, failedIndex int, attemptedPlugin string) []ProviderReceipt {
	receipts := make([]ProviderReceipt, 0, failedIndex+1)
	for index := 0; index <= failedIndex; index++ {
		item := targets[index].receipt
		if index == failedIndex && attemptedPlugin != "" && !contains(item.AddedPlugins, attemptedPlugin) {
			item.AddedPlugins = append(item.AddedPlugins, attemptedPlugin)
		}
		receipts = append(receipts, item)
	}
	return receipts
}

func verifyReceipt(ctx context.Context, receipt Receipt, source string, runner provider.Runner) []string {
	var problems []string
	for _, item := range receipt.Providers {
		inventory, err := provider.Inspect(ctx, item.Name, runner)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s inventory unavailable", item.Name))
			continue
		}
		if !inventory.Marketplace.Present || !provider.SameSource(inventory.Marketplace.Source, source) {
			problems = append(problems, fmt.Sprintf("%s Marketplace does not reference the installed Bundle", item.Name))
			continue
		}
		for _, pluginName := range item.SelectedPlugins {
			plugin, present := inventory.Plugin(pluginName)
			if !present || !plugin.Enabled {
				problems = append(problems, fmt.Sprintf("%s plugin %s is not enabled", item.Name, pluginName))
			}
		}
	}
	return problems
}

func resolveInstallation(root string, requireConfigured bool) (installer.Receipt, string, error) {
	state, err := installer.Status(root)
	if err != nil {
		return installer.Receipt{}, "", err
	}
	if state.Receipt == nil || (requireConfigured && state.Phase != "configured") {
		return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: Installation must be intact and configured")
	}
	for _, component := range state.Receipt.Components {
		if component.Name != "agent-plugins" {
			continue
		}
		expectedPath := filepath.Join("components", "agent-plugins")
		if filepath.Clean(filepath.FromSlash(component.Path)) != expectedPath {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: unexpected agent-plugins component path")
		}
		absoluteRoot, err := filepath.Abs(root)
		if err != nil {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: invalid Installation root")
		}
		source := filepath.Join(absoluteRoot, filepath.FromSlash(component.Path))
		relative, err := filepath.Rel(absoluteRoot, source)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: unsafe agent-plugins component path")
		}
		info, err := os.Lstat(source)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsDir() {
			return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: agent-plugins component is unavailable")
		}
		return *state.Receipt, source, nil
	}
	return installer.Receipt{}, "", fmt.Errorf("AGX-INIT-INSTALLATION: receipt has no agent-plugins component")
}

func confirmedRepositoryAbsent(err error) bool {
	return err != nil && strings.HasPrefix(err.Error(), "AGX-REPOSITORY-ABSENT:")
}

func normalizeProviders(values []provider.Name) ([]provider.Name, error) {
	seen := map[provider.Name]bool{}
	for _, name := range values {
		if name != provider.Codex && name != provider.Claude {
			return nil, fmt.Errorf("AGX-INIT-PROVIDER: unsupported provider %q", name)
		}
		seen[name] = true
	}
	if len(seen) == 0 {
		return nil, fmt.Errorf("AGX-INIT-PROVIDER: at least one provider is required")
	}
	var providers []provider.Name
	for _, name := range []provider.Name{provider.Codex, provider.Claude} {
		if seen[name] {
			providers = append(providers, name)
		}
	}
	return providers, nil
}

func sameProviders(receipts []ProviderReceipt, providers []provider.Name) bool {
	if len(receipts) != len(providers) {
		return false
	}
	for index, item := range receipts {
		if item.Name != providers[index] {
			return false
		}
	}
	return true
}

func receiptPath(root string) string {
	return filepath.Join(root, ".agx", initializationFile)
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			keys := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("invalid object key")
				}
				if _, duplicate := keys[key]; duplicate {
					return fmt.Errorf("duplicate object key %q", key)
				}
				keys[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter")
		}
		_, err = decoder.Token()
		return err
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return nil
}

func readReceipt(root string) (Receipt, bool, error) {
	path, present, expectedInfo, err := inspectReceiptPath(root)
	if err != nil {
		return Receipt{}, false, err
	}
	if !present {
		return Receipt{}, false, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot open initialization receipt: %w", err)
	}
	openedInfo, statErr := file.Stat()
	if statErr != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(expectedInfo, openedInfo) {
		file.Close()
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: initialization receipt changed during read")
	}
	data, readErr := io.ReadAll(file)
	closeErr := file.Close()
	if readErr != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot read initialization receipt: %w", readErr)
	}
	if closeErr != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot close initialization receipt: %w", closeErr)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var receipt Receipt
	if err := decoder.Decode(&receipt); err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: trailing data")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: %w", err)
	}
	if receipt.SchemaVersion == receiptSchemaV2 {
		if err := migrateReceiptV2(&receipt); err != nil {
			return Receipt{}, false, err
		}
	}
	if (receipt.SchemaVersion != receiptSchemaV3 && receipt.SchemaVersion != receiptSchemaV4) || receipt.InstallationID == "" ||
		(receipt.Phase != PhaseInitialized && receipt.Phase != PhaseProvisioning && receipt.Phase != PhaseNeedsResume && receipt.Phase != PhaseManualCleanup) {
		return Receipt{}, false, fmt.Errorf("AGX-INIT-RECEIPT-INVALID: required fields are missing")
	}
	if err := validateReceipt(receipt); err != nil {
		return Receipt{}, false, err
	}
	return receipt, true, nil
}

func migrateReceiptV2(receipt *Receipt) error {
	if receipt == nil || receipt.SchemaVersion != receiptSchemaV2 {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: cannot migrate initialization receipt")
	}
	for index := range receipt.Repositories {
		item := &receipt.Repositories[index]
		kind := bootstrap.KindAgentControl
		repositoryName := receipt.ControlRepository
		switch strings.ToLower(item.NameWithOwner) {
		case strings.ToLower(receipt.GitHubOwner + "/" + receipt.ControlRepository):
		case strings.ToLower(receipt.GitHubOwner + "/" + receipt.ContractsRepository):
			kind = bootstrap.KindAgentContracts
			repositoryName = receipt.ContractsRepository
		default:
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: cannot migrate unknown deployment repository")
		}
		rendered, err := bootstrap.Render(kind, bootstrap.Params{
			Owner: receipt.GitHubOwner, Repository: repositoryName, PluginSource: bootstrap.AgentPluginsReferenceRepository,
		})
		if err != nil || item.TemplateVersion != rendered.Version || item.TemplateDigest != rendered.Digest {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: cannot migrate mismatched template evidence")
		}
		item.RequiredPaths = make([]string, 0, len(rendered.Files))
		for _, file := range rendered.Files {
			item.RequiredPaths = append(item.RequiredPaths, file.Path)
		}
	}
	receipt.SchemaVersion = receiptSchemaV3
	return nil
}

func inspectReceiptPath(root string) (string, bool, os.FileInfo, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: invalid Installation root: %w", err)
	}
	rootInfo, err := os.Lstat(absoluteRoot)
	if os.IsNotExist(err) {
		return filepath.Join(absoluteRoot, ".agx", initializationFile), false, nil, nil
	}
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect Installation root: %w", err)
	}
	if err := requireRealMetadataEntry(absoluteRoot, rootInfo, true, "Installation root"); err != nil {
		return "", false, nil, err
	}

	directory := filepath.Join(absoluteRoot, ".agx")
	directoryInfo, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		return filepath.Join(directory, initializationFile), false, nil, nil
	}
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect metadata directory: %w", err)
	}
	if err := requireRealMetadataEntry(directory, directoryInfo, true, "metadata directory"); err != nil {
		return "", false, nil, err
	}

	path := filepath.Join(directory, initializationFile)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return path, false, nil, nil
	}
	if err != nil {
		return "", false, nil, fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect initialization receipt: %w", err)
	}
	if err := requireRealMetadataEntry(path, info, false, "initialization receipt"); err != nil {
		return "", false, nil, err
	}
	return path, true, info, nil
}

func requireRealMetadataEntry(path string, info os.FileInfo, directory bool, label string) error {
	reparse, err := metadataPathIsReparsePoint(path)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-READ: cannot inspect %s attributes: %w", label, err)
	}
	validType := info.Mode().IsRegular()
	if directory {
		validType = info.Mode().IsDir()
	}
	if reparse || info.Mode()&os.ModeSymlink != 0 || !validType {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: %s must be a real %s", label, map[bool]string{true: "directory", false: "regular file"}[directory])
	}
	return nil
}

func evidenceBindingsMatchReceipt(receipt Receipt) bool {
	deployment := receipt.DeploymentBinding
	subject := receipt.SubjectBinding
	if deployment == nil || subject == nil {
		return false
	}
	control, controlErr := bootstrap.Render(bootstrap.KindAgentControl, bootstrap.Params{
		Owner: receipt.GitHubOwner, Repository: receipt.ControlRepository, PluginSource: bootstrap.AgentPluginsReferenceRepository,
	})
	contracts, contractsErr := bootstrap.Render(bootstrap.KindAgentContracts, bootstrap.Params{
		Owner: receipt.GitHubOwner, Repository: receipt.ContractsRepository, PluginSource: bootstrap.AgentPluginsReferenceRepository,
	})
	if controlErr != nil || contractsErr != nil {
		return false
	}
	projectTarget := buildProjectTarget(Options{
		GitHubOwner: receipt.GitHubOwner, ControlRepository: receipt.ControlRepository, Visibility: receipt.Visibility,
	}, receipt.InstallationID)
	projectSelector := strings.Join([]string{projectTarget.Owner, projectTarget.Title, projectTarget.LinkedRepository, string(projectTarget.Visibility)}, "\x00")
	contractTitle := "Bootstrap Verification [" + receipt.InstallationID + "]"
	contractMarker := "AGX-Installation: " + receipt.InstallationID
	firstUseSelector := strings.Join([]string{contractTitle, contractMarker, "agx/bootstrap-verification-" + receipt.InstallationID, "python tools/validate.py", "Validate control baseline", "validate"}, "\x00")
	expectedControl := domain.RepositoryBindingV1{
		IdentitySHA256:        domain.NamespacedIdentitySHA256("github", "repository", receipt.GitHubOwner+"/"+receipt.ControlRepository),
		RenderedContentSHA256: control.Digest,
	}
	expectedContracts := domain.RepositoryBindingV1{
		IdentitySHA256:        domain.NamespacedIdentitySHA256("github", "repository", receipt.GitHubOwner+"/"+receipt.ContractsRepository),
		RenderedContentSHA256: contracts.Digest,
	}
	if deployment.TemplateVersion != receipt.TemplateVersion || deployment.TemplateSetSHA256 != receipt.TemplateContentSHA256 ||
		deployment.ProviderProfile != string(receipt.Profile) || deployment.ControlRepository != expectedControl ||
		deployment.ContractsRepository != expectedContracts ||
		deployment.ProjectIdentitySHA256 != domain.NamespacedIdentitySHA256("github", "project", projectSelector) ||
		deployment.FirstUseContractSHA256 != domain.NamespacedIdentitySHA256("agx", "first-use-contract", firstUseSelector) {
		return false
	}
	if len(receipt.Providers) > 0 {
		providers := make([]string, 0, len(receipt.Providers))
		for _, item := range receipt.Providers {
			providers = append(providers, string(item.Name))
		}
		if !sameStrings(deployment.SelectedProviders, providers) {
			return false
		}
	}
	expectedGitHub := domain.GitHubSubjectSelectorsV1{
		ControlRepositorySHA256: expectedControl.IdentitySHA256, ContractsRepositorySHA256: expectedContracts.IdentitySHA256,
		ProjectSelectorSHA256:     deployment.ProjectIdentitySHA256,
		IssueSelectorSHA256:       domain.NamespacedIdentitySHA256("github", "issue", contractTitle+"\x00"+contractMarker),
		PullRequestSelectorSHA256: domain.NamespacedIdentitySHA256("github", "pull_request", contractTitle+"\x00"+contractMarker),
		BranchSelectorSHA256:      domain.NamespacedIdentitySHA256("github", "branch", "agx/bootstrap-verification-"+receipt.InstallationID),
		WorkflowSHA256:            domain.NamespacedIdentitySHA256("github", "workflow", bootstrap.AgentControlValidationWorkflowSHA256),
		CheckSelectorSHA256:       domain.NamespacedIdentitySHA256("github", "check", "validate"),
	}
	if subject.InstallationMarkerSHA256 != domain.NamespacedIdentitySHA256("agx", "installation", receipt.InstallationID) ||
		subject.GitHubSelectors != expectedGitHub {
		return false
	}
	if receipt.EvidenceProfile == domain.EvidenceProfileMulticaExecutionV1 {
		return subject.MulticaSelectors != nil && subject.MulticaSelectors.ExecutionMarkerSHA256 == domain.NamespacedIdentitySHA256("multica", "execution", receipt.InstallationID)
	}
	return subject.MulticaSelectors == nil
}

func validateReceipt(receipt Receipt) error {
	deployment := receipt.GitHubOwner != "" || receipt.ControlRepository != "" || receipt.ContractsRepository != "" || receipt.Project != nil ||
		receipt.Visibility != "" || receipt.TemplateVersion != "" || receipt.TemplateContentSHA256 != "" || len(receipt.Repositories) > 0
	if deployment {
		if receipt.GitHubOwner == "" || receipt.ControlRepository == "" || receipt.ContractsRepository == "" ||
			(receipt.Visibility != repository.VisibilityPrivate && receipt.Visibility != repository.VisibilityPublic) ||
			receipt.TemplateVersion != bootstrap.TemplateSetVersion || receipt.TemplateContentSHA256 != bootstrap.TemplateSetContentSHA256 ||
			len(receipt.Repositories) > 2 {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: deployment metadata is inconsistent")
		}
		expected := map[string]bool{
			strings.ToLower(receipt.GitHubOwner + "/" + receipt.ControlRepository):   true,
			strings.ToLower(receipt.GitHubOwner + "/" + receipt.ContractsRepository): true,
		}
		seen := map[string]bool{}
		for _, item := range receipt.Repositories {
			key := strings.ToLower(item.NameWithOwner)
			kind := bootstrap.KindAgentControl
			repositoryName := receipt.ControlRepository
			if key == strings.ToLower(receipt.GitHubOwner+"/"+receipt.ContractsRepository) {
				kind = bootstrap.KindAgentContracts
				repositoryName = receipt.ContractsRepository
			}
			rendered, renderErr := bootstrap.Render(kind, bootstrap.Params{
				Owner: receipt.GitHubOwner, Repository: repositoryName, PluginSource: bootstrap.AgentPluginsReferenceRepository,
			})
			pathsInvalid := (receipt.SchemaVersion == receiptSchemaV4 && len(item.RequiredPaths) == 0) ||
				(len(item.RequiredPaths) > 0 && !sameTemplatePaths(item.RequiredPaths, rendered.Files))
			if !expected[key] || seen[key] || item.Visibility != receipt.Visibility || item.InitialCommit == "" ||
				item.URL != "https://github.com/"+item.NameWithOwner || renderErr != nil ||
				item.TemplateVersion != rendered.Version || item.TemplateDigest != rendered.Digest || pathsInvalid ||
				(item.Verification != repository.VerificationReadback && item.Verification != repository.VerificationUncertain) {
				return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: repository ownership evidence is inconsistent")
			}
			seen[key] = true
		}
		if receipt.Phase == PhaseInitialized && len(seen) != 2 {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: initialized deployment must contain both repository receipts")
		}
		if receipt.Project != nil {
			target := buildProjectTarget(Options{
				GitHubOwner: receipt.GitHubOwner, ControlRepository: receipt.ControlRepository, Visibility: receipt.Visibility,
			}, receipt.InstallationID)
			if err := project.ValidateReceipt(*receipt.Project, target); err != nil {
				return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: Project ownership evidence is inconsistent")
			}
		}
	} else if len(receipt.Repositories) != 0 {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: repositories require deployment metadata")
	}
	if receipt.SchemaVersion == receiptSchemaV4 {
		if receipt.EvidenceProfile == "" || receipt.DeploymentBinding == nil || receipt.DeploymentDigest == "" || receipt.SubjectBinding == nil || receipt.SubjectDigest == "" ||
			receipt.DeploymentBinding.InstallationID != domain.InstallationID(receipt.InstallationID) ||
			receipt.SubjectBinding.Profile != receipt.EvidenceProfile || receipt.SubjectBinding.DeploymentDigest != receipt.DeploymentDigest ||
			!evidenceBindingsMatchReceipt(receipt) {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: evidence binding is missing or inconsistent")
		}
		deploymentDigest, err := domain.ComputeDeploymentDigest(*receipt.DeploymentBinding)
		if err != nil || deploymentDigest != receipt.DeploymentDigest {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: deployment evidence binding is inconsistent")
		}
		subjectDigest, err := domain.ComputeSubjectDigest(*receipt.SubjectBinding)
		if err != nil || subjectDigest != receipt.SubjectDigest {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: subject evidence binding is inconsistent")
		}
	} else if receipt.EvidenceProfile != "" || receipt.DeploymentBinding != nil || receipt.DeploymentDigest != "" || receipt.SubjectBinding != nil || receipt.SubjectDigest != "" {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: legacy receipt contains unsupported evidence metadata")
	}
	selected, err := Plugins(receipt.Profile)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: unsupported profile")
	}
	providers := make([]provider.Name, 0, len(receipt.Providers))
	for _, item := range receipt.Providers {
		providers = append(providers, item.Name)
		if !sameStrings(item.SelectedPlugins, selected) {
			return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: selected plugins do not match profile")
		}
		seenAdded := map[string]bool{}
		for _, pluginName := range item.AddedPlugins {
			if seenAdded[pluginName] || !contains(item.SelectedPlugins, pluginName) {
				return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: added plugins are inconsistent")
			}
			seenAdded[pluginName] = true
		}
	}
	if len(providers) == 0 {
		if deployment && (receipt.Phase == PhaseProvisioning || receipt.Phase == PhaseNeedsResume) {
			return nil
		}
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: provider list is missing")
	}
	normalized, err := normalizeProviders(providers)
	if err != nil || !sameProviders(receipt.Providers, normalized) {
		return fmt.Errorf("AGX-INIT-RECEIPT-INVALID: provider list is inconsistent")
	}
	return nil
}

func writeReceipt(root string, receipt Receipt) error {
	if err := validateReceipt(receipt); err != nil {
		return err
	}
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	data = append(data, '\n')
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: invalid Installation root: %w", err)
	}
	rootInfo, err := os.Lstat(absoluteRoot)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: cannot inspect Installation root: %w", err)
	}
	if err := requireRealMetadataEntry(absoluteRoot, rootInfo, true, "Installation root"); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: unsafe Installation root: %w", err)
	}
	directory := filepath.Join(absoluteRoot, ".agx")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: cannot inspect metadata directory: %w", err)
	}
	if err := requireRealMetadataEntry(directory, directoryInfo, true, "metadata directory"); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: unsafe metadata directory: %w", err)
	}
	target := filepath.Join(directory, initializationFile)
	if targetInfo, targetErr := os.Lstat(target); targetErr == nil {
		if err := requireRealMetadataEntry(target, targetInfo, false, "initialization receipt"); err != nil {
			return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: unsafe initialization receipt: %w", err)
		}
	} else if !os.IsNotExist(targetErr) {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: cannot inspect initialization receipt: %w", targetErr)
	}
	temporary, err := os.CreateTemp(directory, ".initialization-*.tmp")
	if err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	if err := os.Rename(temporaryName, target); err != nil {
		return fmt.Errorf("AGX-INIT-RECEIPT-WRITE: %w", err)
	}
	return nil
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func sameTemplatePaths(paths []string, files []bootstrap.File) bool {
	if len(paths) != len(files) {
		return false
	}
	expected := make(map[string]bool, len(files))
	for _, file := range files {
		expected[file.Path] = true
	}
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		if !expected[path] || seen[path] {
			return false
		}
		seen[path] = true
	}
	return true
}

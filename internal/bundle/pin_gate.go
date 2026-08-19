package bundle

import "strings"

const (
	deadUpstreamAgentControl = "zaurakworks/agent-control"
	leftoverAgentControlFork = "2233admin/agent-control"
	agentSystemSourceRepo    = "zaurakworks/agent-system"
	agentSystemForkRepo      = "2233admin/agent-system"
	// untaggedAgentSystemMainSHA is the Source main snapshot recorded in
	// issue #80 on 2026-08-19. It is not a Release tag and must not appear
	// as a production Bundle or template pin.
	untaggedAgentSystemMainSHA = "3b8e9dbafa252561d49412a083f5c1b8fdb9072a"
)

type pinRef struct {
	name       string
	repository string
	commit     string
	tag        string
}

func validatePinReferences(document Document) error {
	artifact := document.Sources.AgentPlugins
	for _, item := range []pinRef{
		{name: "sources.agent_plugins.upstream_repository", repository: artifact.UpstreamRepository, commit: artifact.CommitSHA, tag: artifact.ReleaseTag},
		{name: "sources.agent_plugins.distribution_repository", repository: artifact.DistributionRepository, commit: artifact.CommitSHA, tag: artifact.ReleaseTag},
		{name: "templates.references.agent_plugins", repository: document.Templates.References.AgentPlugins.Repository, commit: document.Templates.References.AgentPlugins.CommitSHA},
		{name: "templates.references.agent_control", repository: document.Templates.References.AgentControl.Repository, commit: document.Templates.References.AgentControl.CommitSHA},
		{name: "templates.references.agent_contracts", repository: document.Templates.References.AgentContracts.Repository, commit: document.Templates.References.AgentContracts.CommitSHA},
	} {
		repo := normalizeRepository(item.repository)
		if isDeadAgentControl(repo) {
			return provenanceError("%s must not point at renamed %s", item.name, repo)
		}
		if isAgentSystem(repo) && isUntaggedAgentSystemMain(item.tag, item.commit) {
			return provenanceError("%s must not pin untagged agent-system main", item.name)
		}
	}
	return nil
}

func normalizeRepository(value string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), ".git"))
}

func isDeadAgentControl(repository string) bool {
	switch repository {
	case deadUpstreamAgentControl, leftoverAgentControlFork:
		return true
	default:
		return false
	}
}

func isAgentSystem(repository string) bool {
	switch repository {
	case agentSystemSourceRepo, agentSystemForkRepo:
		return true
	default:
		return false
	}
}

func isUntaggedAgentSystemMain(tag, commit string) bool {
	switch strings.ToLower(strings.TrimSpace(tag)) {
	case "main", "head", "master":
		return true
	}
	return strings.EqualFold(strings.TrimSpace(commit), untaggedAgentSystemMainSHA)
}

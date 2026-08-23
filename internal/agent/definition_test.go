package agent

import (
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bundle"
)

func validDefinition() Definition {
	return Definition{SchemaVersion: SchemaVersion, ID: "deploy-agent", Instructions: "follow the contract", Runtime: "codex", Model: "gpt-5", Permissions: Permissions{Read: []string{"repo"}, Write: []string{"owned"}}, Resources: Resources{Concurrency: 1}, EvidencePolicy: EvidencePolicy{Profile: "github-delivery/v1", Required: []string{"issue", "validation"}}, SkillSet: []Skill{{ID: "delivery", Capability: "github.delivery", Source: bundle.AgentPluginsDistributionRepository, Release: "agx-plugins-20260819.1", Digest: strings.Repeat("a", 64), Provenance: bundle.ProvenanceGitHubRelease}}}
}

func TestValidateRejectsPromptOnlyAgent(t *testing.T) {
	d := Definition{SchemaVersion: SchemaVersion, ID: "cosplay-agent", Instructions: "I am a deployment agent"}
	diags := Validate(d)
	if len(diags) == 0 {
		t.Fatal("prompt/name-only definition must fail completeness validation")
	}
	for _, want := range []string{"AGX-AGENT-RUNTIME", "AGX-AGENT-EVIDENCE", "AGX-AGENT-PERMISSIONS", "AGX-AGENT-SKILLS"} {
		found := false
		for _, d := range diags {
			if d.Code == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing diagnostic %s", want)
		}
	}
}

func TestValidateRejectsMutableSkillAndDevelopmentProvenance(t *testing.T) {
	d := validDefinition()
	d.SkillSet[0].Release = "latest"
	d.SkillSet[0].Digest = "not-a-digest"
	d.SkillSet[0].Provenance = bundle.ProvenanceSynthetic
	if _, err := BuildPlan(d); err == nil || !strings.Contains(err.Error(), "AGX-AGENT-PREFLIGHT") {
		t.Fatalf("BuildPlan error = %v, want preflight failure", err)
	}
}

func TestSortedSkillIDsStable(t *testing.T) {
	d := validDefinition()
	d.SkillSet = append(d.SkillSet, Skill{ID: "alpha"})
	got := SortedSkillIDs(d)
	if got[0] != "alpha" || got[1] != "delivery" {
		t.Fatalf("got %v", got)
	}
}

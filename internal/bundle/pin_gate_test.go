package bundle_test

import (
	"strings"
	"testing"

	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/bundle"
)

func TestProductionPinReferenceGateRejectsDeadControlAndUntaggedMain(t *testing.T) {
	document := decodeFixture(t, "production-valid.json")
	artifact := document.Sources.AgentPlugins
	if artifact.ReleaseTag != "agx-plugins-20260819.1" || artifact.CommitSHA != "ef07a9fd530ebac1b85eb5b9511ebd6742d743ee" {
		t.Fatalf("production plugin pin changed: %#v", artifact)
	}
	if document.Templates.References.AgentControl.Repository == "zaurakworks/agent-control" {
		t.Fatal("production template refs still point at renamed zaurakworks/agent-control")
	}
	if document.Templates.References.AgentControl.CommitSHA == "3b8e9dbafa252561d49412a083f5c1b8fdb9072a" {
		t.Fatal("production template refs pin untagged agent-system main")
	}

	tests := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{
			name: "dead upstream agent-control template ref",
			mutate: func(document map[string]any) {
				templateReference(document, "agent_control")["repository"] = "zaurakworks/agent-control"
			},
			want: "must not point at renamed zaurakworks/agent-control",
		},
		{
			name: "leftover agent-control fork template ref",
			mutate: func(document map[string]any) {
				templateReference(document, "agent_control")["repository"] = "2233admin/agent-control"
			},
			want: "must not point at renamed 2233admin/agent-control",
		},
		{
			name: "untagged agent-system main template sha",
			mutate: func(document map[string]any) {
				templateReference(document, "agent_control")["repository"] = "zaurakworks/agent-system"
				templateReference(document, "agent_control")["commit_sha"] = "3b8e9dbafa252561d49412a083f5c1b8fdb9072a"
			},
			want: "must not pin untagged agent-system main",
		},
		{
			name: "agent-system plugin pin with main tag",
			mutate: func(document map[string]any) {
				agentPlugins(document)["upstream_repository"] = "zaurakworks/agent-system"
				agentPlugins(document)["release_tag"] = "main"
			},
			want: "must not pin untagged agent-system main",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := bundle.Decode(mutateFixture(t, "production-valid.json", test.mutate))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Decode() error = %v, want %q", err, test.want)
			}
			if !strings.HasPrefix(err.Error(), "AGX-BUNDLE-PROVENANCE") {
				t.Fatalf("Decode() error = %v, want provenance prefix", err)
			}
		})
	}
}

func TestBootstrapTemplateRefsAreNotForbiddenPins(t *testing.T) {
	if bootstrap.AgentControlReferenceRepository == "zaurakworks/agent-control" ||
		bootstrap.AgentControlReferenceRepository == "2233admin/agent-control" {
		t.Fatalf("template control reference still uses dead agent-control name %q", bootstrap.AgentControlReferenceRepository)
	}
	if bootstrap.AgentControlReferenceCommit == "3b8e9dbafa252561d49412a083f5c1b8fdb9072a" {
		t.Fatal("template control reference pins untagged agent-system main")
	}
	if bootstrap.AgentPluginsReferenceRepository != "zaurakworks/agent-plugins" {
		t.Fatalf("plugin template reference = %q", bootstrap.AgentPluginsReferenceRepository)
	}
}

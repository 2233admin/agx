// Package agent models the deployment-owned AgentDefinition contract.
package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/2233admin/agx/internal/bootstrap"
	"github.com/2233admin/agx/internal/bundle"
)

const SchemaVersion = "agx.agent-definition/v1"

type Skill struct {
	ID         string            `json:"id"`
	Capability string            `json:"capability"`
	Source     string            `json:"source"`
	Release    string            `json:"release"`
	Digest     string            `json:"digest"`
	Provenance bundle.Provenance `json:"provenance"`
}
type Permissions struct {
	Read    []string `json:"read"`
	Write   []string `json:"write"`
	Network []string `json:"network"`
}
type Resources struct {
	Concurrency int    `json:"concurrency"`
	CPU         string `json:"cpu,omitempty"`
	Memory      string `json:"memory,omitempty"`
}
type EvidencePolicy struct {
	Profile  string   `json:"profile"`
	Required []string `json:"required"`
}
type Definition struct {
	SchemaVersion  string         `json:"schema_version"`
	ID             string         `json:"id"`
	Instructions   string         `json:"instructions"`
	SkillSet       []Skill        `json:"skill_set"`
	Runtime        string         `json:"runtime"`
	Model          string         `json:"model"`
	Permissions    Permissions    `json:"permissions"`
	Resources      Resources      `json:"resources"`
	EvidencePolicy EvidencePolicy `json:"evidence_policy"`
}
type Diagnostic struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Plan struct {
	Definition       Definition     `json:"definition"`
	DefinitionDigest string         `json:"definition_digest"`
	Skills           []Skill        `json:"skills"`
	Runtime          string         `json:"runtime"`
	Model            string         `json:"model"`
	Permissions      Permissions    `json:"permissions"`
	Resources        Resources      `json:"resources"`
	EvidencePolicy   EvidencePolicy `json:"evidence_policy"`
	Actions          []string       `json:"actions"`
	Diagnostics      []Diagnostic   `json:"diagnostics,omitempty"`
}
type Receipt struct {
	SchemaVersion     string            `json:"schema_version"`
	AgentID           string            `json:"agent_id"`
	DefinitionDigest  string            `json:"definition_digest"`
	SkillDigests      map[string]string `json:"skill_digests"`
	Runtime           string            `json:"runtime"`
	RuntimeCapability string            `json:"runtime_capability"`
	EvidenceReady     bool              `json:"evidence_ready"`
	Provenance        string            `json:"provenance"`
}
type Status struct {
	Present     bool         `json:"present"`
	Receipt     *Receipt     `json:"receipt,omitempty"`
	Diagnostics []Diagnostic `json:"diagnostics,omitempty"`
}

var idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{2,62}$`)
var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func diag(code, message string) Diagnostic { return Diagnostic{Code: code, Message: message} }

// Validate performs all checks before any apply-side effect. Names and prompts
// are deliberately insufficient: capability, immutable provenance and the
// complete contract are required for an AgentDefinition to be valid.
func Validate(d Definition) []Diagnostic {
	var out []Diagnostic
	if d.SchemaVersion != SchemaVersion {
		out = append(out, diag("AGX-AGENT-SCHEMA", "schema_version must be "+SchemaVersion))
	}
	if !idPattern.MatchString(d.ID) {
		out = append(out, diag("AGX-AGENT-ID", "id must be a stable lowercase identifier"))
	}
	if strings.TrimSpace(d.Instructions) == "" {
		out = append(out, diag("AGX-AGENT-INSTRUCTIONS", "instructions are required"))
	}
	if strings.TrimSpace(d.Runtime) == "" {
		out = append(out, diag("AGX-AGENT-RUNTIME", "runtime is required"))
	}
	if strings.TrimSpace(d.Model) == "" {
		out = append(out, diag("AGX-AGENT-MODEL", "model is required"))
	}
	if strings.TrimSpace(d.EvidencePolicy.Profile) == "" || len(d.EvidencePolicy.Required) == 0 {
		out = append(out, diag("AGX-AGENT-EVIDENCE", "evidence policy profile and required evidence are required"))
	}
	if d.Resources.Concurrency < 1 {
		out = append(out, diag("AGX-AGENT-RESOURCES", "resources.concurrency must be positive"))
	}
	if len(d.Permissions.Read)+len(d.Permissions.Write)+len(d.Permissions.Network) == 0 {
		out = append(out, diag("AGX-AGENT-PERMISSIONS", "permission boundaries are required"))
	}
	if len(d.SkillSet) == 0 {
		out = append(out, diag("AGX-AGENT-SKILLS", "at least one skill capability is required"))
	}
	seen := map[string]bool{}
	for _, s := range d.SkillSet {
		if strings.TrimSpace(s.ID) == "" || strings.TrimSpace(s.Capability) == "" {
			out = append(out, diag("AGX-AGENT-SKILL-CAPABILITY", "each skill requires id and capability"))
		}
		if seen[s.ID] {
			out = append(out, diag("AGX-AGENT-SKILL-DUPLICATE", "skill ids must be unique: "+s.ID))
		}
		seen[s.ID] = true
		if s.Provenance != bundle.ProvenanceGitHubRelease {
			out = append(out, diag("AGX-AGENT-SKILL-PROVENANCE", "production skills require immutable github_release provenance: "+s.ID))
		}
		if strings.TrimSpace(s.Source) != bundle.AgentPluginsDistributionRepository || strings.TrimSpace(s.Release) == "" || s.Release == "main" || s.Release == "latest" || !shaPattern.MatchString(strings.ToLower(s.Digest)) {
			out = append(out, diag("AGX-AGENT-SKILL-PIN", "skill must use the agent-plugins immutable Release and verified digest: "+s.ID))
		}
	}
	return out
}

func digest(d Definition) (string, error) {
	b, err := json.Marshal(d)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func BuildPlan(d Definition) (Plan, error) {
	p := Plan{Definition: d, Runtime: d.Runtime, Model: d.Model, Permissions: d.Permissions, Resources: d.Resources, EvidencePolicy: d.EvidencePolicy, Skills: d.SkillSet, Actions: []string{"validate AgentDefinition", "write deployment-owned agent-control/agent-contracts configuration"}}
	p.DefinitionDigest, _ = digest(d)
	p.Diagnostics = Validate(d)
	if len(p.Diagnostics) > 0 {
		return p, fmt.Errorf("AGX-AGENT-PREFLIGHT: %s", p.Diagnostics[0].Message)
	}
	return p, nil
}

func writeOwned(path string, data []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if bytes.Equal(existing, data) {
			return nil
		}
		return fmt.Errorf("AGX-AGENT-CONFLICT: deployment-owned file %s differs; inspect or reconcile it", filepath.Base(path))
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// Apply writes only deployment-owned metadata and the two versioned bootstrap
// trees. It never copies history, receipts, credentials, paths, or live state.
func Apply(root string, d Definition) (Receipt, bool, error) {
	p, err := BuildPlan(d)
	if err != nil {
		return Receipt{}, false, err
	}
	control, err := bootstrap.Render(bootstrap.KindAgentControl, bootstrap.Params{Owner: "deployment", Repository: "agent-control", PluginSource: bundle.AgentPluginsDistributionRepository})
	if err != nil {
		return Receipt{}, false, err
	}
	contracts, err := bootstrap.Render(bootstrap.KindAgentContracts, bootstrap.Params{Owner: "deployment", Repository: "agent-contracts", PluginSource: bundle.AgentPluginsDistributionRepository})
	if err != nil {
		return Receipt{}, false, err
	}
	if err = bootstrap.Write(filepath.Join(root, "agent-control"), control); err != nil {
		return Receipt{}, false, err
	}
	if err = bootstrap.Write(filepath.Join(root, "agent-contracts"), contracts); err != nil {
		return Receipt{}, false, err
	}
	receipt := Receipt{SchemaVersion: SchemaVersion, AgentID: d.ID, DefinitionDigest: p.DefinitionDigest, Runtime: d.Runtime, RuntimeCapability: d.Runtime, EvidenceReady: false, Provenance: "verified"}
	receipt.SkillDigests = map[string]string{}
	for _, s := range d.SkillSet {
		receipt.SkillDigests[s.ID] = s.Digest
	}
	b, _ := json.MarshalIndent(receipt, "", "  ")
	b = append(b, '\n')
	path := filepath.Join(root, ".agx", "agent-definition.receipt.json")
	existing, readErr := os.ReadFile(path)
	unchanged := readErr == nil && bytes.Equal(existing, b)
	if err = writeOwned(path, b); err != nil {
		return Receipt{}, false, err
	}
	return receipt, unchanged, nil
}

func StatusAt(root string) (Status, error) {
	path := filepath.Join(root, ".agx", "agent-definition.receipt.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, err
	}
	var r Receipt
	if json.Unmarshal(b, &r) != nil {
		return Status{Present: true, Diagnostics: []Diagnostic{diag("AGX-AGENT-RECEIPT", "receipt is not valid JSON")}}, nil
	}
	return Status{Present: true, Receipt: &r}, nil
}

func SortedSkillIDs(d Definition) []string {
	ids := make([]string, 0, len(d.SkillSet))
	for _, s := range d.SkillSet {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}

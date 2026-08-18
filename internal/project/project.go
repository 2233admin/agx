// Package project provisions and verifies one GitHub Project for an AGX
// Installation. It never adopts or deletes a Project.
package project

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Visibility string

type Verification string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityPublic  Visibility = "public"

	VerificationCreated    Verification = "created"
	VerificationConfigured Verification = "configured"
	VerificationReadback   Verification = "readback_matched"
)

type Target struct {
	Owner            string     `json:"owner"`
	Title            string     `json:"title"`
	Visibility       Visibility `json:"visibility"`
	LinkedRepository string     `json:"linked_repository"`
	InstallationID   string     `json:"installation_id"`
}

type Receipt struct {
	Owner            string       `json:"owner"`
	Number           int          `json:"number"`
	NodeID           string       `json:"node_id"`
	URL              string       `json:"url"`
	Title            string       `json:"title"`
	Visibility       Visibility   `json:"visibility"`
	LinkedRepository string       `json:"linked_repository"`
	InstallationID   string       `json:"installation_id"`
	Created          bool         `json:"created"`
	Linked           bool         `json:"linked"`
	Verification     Verification `json:"verification"`
}

type Runner interface {
	LookPath(name string) (string, error)
	Run(ctx context.Context, dir, name string, args ...string) ([]byte, error)
}

type OSRunner struct{}

func (OSRunner) LookPath(name string) (string, error) {
	return exec.LookPath(name)
}

func (OSRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	output, err := command.Output()
	if err != nil {
		return output, fmt.Errorf("project command %q failed: %w", name, err)
	}
	return output, nil
}

// Provision creates or resumes one receipt-bound Project. Journal is invoked
// after every confirmed external mutation so callers can persist recovery
// evidence before the next mutation begins.
func Provision(ctx context.Context, target Target, existing *Receipt, runner Runner, journal func(Receipt) error) (Receipt, error) {
	runner = defaultRunner(runner)
	if err := validateTarget(target); err != nil {
		return Receipt{}, err
	}
	if journal == nil {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-JOURNAL: recovery journal is required")
	}
	if err := requireCLI(runner); err != nil {
		return Receipt{}, err
	}

	var receipt Receipt
	if existing == nil {
		if err := Preflight(ctx, target, runner); err != nil {
			return Receipt{}, err
		}
		output, err := runner.Run(ctx, "", "gh", "project", "create", "--owner", target.Owner, "--title", target.Title, "--format", "json")
		if err != nil {
			observed, found, recoveryErr := findTargetProject(ctx, target, runner)
			if recoveryErr != nil {
				return Receipt{}, fmt.Errorf("AGX-PROJECT-CREATE-UNCERTAIN: create failed and inventory was inconclusive: %v; inventory: %w", err, recoveryErr)
			}
			if !found {
				return Receipt{}, fmt.Errorf("AGX-PROJECT-CREATE: cannot create Project: %w", err)
			}
			recovered, receiptErr := receiptFromProject(target, observed)
			if receiptErr != nil {
				return Receipt{}, fmt.Errorf("AGX-PROJECT-CREATE-UNCERTAIN: create failed and discovered Project did not match: %v; readback: %w", err, receiptErr)
			}
			recovered.Verification = VerificationCreated
			if journalErr := journal(recovered); journalErr != nil {
				return recovered, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist recovered create receipt: %w", journalErr)
			}
			return recovered, fmt.Errorf("AGX-PROJECT-CREATE-PARTIAL: gh reported an error, but the uniquely marked Project was discovered: %w", err)
		}
		observed, err := decodeProject(output)
		if err != nil {
			return Receipt{}, fmt.Errorf("AGX-PROJECT-CREATE: invalid create response: %w", err)
		}
		receipt, err = receiptFromProject(target, observed)
		if err != nil {
			return Receipt{}, err
		}
		receipt.Verification = VerificationCreated
		if err := journal(receipt); err != nil {
			return receipt, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist create receipt: %w", err)
		}
	} else {
		receipt = *existing
		if err := ValidateReceipt(receipt, target); err != nil {
			return Receipt{}, err
		}
	}

	if receipt.Visibility != target.Visibility {
		output, editErr := runner.Run(ctx, "", "gh", "project", "edit", strconv.Itoa(receipt.Number), "--owner", target.Owner, "--visibility", strings.ToUpper(string(target.Visibility)), "--format", "json")
		if editErr != nil {
			updated, readbackErr := readProject(ctx, target, receipt.Number, runner)
			if readbackErr != nil {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY-UNCERTAIN: edit failed and readback was inconclusive: %v; readback: %w", editErr, readbackErr)
			}
			if updated.NodeID != receipt.NodeID || !strings.EqualFold(updated.URL, receipt.URL) {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY-UNCERTAIN: edit failed and readback Project identity changed: %w", editErr)
			}
			if updated.Visibility != target.Visibility {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY: edit failed and readback confirmed visibility %s: %w", updated.Visibility, editErr)
			}
			updated.Verification = VerificationConfigured
			if journalErr := journal(updated); journalErr != nil {
				return updated, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist recovered visibility receipt: %w", journalErr)
			}
			return updated, fmt.Errorf("AGX-PROJECT-VISIBILITY-PARTIAL: gh reported an error, but Project visibility was confirmed: %w", editErr)
		}
		observed, err := decodeProject(output)
		if err != nil {
			return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY: invalid edit response: %w", err)
		}
		updated, err := receiptFromProject(target, observed)
		if err != nil {
			return receipt, err
		}
		updated.Verification = VerificationConfigured
		receipt = updated
		if err := journal(receipt); err != nil {
			return receipt, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist visibility receipt: %w", err)
		}
	}

	if !receipt.Linked {
		repositoryName := strings.TrimPrefix(target.LinkedRepository, target.Owner+"/")
		_, linkErr := runner.Run(ctx, "", "gh", "project", "link", strconv.Itoa(receipt.Number), "--owner", target.Owner, "--repo", repositoryName)
		verified, readbackErr := inspect(ctx, target, receipt.Number, runner)
		if readbackErr != nil {
			if linkErr != nil {
				return receipt, fmt.Errorf("AGX-PROJECT-LINK-UNCERTAIN: link failed and readback was inconclusive: %v; readback: %w", linkErr, readbackErr)
			}
			return receipt, readbackErr
		}
		verified.Verification = VerificationReadback
		if err := journal(verified); err != nil {
			return verified, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist linked Project receipt: %w", err)
		}
		if linkErr != nil {
			return verified, fmt.Errorf("AGX-PROJECT-LINK-PARTIAL: gh reported an error, but the Project link was confirmed: %w", linkErr)
		}
		return verified, nil
	}
	verified, err := inspect(ctx, target, receipt.Number, runner)
	if err != nil {
		return receipt, err
	}
	verified.Verification = VerificationReadback
	if err := journal(verified); err != nil {
		return verified, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist linked Project receipt: %w", err)
	}
	return verified, nil
}

// Preflight proves gh authentication, project scope, owner inventory access,
// and title absence without mutating local or remote state.
func Preflight(ctx context.Context, target Target, runner Runner) error {
	runner = defaultRunner(runner)
	if err := validateTarget(target); err != nil {
		return err
	}
	if err := requireCLI(runner); err != nil {
		return err
	}
	output, err := runner.Run(ctx, "", "gh", "auth", "status", "--active", "--json", "hosts")
	if err != nil {
		return fmt.Errorf("AGX-PROJECT-AUTH: cannot inspect GitHub CLI authentication: %w", err)
	}
	if !hasProjectScope(output) {
		return fmt.Errorf("AGX-PROJECT-SCOPE: active GitHub CLI token lacks project scope; run gh auth refresh -s project")
	}
	output, err = runner.Run(ctx, "", "gh", "project", "list", "--owner", target.Owner, "--closed", "--limit", "1000", "--format", "json")
	if err != nil {
		return fmt.Errorf("AGX-PROJECT-INVENTORY: cannot list Projects for %s: %w", target.Owner, err)
	}
	var inventory struct {
		Projects   []projectJSON `json:"projects"`
		TotalCount int           `json:"totalCount"`
	}
	if err := decodeJSON(output, &inventory); err != nil {
		return fmt.Errorf("AGX-PROJECT-INVENTORY: invalid Project inventory: %w", err)
	}
	if inventory.TotalCount > len(inventory.Projects) {
		return fmt.Errorf("AGX-PROJECT-INVENTORY: Project inventory is truncated; refusing mutation")
	}
	for _, item := range inventory.Projects {
		if strings.EqualFold(strings.TrimSpace(item.Title), target.Title) {
			return fmt.Errorf("AGX-PROJECT-COLLISION: Project %q already exists for %s; AGX will not adopt it", target.Title, target.Owner)
		}
	}
	return nil
}

func findTargetProject(ctx context.Context, target Target, runner Runner) (projectJSON, bool, error) {
	output, err := runner.Run(ctx, "", "gh", "project", "list", "--owner", target.Owner, "--closed", "--limit", "1000", "--format", "json")
	if err != nil {
		return projectJSON{}, false, err
	}
	var inventory struct {
		Projects   []projectJSON `json:"projects"`
		TotalCount int           `json:"totalCount"`
	}
	if err := decodeJSON(output, &inventory); err != nil {
		return projectJSON{}, false, err
	}
	if inventory.TotalCount > len(inventory.Projects) {
		return projectJSON{}, false, fmt.Errorf("Project inventory is truncated")
	}
	var matches []projectJSON
	for _, item := range inventory.Projects {
		if item.Title == target.Title && strings.EqualFold(item.Owner.Login, target.Owner) {
			matches = append(matches, item)
		}
	}
	if len(matches) > 1 {
		return projectJSON{}, false, fmt.Errorf("multiple Projects match the Installation marker")
	}
	if len(matches) == 0 {
		return projectJSON{}, false, nil
	}
	return matches[0], true, nil
}

func Verify(ctx context.Context, target Target, receipt Receipt, runner Runner) error {
	runner = defaultRunner(runner)
	if err := validateTarget(target); err != nil {
		return err
	}
	if err := ValidateReceipt(receipt, target); err != nil {
		return err
	}
	if !receipt.Linked || receipt.Verification != VerificationReadback {
		return fmt.Errorf("AGX-PROJECT-RECEIPT: Project receipt is not fully linked and read back")
	}
	if err := requireCLI(runner); err != nil {
		return err
	}
	observed, err := inspect(ctx, target, receipt.Number, runner)
	if err != nil {
		return err
	}
	if observed.Number != receipt.Number || observed.NodeID != receipt.NodeID || !strings.EqualFold(observed.URL, receipt.URL) ||
		observed.Title != receipt.Title || observed.Visibility != receipt.Visibility || observed.LinkedRepository != receipt.LinkedRepository ||
		observed.InstallationID != receipt.InstallationID || !observed.Linked {
		return fmt.Errorf("AGX-PROJECT-DRIFT: Project readback no longer matches receipt")
	}
	return nil
}

type projectJSON struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Owner  struct {
		Login string `json:"login"`
	} `json:"owner"`
	Public *bool  `json:"public"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

func inspect(ctx context.Context, target Target, number int, runner Runner) (Receipt, error) {
	receipt, err := readProject(ctx, target, number, runner)
	if err != nil {
		return Receipt{}, err
	}
	output, err := runner.Run(ctx, "", "gh", "repo", "view", target.LinkedRepository, "--json", "hasIssuesEnabled,projectsV2")
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: cannot read control repository Project links: %w", err)
	}
	var repository struct {
		HasIssuesEnabled bool `json:"hasIssuesEnabled"`
		ProjectsV2       struct {
			Nodes []struct {
				ID     string `json:"id"`
				Number int    `json:"number"`
				Title  string `json:"title"`
				URL    string `json:"url"`
			} `json:"Nodes"`
		} `json:"projectsV2"`
	}
	if err := decodeJSON(output, &repository); err != nil {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: invalid repository Project inventory: %w", err)
	}
	if !repository.HasIssuesEnabled {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: Issues are disabled for %s", target.LinkedRepository)
	}
	for _, item := range repository.ProjectsV2.Nodes {
		if item.ID == receipt.NodeID && item.Number == receipt.Number && item.Title == receipt.Title && strings.EqualFold(item.URL, receipt.URL) {
			receipt.Linked = true
			return receipt, nil
		}
	}
	return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: Project is not linked to %s", target.LinkedRepository)
}

func readProject(ctx context.Context, target Target, number int, runner Runner) (Receipt, error) {
	output, err := runner.Run(ctx, "", "gh", "project", "view", strconv.Itoa(number), "--owner", target.Owner, "--format", "json")
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: cannot read Project: %w", err)
	}
	observed, err := decodeProject(output)
	if err != nil {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: invalid Project response: %w", err)
	}
	receipt, err := receiptFromProject(target, observed)
	if err != nil {
		return Receipt{}, err
	}
	if receipt.Number != number {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: Project number does not match target")
	}
	return receipt, nil
}

func receiptFromProject(target Target, observed projectJSON) (Receipt, error) {
	if observed.Public == nil || observed.ID == "" || observed.Number <= 0 || !strings.EqualFold(observed.Owner.Login, target.Owner) || observed.Title != target.Title || !validURL(observed.URL) {
		return Receipt{}, fmt.Errorf("AGX-PROJECT-READBACK: Project identity does not match target")
	}
	visibility := VisibilityPrivate
	if *observed.Public {
		visibility = VisibilityPublic
	}
	return Receipt{
		Owner: target.Owner, Number: observed.Number, NodeID: observed.ID, URL: observed.URL, Title: observed.Title,
		Visibility: visibility, LinkedRepository: target.LinkedRepository, InstallationID: target.InstallationID, Created: true,
	}, nil
}

func validateTarget(target Target) error {
	if !validName(target.Owner, 39) || strings.TrimSpace(target.Title) != target.Title || target.Title == "" || utf8.RuneCountInString(target.Title) > 256 || hasControl(target.Title) ||
		(target.Visibility != VisibilityPrivate && target.Visibility != VisibilityPublic) || strings.TrimSpace(target.InstallationID) != target.InstallationID || target.InstallationID == "" || hasControl(target.InstallationID) {
		return fmt.Errorf("AGX-PROJECT-TARGET: invalid Project target")
	}
	owner, name, ok := strings.Cut(target.LinkedRepository, "/")
	if !ok || !strings.EqualFold(owner, target.Owner) || !validName(name, 100) {
		return fmt.Errorf("AGX-PROJECT-TARGET: linked repository must belong to Project owner")
	}
	return nil
}

// ValidateReceipt checks local recovery evidence without contacting GitHub.
func ValidateReceipt(receipt Receipt, target Target) error {
	validEvidence := (receipt.Verification == VerificationCreated || receipt.Verification == VerificationConfigured) && !receipt.Linked ||
		receipt.Verification == VerificationReadback && receipt.Linked
	if receipt.Owner != target.Owner || receipt.Title != target.Title || receipt.LinkedRepository != target.LinkedRepository || receipt.InstallationID != target.InstallationID ||
		receipt.Number <= 0 || receipt.NodeID == "" || !validURL(receipt.URL) || !receipt.Created ||
		(receipt.Visibility != VisibilityPrivate && receipt.Visibility != VisibilityPublic) || !validEvidence {
		return fmt.Errorf("AGX-PROJECT-RECEIPT: Project receipt does not match target")
	}
	return nil
}

func hasProjectScope(data []byte) bool {
	var status struct {
		Hosts map[string][]struct {
			Active bool   `json:"active"`
			Scopes string `json:"scopes"`
		} `json:"hosts"`
	}
	if decodeJSON(data, &status) != nil {
		return false
	}
	for _, accounts := range status.Hosts {
		for _, account := range accounts {
			if !account.Active {
				continue
			}
			for _, scope := range strings.Split(account.Scopes, ",") {
				if strings.TrimSpace(scope) == "project" {
					return true
				}
			}
		}
	}
	return false
}

func decodeProject(data []byte) (projectJSON, error) {
	var value projectJSON
	if err := decodeJSON(data, &value); err != nil {
		return projectJSON{}, err
	}
	return value, nil
}

func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return nil
}

func requireCLI(runner Runner) error {
	if _, err := runner.LookPath("gh"); err != nil {
		return fmt.Errorf("AGX-PROJECT-CLI-MISSING: gh is unavailable")
	}
	return nil
}

func defaultRunner(runner Runner) Runner {
	if runner == nil {
		return OSRunner{}
	}
	return runner
}

func validURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && strings.EqualFold(parsed.Host, "github.com") && parsed.User == nil
}

func validName(value string, limit int) bool {
	if value == "" || len(value) > limit || value == "." || value == ".." {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' || character == '.' {
			continue
		}
		return false
	}
	return true
}

func hasControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

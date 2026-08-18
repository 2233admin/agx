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
		observed, decodeErr := decodeProject(output)
		if decodeErr != nil {
			return Receipt{}, fmt.Errorf("AGX-PROJECT-CREATE-UNCERTAIN: successful create response was invalid: %w", decodeErr)
		}
		created, receiptErr := receiptFromProject(target, observed)
		if receiptErr != nil {
			return Receipt{}, fmt.Errorf("AGX-PROJECT-CREATE-UNCERTAIN: successful create response did not match target: %w", receiptErr)
		}
		created.Verification = VerificationCreated
		if err := journal(created); err != nil {
			return created, fmt.Errorf("AGX-PROJECT-JOURNAL: cannot persist create receipt: %w", err)
		}
		confirmed, readbackErr := readProject(ctx, target, created.Number, runner)
		if readbackErr != nil {
			return created, fmt.Errorf("AGX-PROJECT-CREATE-UNCERTAIN: successful create readback was inconclusive: %w", readbackErr)
		}
		if !sameProjectIdentity(confirmed, created) || confirmed.Visibility != created.Visibility {
			return created, fmt.Errorf("AGX-PROJECT-CREATE-UNCERTAIN: successful create readback did not match create response")
		}
		receipt = confirmed
		receipt.Verification = VerificationCreated
	} else {
		receipt = *existing
		if err := Revalidate(ctx, target, receipt, runner); err != nil {
			return receipt, err
		}
	}

	if receipt.Visibility != target.Visibility {
		output, editErr := runner.Run(ctx, "", "gh", "project", "edit", strconv.Itoa(receipt.Number), "--owner", target.Owner, "--visibility", strings.ToUpper(string(target.Visibility)), "--format", "json")
		if editErr != nil {
			updated, readbackErr := readProject(ctx, target, receipt.Number, runner)
			if readbackErr != nil {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY-UNCERTAIN: edit failed and readback was inconclusive: %v; readback: %w", editErr, readbackErr)
			}
			if !sameProjectIdentity(updated, receipt) {
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
		observed, responseErr := decodeProject(output)
		var updated Receipt
		if responseErr == nil {
			updated, responseErr = receiptFromProject(target, observed)
			if responseErr == nil && !sameProjectIdentity(updated, receipt) {
				responseErr = fmt.Errorf("edit response Project identity changed")
			}
			if responseErr == nil && updated.Visibility != target.Visibility {
				responseErr = fmt.Errorf("edit response confirmed visibility %s", updated.Visibility)
			}
		}
		if responseErr != nil {
			recovered, readbackErr := readProject(ctx, target, receipt.Number, runner)
			if readbackErr != nil {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY-UNCERTAIN: edit response was inconclusive: %w; readback: %w", responseErr, readbackErr)
			}
			if !sameProjectIdentity(recovered, receipt) {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY-UNCERTAIN: readback Project identity changed after inconclusive edit response: %w", responseErr)
			}
			if recovered.Visibility != target.Visibility {
				return receipt, fmt.Errorf("AGX-PROJECT-VISIBILITY: readback confirmed visibility %s after inconclusive edit response: %w", recovered.Visibility, responseErr)
			}
			updated = recovered
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
	projects, err := decodeProjectInventory(output)
	if err != nil {
		return fmt.Errorf("AGX-PROJECT-INVENTORY: invalid Project inventory: %w", err)
	}
	for _, item := range projects {
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
	projects, err := decodeProjectInventory(output)
	if err != nil {
		return projectJSON{}, false, err
	}
	var matches []projectJSON
	for _, item := range projects {
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
	if observed.Number != receipt.Number || observed.NodeID != receipt.NodeID || observed.URL != receipt.URL ||
		observed.Title != receipt.Title || observed.Visibility != receipt.Visibility || observed.LinkedRepository != receipt.LinkedRepository ||
		observed.InstallationID != receipt.InstallationID || !observed.Linked {
		return fmt.Errorf("AGX-PROJECT-DRIFT: Project readback no longer matches receipt")
	}
	return nil
}

// Revalidate proves project scope and exact receipt-bound Project identity and
// visibility without requiring the repository link to be complete.
func Revalidate(ctx context.Context, target Target, receipt Receipt, runner Runner) error {
	runner = defaultRunner(runner)
	if err := validateTarget(target); err != nil {
		return err
	}
	if err := ValidateReceipt(receipt, target); err != nil {
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
	observed, err := readProject(ctx, target, receipt.Number, runner)
	if err != nil {
		return err
	}
	if !sameProjectIdentity(observed, receipt) || observed.Visibility != receipt.Visibility {
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
		if item.ID == receipt.NodeID && item.Number == receipt.Number && item.Title == receipt.Title && item.URL == receipt.URL {
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
	urlOwner, urlNumber, ok := projectCoordinates(observed.URL)
	if observed.Public == nil || observed.ID == "" || observed.Number <= 0 || !strings.EqualFold(observed.Owner.Login, target.Owner) || observed.Title != target.Title ||
		!ok || !strings.EqualFold(urlOwner, target.Owner) || urlNumber != observed.Number {
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

func sameProjectIdentity(left, right Receipt) bool {
	return left.Owner == right.Owner && left.Number == right.Number && left.NodeID == right.NodeID && left.Title == right.Title && left.URL == right.URL
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
	urlOwner, urlNumber, validProjectURL := projectCoordinates(receipt.URL)
	if receipt.Owner != target.Owner || receipt.Title != target.Title || receipt.LinkedRepository != target.LinkedRepository || receipt.InstallationID != target.InstallationID ||
		receipt.Number <= 0 || receipt.NodeID == "" || !validProjectURL || !strings.EqualFold(urlOwner, receipt.Owner) || urlNumber != receipt.Number || !receipt.Created ||
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
	var fields struct {
		ID     json.RawMessage `json:"id"`
		Number json.RawMessage `json:"number"`
		Owner  json.RawMessage `json:"owner"`
		Public json.RawMessage `json:"public"`
		Title  json.RawMessage `json:"title"`
		URL    json.RawMessage `json:"url"`
	}
	if err := decodeJSON(data, &fields); err != nil {
		return projectJSON{}, err
	}
	if len(fields.ID) == 0 || len(fields.Number) == 0 || len(fields.Owner) == 0 || len(fields.Public) == 0 || len(fields.Title) == 0 || len(fields.URL) == 0 {
		return projectJSON{}, fmt.Errorf("Project response is missing required fields")
	}
	var value projectJSON
	if err := decodeJSON(data, &value); err != nil {
		return projectJSON{}, err
	}
	urlOwner, urlNumber, validProjectURL := projectCoordinates(value.URL)
	if value.Public == nil || value.ID == "" || value.Number <= 0 || !validName(value.Owner.Login, 39) ||
		strings.TrimSpace(value.Title) != value.Title || value.Title == "" || utf8.RuneCountInString(value.Title) > 256 || hasControl(value.Title) ||
		!validProjectURL || !strings.EqualFold(urlOwner, value.Owner.Login) || urlNumber != value.Number {
		return projectJSON{}, fmt.Errorf("Project response has invalid required fields")
	}
	return value, nil
}

func decodeProjectInventory(data []byte) ([]projectJSON, error) {
	var fields struct {
		Projects   json.RawMessage `json:"projects"`
		TotalCount json.RawMessage `json:"totalCount"`
	}
	if err := decodeJSON(data, &fields); err != nil {
		return nil, err
	}
	if len(fields.Projects) == 0 || len(fields.TotalCount) == 0 || string(fields.Projects) == "null" || string(fields.TotalCount) == "null" {
		return nil, fmt.Errorf("Project inventory is missing required fields")
	}
	var projectsRaw []json.RawMessage
	if err := decodeJSON(fields.Projects, &projectsRaw); err != nil {
		return nil, fmt.Errorf("invalid projects field")
	}
	var totalCount int
	if err := decodeJSON(fields.TotalCount, &totalCount); err != nil || totalCount < 0 {
		return nil, fmt.Errorf("invalid totalCount field")
	}
	if totalCount > len(projectsRaw) {
		return nil, fmt.Errorf("Project inventory is truncated")
	}
	if totalCount != len(projectsRaw) {
		return nil, fmt.Errorf("Project inventory count is inconsistent")
	}
	projects := make([]projectJSON, len(projectsRaw))
	for index, raw := range projectsRaw {
		project, err := decodeProject(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid Project at index %d", index)
		}
		projects[index] = project
	}
	return projects, nil
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

func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return rejectDuplicateJSONKeys(data)
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

func projectCoordinates(value string) (string, int, bool) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery || parsed.Opaque != "" {
		return "", 0, false
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if !strings.HasPrefix(parsed.Path, "/") || len(parts) != 4 || (parts[0] != "users" && parts[0] != "orgs") || !validName(parts[1], 39) || parts[2] != "projects" {
		return "", 0, false
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil || number <= 0 || strconv.Itoa(number) != parts[3] {
		return "", 0, false
	}
	return parts[1], number, true
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

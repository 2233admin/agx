// Package smoke defines the versioned first-use contract and the structured
// evidence an Agent must produce before an Installation is considered
// effective. It does not schedule or perform daily work.
package smoke

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"unicode"
)

const ContractVersionV1 = "agx.first-use/v1"

const (
	StatusAwaiting  = "awaiting"
	StatusEffective = "effective"

	ValidationResultAwaiting        = "awaiting"
	ValidationResultPassed          = "passed"
	ValidationResultPendingOrFailed = "pending_or_failed"
)

type Contract struct {
	SchemaVersion            string   `json:"schema_version"`
	InstallationID           string   `json:"installation_id"`
	ProjectURL               string   `json:"project_url"`
	ProjectTitle             string   `json:"project_title"`
	ControlRepositoryURL     string   `json:"control_repository_url"`
	ContractsRepositoryURL   string   `json:"contracts_repository_url"`
	Profile                  string   `json:"profile"`
	Objective                string   `json:"objective"`
	IssueTitle               string   `json:"issue_title"`
	PullRequestTitle         string   `json:"pull_request_title"`
	Marker                   string   `json:"marker"`
	Branch                   string   `json:"branch"`
	ValidationCommand        string   `json:"validation_command"`
	ValidationWorkflow       string   `json:"validation_workflow"`
	ValidationCheck          string   `json:"validation_check"`
	ValidationWorkflowSHA256 string   `json:"validation_workflow_sha256"`
	RequiredActions          []string `json:"required_actions"`
	RequiredOutputs          []string `json:"required_outputs"`
	Cleanup                  string   `json:"cleanup"`
}

type Evidence struct {
	Status            string   `json:"status"`
	IssueURL          string   `json:"issue_url,omitempty"`
	IssueNumber       int      `json:"issue_number,omitempty"`
	ProjectItem       string   `json:"project_item,omitempty"`
	PullRequestURL    string   `json:"pull_request_url,omitempty"`
	PullRequestNumber int      `json:"pull_request_number,omitempty"`
	Revision          string   `json:"revision,omitempty"`
	WorkPointer       string   `json:"work_pointer,omitempty"`
	ValidationResult  string   `json:"validation_result,omitempty"`
	Problems          []string `json:"problems,omitempty"`
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
		return output, fmt.Errorf("smoke command %q failed: %w", name, err)
	}
	return output, nil
}

func Inspect(ctx context.Context, contract Contract, runner Runner) (Evidence, error) {
	slug, err := validateContract(contract)
	if err != nil {
		return Evidence{}, err
	}
	if runner == nil {
		runner = OSRunner{}
	}
	if _, err := runner.LookPath("gh"); err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-CLI-MISSING: gh is unavailable")
	}
	evidence := Evidence{Status: StatusAwaiting, ValidationResult: ValidationResultAwaiting}
	marker := contract.Marker
	projectOwner, projectNumber, err := projectCoordinates(contract.ProjectURL)
	if err != nil {
		return Evidence{}, err
	}
	if err := verifyProjectInventory(ctx, contract, projectOwner, projectNumber, runner); err != nil {
		return Evidence{}, err
	}

	issueOutput, err := runner.Run(ctx, "", "gh", "issue", "list", "--repo", slug, "--state", "all", "--limit", "20", "--search", contract.IssueTitle+" in:title", "--json", "number,url,title,body")
	if err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-ISSUE: cannot inspect Bootstrap Verification Issue: %w", err)
	}
	var issues []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
		Title  string `json:"title"`
		Body   string `json:"body"`
	}
	if err := decodeJSON(issueOutput, &issues); err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-ISSUE: invalid Issue inventory: %w", err)
	}
	for _, issue := range issues {
		owner, repositoryName, validURL := issueCoordinates(issue.URL)
		if issue.Title != contract.IssueTitle || !strings.Contains(issue.Body, marker) || !validURL ||
			!strings.EqualFold(owner+"/"+repositoryName, slug) || issue.Number <= 0 {
			continue
		}
		evidence.IssueURL = issue.URL
		evidence.IssueNumber = issue.Number
		break
	}
	if evidence.IssueURL == "" {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification Issue is missing")
	} else {
		projectOutput, projectErr := runner.Run(ctx, "", "gh", "project", "item-list", strconv.Itoa(projectNumber), "--owner", projectOwner, "--limit", "1000", "--format", "json")
		if projectErr != nil {
			return Evidence{}, fmt.Errorf("AGX-SMOKE-PROJECT: cannot inspect deployment Project items: %w", projectErr)
		}
		items, err := decodeProjectItems(projectOutput, slug)
		if err != nil {
			return Evidence{}, fmt.Errorf("AGX-SMOKE-PROJECT: invalid deployment Project item inventory: %w", err)
		}
		for _, item := range items {
			if item.URL == evidence.IssueURL {
				evidence.ProjectItem = item.ID
				break
			}
		}
		if evidence.ProjectItem == "" {
			evidence.Problems = append(evidence.Problems, "Bootstrap Verification Issue is not in the deployment Project")
		}
	}

	prOutput, err := runner.Run(ctx, "", "gh", "pr", "list", "--repo", slug, "--state", "all", "--limit", "20", "--search", contract.PullRequestTitle+" in:title", "--json", "number,url,title,body,headRefName,headRefOid,state,mergedAt,files,statusCheckRollup")
	if err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-PR: cannot inspect Bootstrap Verification PR: %w", err)
	}
	var pullRequests []struct {
		Number      int     `json:"number"`
		URL         string  `json:"url"`
		Title       string  `json:"title"`
		Body        string  `json:"body"`
		HeadRefName string  `json:"headRefName"`
		HeadRefOid  string  `json:"headRefOid"`
		State       string  `json:"state"`
		MergedAt    *string `json:"mergedAt"`
		Files       []struct {
			Path string `json:"path"`
		} `json:"files"`
		Checks []struct {
			Name         string `json:"name"`
			Context      string `json:"context"`
			WorkflowName string `json:"workflowName"`
			Status       string `json:"status"`
			Conclusion   string `json:"conclusion"`
		} `json:"statusCheckRollup"`
	}
	if err := decodeJSON(prOutput, &pullRequests); err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-PR: invalid PR inventory: %w", err)
	}
	for _, pullRequest := range pullRequests {
		owner, repositoryName, validURL := pullRequestCoordinates(pullRequest.URL)
		if pullRequest.Title != contract.PullRequestTitle || !strings.Contains(pullRequest.Body, marker) || !validURL ||
			!strings.EqualFold(owner+"/"+repositoryName, slug) || pullRequest.HeadRefName != contract.Branch ||
			!strings.EqualFold(pullRequest.State, "OPEN") || pullRequest.MergedAt != nil ||
			pullRequest.Number <= 0 || !validSHA1(pullRequest.HeadRefOid) {
			continue
		}
		evidence.PullRequestURL = pullRequest.URL
		evidence.PullRequestNumber = pullRequest.Number
		evidence.Revision = pullRequest.HeadRefOid
		bodyHasValidation := strings.Contains(pullRequest.Body, "Validation-Command: "+contract.ValidationCommand) &&
			strings.Contains(pullRequest.Body, "Validation-Result: passed")
		changedWorkPointer := false
		changedValidationWorkflow := false
		for _, file := range pullRequest.Files {
			if file.Path == "work/current.md" {
				changedWorkPointer = true
			}
			if file.Path == ".github/workflows/validate.yml" {
				changedValidationWorkflow = true
			}
		}
		checksPassed := len(pullRequest.Checks) > 0
		validationCheckPassed := false
		for _, check := range pullRequest.Checks {
			// GitHub's statusCheckRollup also contains StatusContext entries
			// (for example CodeRabbit and GitGuardian) without CheckRun status
			// or conclusion fields. They are not validation checks and must not
			// make an otherwise successful required CheckRun fail.
			if check.Status == "" && check.Conclusion == "" {
				continue
			}
			if !strings.EqualFold(check.Status, "COMPLETED") || !strings.EqualFold(check.Conclusion, "SUCCESS") {
				checksPassed = false
				continue
			}
			if strings.EqualFold(check.Name, contract.ValidationCheck) &&
				strings.EqualFold(check.WorkflowName, contract.ValidationWorkflow) {
				validationCheckPassed = true
			}
		}
		workflowMatches := false
		if !changedValidationWorkflow {
			endpoint := "repos/" + slug + "/contents/.github/workflows/validate.yml?ref=" + url.QueryEscape(contract.Branch)
			workflowOutput, workflowErr := runner.Run(ctx, "", "gh", "api", endpoint)
			if workflowErr == nil {
				workflowContent, decodeErr := decodeContentResponse(workflowOutput)
				if decodeErr == nil {
					digest := sha256.Sum256([]byte(strings.ReplaceAll(workflowContent, "\r\n", "\n")))
					workflowMatches = hex.EncodeToString(digest[:]) == contract.ValidationWorkflowSHA256 &&
						hasExactYAMLLine(workflowContent, "name: "+contract.ValidationWorkflow) &&
						hasExactYAMLLine(workflowContent, "  "+contract.ValidationCheck+":") &&
						hasExactYAMLLine(workflowContent, "        run: "+contract.ValidationCommand)
				}
			}
		}
		if checksPassed && validationCheckPassed && workflowMatches && bodyHasValidation {
			evidence.ValidationResult = ValidationResultPassed
		} else {
			evidence.ValidationResult = ValidationResultPendingOrFailed
		}
		if changedWorkPointer && evidence.IssueURL != "" {
			endpoint := "repos/" + slug + "/contents/work/current.md?ref=" + url.QueryEscape(contract.Branch)
			contentOutput, contentErr := runner.Run(ctx, "", "gh", "api", endpoint)
			if contentErr == nil {
				decoded, decodeErr := decodeContentResponse(contentOutput)
				if decodeErr == nil {
					if strings.Contains(decoded, evidence.IssueURL) && strings.Contains(decoded, marker) {
						evidence.WorkPointer = "work/current.md"
					}
				}
			}
		}
		break
	}
	if evidence.PullRequestURL == "" {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification PR is missing")
	} else if evidence.ValidationResult != ValidationResultPassed {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification validation has not passed")
	}
	if evidence.PullRequestURL != "" && evidence.WorkPointer == "" {
		evidence.Problems = append(evidence.Problems, "work/current.md does not point to the Bootstrap Verification Issue")
	}
	if evidence.IssueURL != "" && evidence.ProjectItem != "" && evidence.PullRequestURL != "" && evidence.WorkPointer != "" && evidence.ValidationResult == ValidationResultPassed {
		evidence.Status = StatusEffective
		evidence.Problems = nil
	}
	return evidence, nil
}

func validateContract(contract Contract) (string, error) {
	if contract.SchemaVersion != ContractVersionV1 || strings.TrimSpace(contract.InstallationID) == "" || strings.TrimSpace(contract.IssueTitle) == "" ||
		contract.ProjectTitle == "" || contract.PullRequestTitle == "" || contract.Marker != "AGX-Installation: "+contract.InstallationID ||
		!strings.HasPrefix(contract.Branch, "agx/bootstrap-verification-") || len(contract.RequiredActions) == 0 ||
		contract.ValidationCommand == "" || contract.ValidationWorkflow == "" || contract.ValidationCheck == "" ||
		!validSHA256(contract.ValidationWorkflowSHA256) ||
		contract.Objective != "complete bootstrap verification" || contract.Cleanup != "operator-owned" {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: invalid first-use contract")
	}
	controlOwner, controlRepository, valid := repositoryCoordinates(contract.ControlRepositoryURL)
	if !valid {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: invalid control repository URL")
	}
	contractsOwner, _, valid := repositoryCoordinates(contract.ContractsRepositoryURL)
	if !valid {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: invalid contracts repository URL")
	}
	if !strings.EqualFold(contractsOwner, controlOwner) {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: deployment repository owners do not match")
	}
	projectOwner, _, err := projectCoordinates(contract.ProjectURL)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(projectOwner, controlOwner) {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: Project owner does not match control repository owner")
	}
	return controlOwner + "/" + controlRepository, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validSHA1(value string) bool {
	if len(value) != 40 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func decodeContentResponse(data []byte) (string, error) {
	var content struct {
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	if err := decodeJSON(data, &content); err != nil {
		return "", err
	}
	if content.Encoding != "base64" {
		return "", fmt.Errorf("unexpected content encoding %q", content.Encoding)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(content.Content, "\n", ""))
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func hasExactYAMLLine(content, expected string) bool {
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if line == expected {
			return true
		}
	}
	return false
}

type projectItem struct {
	ID  string
	URL string
}

func decodeProjectItems(data []byte, controlRepository string) ([]projectItem, error) {
	var fields struct {
		Items      json.RawMessage `json:"items"`
		TotalCount json.RawMessage `json:"totalCount"`
	}
	if err := decodeJSON(data, &fields); err != nil || len(fields.Items) == 0 || len(fields.TotalCount) == 0 || string(fields.Items) == "null" || string(fields.TotalCount) == "null" {
		return nil, fmt.Errorf("missing Project item inventory fields")
	}
	var itemsRaw []json.RawMessage
	var total int
	if err := decodeJSON(fields.Items, &itemsRaw); err != nil {
		return nil, fmt.Errorf("invalid items field")
	}
	if err := decodeJSON(fields.TotalCount, &total); err != nil || total < 0 || total != len(itemsRaw) {
		return nil, fmt.Errorf("invalid totalCount field")
	}
	items := make([]projectItem, len(itemsRaw))
	seenIDs := make(map[string]struct{}, len(itemsRaw))
	seenURLs := make(map[string]struct{}, len(itemsRaw))
	for index, raw := range itemsRaw {
		var itemFields struct {
			ID      json.RawMessage `json:"id"`
			Content json.RawMessage `json:"content"`
		}
		if err := decodeJSON(raw, &itemFields); err != nil || len(itemFields.ID) == 0 || len(itemFields.Content) == 0 || string(itemFields.Content) == "null" {
			return nil, fmt.Errorf("invalid Project item at index %d", index)
		}
		var contentFields struct {
			URL json.RawMessage `json:"url"`
		}
		if err := decodeJSON(itemFields.Content, &contentFields); err != nil || len(contentFields.URL) == 0 {
			return nil, fmt.Errorf("invalid Project item content at index %d", index)
		}
		if err := decodeJSON(itemFields.ID, &items[index].ID); err != nil || !validNodeID(items[index].ID) {
			return nil, fmt.Errorf("invalid Project item id at index %d", index)
		}
		if err := decodeJSON(contentFields.URL, &items[index].URL); err != nil {
			return nil, fmt.Errorf("invalid Project item URL at index %d", index)
		}
		owner, repositoryName, validURL := issueCoordinates(items[index].URL)
		if !validURL || !strings.EqualFold(owner+"/"+repositoryName, controlRepository) {
			return nil, fmt.Errorf("invalid Project item URL at index %d", index)
		}
		if _, duplicate := seenIDs[items[index].ID]; duplicate {
			return nil, fmt.Errorf("duplicate Project item id at index %d", index)
		}
		urlKey := strings.ToLower(items[index].URL)
		if _, duplicate := seenURLs[urlKey]; duplicate {
			return nil, fmt.Errorf("duplicate Project item URL at index %d", index)
		}
		seenIDs[items[index].ID] = struct{}{}
		seenURLs[urlKey] = struct{}{}
	}
	return items, nil
}

func validNodeID(value string) bool {
	if value == "" || len(value) > 256 {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return false
		}
	}
	return true
}

func verifyProjectInventory(ctx context.Context, contract Contract, owner string, number int, runner Runner) error {
	limit := 100
	for attempts := 0; attempts < 8; attempts++ {
		output, err := runner.Run(ctx, "", "gh", "project", "list", "--owner", owner, "--closed", "--limit", strconv.Itoa(limit), "--format", "json")
		if err != nil {
			return fmt.Errorf("AGX-SMOKE-PROJECT-INVENTORY: cannot inspect owner Project inventory: %w", err)
		}
		projects, total, err := decodeProjectInventory(output)
		if err != nil {
			return fmt.Errorf("AGX-SMOKE-PROJECT-INVENTORY: invalid owner Project inventory: %w", err)
		}
		if total > len(projects) {
			if total <= limit {
				return fmt.Errorf("AGX-SMOKE-PROJECT-INVENTORY: Project inventory is truncated")
			}
			limit = total
			continue
		}
		if total != len(projects) {
			return fmt.Errorf("AGX-SMOKE-PROJECT-INVENTORY: Project inventory count is inconsistent")
		}
		matches := 0
		for _, item := range projects {
			if item.Number == number && item.Title == contract.ProjectTitle && item.URL == contract.ProjectURL {
				matches++
			}
		}
		if matches != 1 {
			return fmt.Errorf("AGX-SMOKE-PROJECT-INVENTORY: expected exactly one canonical Project match, found %d", matches)
		}
		return nil
	}
	return fmt.Errorf("AGX-SMOKE-PROJECT-INVENTORY: Project inventory changed during pagination")
}

type inventoryProject struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

func decodeProjectInventory(data []byte) ([]inventoryProject, int, error) {
	var fields struct {
		Projects   json.RawMessage `json:"projects"`
		TotalCount json.RawMessage `json:"totalCount"`
	}
	if err := decodeJSON(data, &fields); err != nil || len(fields.Projects) == 0 || len(fields.TotalCount) == 0 {
		return nil, 0, fmt.Errorf("missing Project inventory fields")
	}
	var projectsRaw []json.RawMessage
	var total int
	if err := decodeJSON(fields.Projects, &projectsRaw); err != nil {
		return nil, 0, fmt.Errorf("invalid projects field")
	}
	if err := decodeJSON(fields.TotalCount, &total); err != nil || total < 0 {
		return nil, 0, fmt.Errorf("invalid totalCount field")
	}
	projects := make([]inventoryProject, len(projectsRaw))
	seenIDs := make(map[string]struct{}, len(projectsRaw))
	seenNumbers := make(map[int]struct{}, len(projectsRaw))
	seenURLs := make(map[string]struct{}, len(projectsRaw))
	for index, raw := range projectsRaw {
		var required struct {
			ID     json.RawMessage `json:"id"`
			Number json.RawMessage `json:"number"`
			Title  json.RawMessage `json:"title"`
			URL    json.RawMessage `json:"url"`
		}
		if err := decodeJSON(raw, &required); err != nil || len(required.ID) == 0 || len(required.Number) == 0 || len(required.Title) == 0 || len(required.URL) == 0 {
			return nil, 0, fmt.Errorf("invalid Project at index %d", index)
		}
		if err := decodeJSON(raw, &projects[index]); err != nil {
			return nil, 0, fmt.Errorf("invalid Project at index %d", index)
		}
		_, projectNumber, err := projectCoordinates(projects[index].URL)
		if err != nil || projectNumber != projects[index].Number || strings.TrimSpace(projects[index].Title) != projects[index].Title || projects[index].Title == "" || !validNodeID(projects[index].ID) {
			return nil, 0, fmt.Errorf("invalid Project at index %d", index)
		}
		if _, duplicate := seenIDs[projects[index].ID]; duplicate {
			return nil, 0, fmt.Errorf("duplicate Project id at index %d", index)
		}
		seenIDs[projects[index].ID] = struct{}{}
		urlKey := strings.ToLower(projects[index].URL)
		if _, duplicate := seenURLs[urlKey]; duplicate {
			return nil, 0, fmt.Errorf("duplicate Project URL at index %d", index)
		}
		seenURLs[urlKey] = struct{}{}
		if _, duplicate := seenNumbers[projects[index].Number]; duplicate {
			return nil, 0, fmt.Errorf("duplicate Project number at index %d", index)
		}
		seenNumbers[projects[index].Number] = struct{}{}
	}
	return projects, total, nil
}

func projectCoordinates(value string) (string, int, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery || parsed.Opaque != "" {
		return "", 0, fmt.Errorf("AGX-SMOKE-CONTRACT: invalid Project URL")
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if !strings.HasPrefix(parsed.Path, "/") || len(parts) != 4 || (parts[0] != "orgs" && parts[0] != "users") || !validProjectOwner(parts[1]) || parts[2] != "projects" {
		return "", 0, fmt.Errorf("AGX-SMOKE-CONTRACT: invalid Project URL")
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil || number <= 0 || strconv.Itoa(number) != parts[3] {
		return "", 0, fmt.Errorf("AGX-SMOKE-CONTRACT: invalid Project URL")
	}
	return parts[1], number, nil
}

func validProjectOwner(value string) bool {
	if len(value) == 0 || len(value) > 39 || value[0] == '-' || value[len(value)-1] == '-' || strings.Contains(value, "--") {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return rejectDuplicateJSONKeys(data)
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
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

func repositoryCoordinates(value string) (string, string, bool) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery || parsed.Opaque != "" {
		return "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if !strings.HasPrefix(parsed.Path, "/") || len(parts) != 2 || !validProjectOwner(parts[0]) || !validRepositoryName(parts[1]) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func issueCoordinates(value string) (string, string, bool) {
	return repositoryResourceCoordinates(value, "issues")
}

func pullRequestCoordinates(value string) (string, string, bool) {
	return repositoryResourceCoordinates(value, "pull")
}

func repositoryResourceCoordinates(value, resource string) (string, string, bool) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery || parsed.Opaque != "" {
		return "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if !strings.HasPrefix(parsed.Path, "/") || len(parts) != 4 || !validProjectOwner(parts[0]) || !validRepositoryName(parts[1]) || parts[2] != resource {
		return "", "", false
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil || number <= 0 || strconv.Itoa(number) != parts[3] {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func validRepositoryName(value string) bool {
	if len(value) == 0 || len(value) > 100 || value == "." || value == ".." || strings.HasSuffix(strings.ToLower(value), ".git") {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

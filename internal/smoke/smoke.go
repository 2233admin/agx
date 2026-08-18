// Package smoke defines the versioned first-use contract and the structured
// evidence an Agent must produce before an Installation is considered
// effective. It does not schedule or perform daily work.
package smoke

import (
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
)

const ContractVersionV1 = "agx.first-use/v1"

const (
	StatusAwaiting  = "awaiting"
	StatusEffective = "effective"
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
	Status           string   `json:"status"`
	IssueURL         string   `json:"issue_url,omitempty"`
	ProjectItem      string   `json:"project_item,omitempty"`
	PullRequestURL   string   `json:"pull_request_url,omitempty"`
	WorkPointer      string   `json:"work_pointer,omitempty"`
	ValidationResult string   `json:"validation_result,omitempty"`
	Problems         []string `json:"problems,omitempty"`
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
	evidence := Evidence{Status: StatusAwaiting, ValidationResult: "awaiting"}
	marker := contract.Marker
	projectOwner, projectNumber, err := projectCoordinates(contract.ProjectURL)
	if err != nil {
		return Evidence{}, err
	}

	issueOutput, err := runner.Run(ctx, "", "gh", "issue", "list", "--repo", slug, "--state", "all", "--limit", "20", "--search", contract.IssueTitle+" in:title", "--json", "number,url,title,body")
	if err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-ISSUE: cannot inspect Bootstrap Verification Issue: %w", err)
	}
	var issues []struct {
		URL   string `json:"url"`
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := decodeJSON(issueOutput, &issues); err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-ISSUE: invalid Issue inventory: %w", err)
	}
	for _, issue := range issues {
		if issue.Title != contract.IssueTitle || !strings.Contains(issue.Body, marker) || !validGitHubURL(issue.URL) {
			continue
		}
		evidence.IssueURL = issue.URL
		break
	}
	if evidence.IssueURL == "" {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification Issue is missing")
	} else {
		projectOutput, projectErr := runner.Run(ctx, "", "gh", "project", "item-list", strconv.Itoa(projectNumber), "--owner", projectOwner, "--limit", "1000", "--format", "json")
		if projectErr != nil {
			return Evidence{}, fmt.Errorf("AGX-SMOKE-PROJECT: cannot inspect deployment Project items: %w", projectErr)
		}
		var inventory struct {
			TotalCount int `json:"totalCount"`
			Items      []struct {
				ID      string `json:"id"`
				Content struct {
					URL string `json:"url"`
				} `json:"content"`
			} `json:"items"`
		}
		if err := decodeJSON(projectOutput, &inventory); err != nil {
			return Evidence{}, fmt.Errorf("AGX-SMOKE-PROJECT: invalid deployment Project item inventory: %w", err)
		}
		if inventory.TotalCount > len(inventory.Items) {
			return Evidence{}, fmt.Errorf("AGX-SMOKE-PROJECT: deployment Project item inventory is truncated")
		}
		for _, item := range inventory.Items {
			if strings.EqualFold(item.Content.URL, evidence.IssueURL) {
				evidence.ProjectItem = item.ID
				if evidence.ProjectItem == "" {
					evidence.ProjectItem = evidence.IssueURL
				}
				break
			}
		}
		if evidence.ProjectItem == "" {
			evidence.Problems = append(evidence.Problems, "Bootstrap Verification Issue is not in the deployment Project")
		}
	}

	prOutput, err := runner.Run(ctx, "", "gh", "pr", "list", "--repo", slug, "--state", "all", "--limit", "20", "--search", contract.PullRequestTitle+" in:title", "--json", "number,url,title,body,headRefName,state,mergedAt,files,statusCheckRollup")
	if err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-PR: cannot inspect Bootstrap Verification PR: %w", err)
	}
	var pullRequests []struct {
		URL         string  `json:"url"`
		Title       string  `json:"title"`
		Body        string  `json:"body"`
		HeadRefName string  `json:"headRefName"`
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
		if pullRequest.Title != contract.PullRequestTitle || !strings.Contains(pullRequest.Body, marker) || !validGitHubURL(pullRequest.URL) ||
			pullRequest.HeadRefName != contract.Branch || !strings.EqualFold(pullRequest.State, "OPEN") || pullRequest.MergedAt != nil {
			continue
		}
		evidence.PullRequestURL = pullRequest.URL
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
			evidence.ValidationResult = "passed"
		} else {
			evidence.ValidationResult = "pending_or_failed"
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
	} else if evidence.ValidationResult != "passed" {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification validation has not passed")
	}
	if evidence.PullRequestURL != "" && evidence.WorkPointer == "" {
		evidence.Problems = append(evidence.Problems, "work/current.md does not point to the Bootstrap Verification Issue")
	}
	if evidence.IssueURL != "" && evidence.ProjectItem != "" && evidence.PullRequestURL != "" && evidence.WorkPointer != "" && evidence.ValidationResult == "passed" {
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
	parsed, err := url.Parse(contract.ControlRepositoryURL)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, "github.com") || parsed.User != nil {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: invalid control repository URL")
	}
	slug := strings.Trim(parsed.Path, "/")
	if strings.Count(slug, "/") != 1 {
		return "", fmt.Errorf("AGX-SMOKE-CONTRACT: invalid control repository URL")
	}
	if _, _, err := projectCoordinates(contract.ProjectURL); err != nil {
		return "", err
	}
	return slug, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
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

func projectCoordinates(value string) (string, int, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, "github.com") || parsed.User != nil {
		return "", 0, fmt.Errorf("AGX-SMOKE-CONTRACT: invalid Project URL")
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || (parts[0] != "orgs" && parts[0] != "users") || parts[1] == "" || parts[2] != "projects" {
		return "", 0, fmt.Errorf("AGX-SMOKE-CONTRACT: invalid Project URL")
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil || number <= 0 {
		return "", 0, fmt.Errorf("AGX-SMOKE-CONTRACT: invalid Project URL")
	}
	return parts[1], number, nil
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

func validGitHubURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && strings.EqualFold(parsed.Host, "github.com") && parsed.User == nil
}

// Package smoke defines the versioned first-use contract and the structured
// evidence an Agent must produce before an Installation is considered
// effective. It does not schedule or perform daily work.
package smoke

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strings"
)

const ContractVersionV1 = "agx.first-use/v1"

const (
	StatusAwaiting  = "awaiting"
	StatusEffective = "effective"
)

type Contract struct {
	SchemaVersion          string   `json:"schema_version"`
	InstallationID         string   `json:"installation_id"`
	ProjectURL             string   `json:"project_url"`
	ProjectTitle           string   `json:"project_title"`
	ControlRepositoryURL   string   `json:"control_repository_url"`
	ContractsRepositoryURL string   `json:"contracts_repository_url"`
	Profile                string   `json:"profile"`
	Objective              string   `json:"objective"`
	IssueTitle             string   `json:"issue_title"`
	PullRequestTitle       string   `json:"pull_request_title"`
	Marker                 string   `json:"marker"`
	Branch                 string   `json:"branch"`
	ValidationCommand      string   `json:"validation_command"`
	RequiredActions        []string `json:"required_actions"`
	RequiredOutputs        []string `json:"required_outputs"`
	Cleanup                string   `json:"cleanup"`
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

	issueOutput, err := runner.Run(ctx, "", "gh", "issue", "list", "--repo", slug, "--state", "all", "--limit", "20", "--search", contract.IssueTitle+" in:title", "--json", "number,url,title,body,projectItems")
	if err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-ISSUE: cannot inspect Bootstrap Verification Issue: %w", err)
	}
	var issues []struct {
		URL          string `json:"url"`
		Title        string `json:"title"`
		Body         string `json:"body"`
		ProjectItems []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"projectItems"`
	}
	if err := decodeJSON(issueOutput, &issues); err != nil {
		return Evidence{}, fmt.Errorf("AGX-SMOKE-ISSUE: invalid Issue inventory: %w", err)
	}
	for _, issue := range issues {
		if issue.Title != contract.IssueTitle || !strings.Contains(issue.Body, marker) || !validGitHubURL(issue.URL) {
			continue
		}
		evidence.IssueURL = issue.URL
		for _, item := range issue.ProjectItems {
			if contract.ProjectTitle == "" || item.Title == contract.ProjectTitle {
				evidence.ProjectItem = item.ID
				if evidence.ProjectItem == "" {
					evidence.ProjectItem = item.Title
				}
				break
			}
		}
		break
	}
	if evidence.IssueURL == "" {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification Issue is missing")
	} else if evidence.ProjectItem == "" {
		evidence.Problems = append(evidence.Problems, "Bootstrap Verification Issue is not in the deployment Project")
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
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
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
		for _, file := range pullRequest.Files {
			if file.Path == "work/current.md" {
				changedWorkPointer = true
				break
			}
		}
		checksPassed := len(pullRequest.Checks) > 0
		for _, check := range pullRequest.Checks {
			if !strings.EqualFold(check.Status, "COMPLETED") || !strings.EqualFold(check.Conclusion, "SUCCESS") {
				checksPassed = false
				break
			}
		}
		if checksPassed && bodyHasValidation {
			evidence.ValidationResult = "passed"
		} else {
			evidence.ValidationResult = "pending_or_failed"
		}
		if changedWorkPointer && evidence.IssueURL != "" {
			endpoint := "repos/" + slug + "/contents/work/current.md?ref=" + url.QueryEscape(contract.Branch)
			contentOutput, contentErr := runner.Run(ctx, "", "gh", "api", endpoint)
			if contentErr == nil {
				var content struct {
					Encoding string `json:"encoding"`
					Content  string `json:"content"`
				}
				if decodeJSON(contentOutput, &content) == nil && content.Encoding == "base64" {
					decoded, decodeErr := base64.StdEncoding.DecodeString(strings.ReplaceAll(content.Content, "\n", ""))
					if decodeErr == nil && strings.Contains(string(decoded), evidence.IssueURL) && strings.Contains(string(decoded), marker) {
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
		contract.PullRequestTitle == "" || contract.Marker != "AGX-Installation: "+contract.InstallationID ||
		!strings.HasPrefix(contract.Branch, "agx/bootstrap-verification-") || len(contract.RequiredActions) == 0 ||
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
	return slug, nil
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

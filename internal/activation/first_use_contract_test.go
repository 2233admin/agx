package activation_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/2233admin/agx/internal/activation"
	"github.com/2233admin/agx/internal/smoke"
)

func TestFirstUseContractBindsDeploymentResourcesAndRequiredOutputs(t *testing.T) {
	root := makeInstallation(t)
	providerRunner := newRunner()
	repositoryRunner := newDeploymentRepositoryRunner()
	receipt, _, err := activation.Initialize(context.Background(), deploymentOptions(root, providerRunner, repositoryRunner))
	if err != nil {
		t.Fatal(err)
	}
	contract, err := activation.FirstUseContract(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if contract.SchemaVersion != smoke.ContractVersionV1 || contract.InstallationID != "install-test" ||
		contract.ProjectURL != "https://github.com/orgs/octo-lab/projects/7" ||
		contract.ControlRepositoryURL != "https://github.com/octo-lab/agent-control" ||
		contract.ContractsRepositoryURL != "https://github.com/octo-lab/agent-contracts" ||
		contract.Profile != "core" || contract.Objective != "complete bootstrap verification" ||
		contract.IssueTitle != "Bootstrap Verification [install-test]" ||
		contract.PullRequestTitle != contract.IssueTitle || contract.Marker != "AGX-Installation: install-test" ||
		contract.Branch != "agx/bootstrap-verification-install-test" || len(contract.RequiredActions) != 6 ||
		contract.Cleanup != "operator-owned" {
		t.Fatalf("contract = %+v", contract)
	}
	want := []string{"issue_url", "project_item", "pull_request_url", "validation_result"}
	if !reflect.DeepEqual(contract.RequiredOutputs, want) {
		t.Fatalf("required outputs = %v, want %v", contract.RequiredOutputs, want)
	}
}

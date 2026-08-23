package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/2233admin/agx/internal/exitcode"
	"github.com/2233admin/agx/internal/fleet"
)

// runFleet dispatches the "fleet" command group: plan, apply, and status
// for a Deployment Profile (see internal/fleet and issue #53/#55). It never
// touches installer.Receipt or the Bundle/init lifecycle — a Deployment
// Profile is a separate, additive object persisted at
// .agx/fleet-profile.json, independent of .agx/receipt.json.
func runFleet(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || isHelp(args[0]) {
		return showCommandHelp("fleet", stdout, stderr)
	}
	subcommand, rest := args[0], args[1:]
	switch subcommand {
	case "plan":
		return runFleetPlan(rest, stdout, stderr)
	case "apply":
		return runFleetApply(rest, stdout, stderr)
	case "status":
		return runFleetStatus(rest, stdout, stderr)
	}
	fmt.Fprintf(stderr, "AGX-USAGE-FLEET: unknown fleet subcommand %q; expected plan, apply, or status\n", subcommand)
	return exitcode.Usage
}

func readFleetProfile(path string) (fleet.Profile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return fleet.Profile{}, fmt.Errorf("AGX-FLEET-PROFILE-READ: cannot read %q: %w", path, err)
	}
	return fleet.ParseProfile(data)
}

func runFleetPlan(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--profile": true, "--output": true})
	if err != nil || values["--profile"] == "" || !validOutputMode(values["--output"]) {
		fmt.Fprintln(stderr, "AGX-USAGE-FLEET-PLAN: --profile <deployment-profile.json> [--output human|json]")
		return exitcode.Usage
	}
	profile, err := readFleetProfile(values["--profile"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Data
	}
	plan := fleet.BuildPlan(profile)
	if values["--output"] == "json" {
		return writeJSON(stdout, plan)
	}
	renderFleetPlan(plan, stdout)
	return exitcode.Success
}

func runFleetApply(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--profile": true, "--root": true, "--output": true})
	if err != nil || values["--profile"] == "" || values["--root"] == "" || !validOutputMode(values["--output"]) {
		fmt.Fprintln(stderr, "AGX-USAGE-FLEET-APPLY: --profile <deployment-profile.json> --root <directory> [--output human|json]")
		return exitcode.Usage
	}
	profile, err := readFleetProfile(values["--profile"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Data
	}
	receipt, err := fleet.Apply(values["--root"], profile)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Software
	}
	if values["--output"] == "json" {
		return writeJSON(stdout, receipt)
	}
	fmt.Fprintf(stdout, "Deployment Profile %s configured (Fleet %s, Worker %s).\n", receipt.DeploymentID, receipt.FleetID, receipt.Worker.ID)
	fmt.Fprintf(stdout, "Adapter: %s\n", receipt.Adapter)
	fmt.Fprintf(stdout, "Profile digest: %s\n", receipt.ProfileDigest)
	fmt.Fprintln(stdout, "This is a local configured state, not an external verification.")
	return exitcode.Success
}

func runFleetStatus(args []string, stdout, stderr io.Writer) int {
	values, err := parseNamedOptions(args, map[string]bool{"--root": true, "--output": true})
	if err != nil || values["--root"] == "" || !validOutputMode(values["--output"]) {
		fmt.Fprintln(stderr, "AGX-USAGE-FLEET-STATUS: --root <directory> [--output human|json]")
		return exitcode.Usage
	}
	state, err := fleet.Status(values["--root"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitcode.Data
	}
	if values["--output"] == "json" {
		return writeJSON(stdout, state)
	}
	fmt.Fprintf(stdout, "Deployment Profile status: %s\n", state.Status)
	if state.Receipt != nil {
		fmt.Fprintf(stdout, "Deployment: %s\nFleet: %s\nWorker: %s\nAdapter: %s\n",
			state.Receipt.DeploymentID, state.Receipt.FleetID, state.Receipt.Worker.ID, state.Receipt.Adapter)
	}
	for _, diagnostic := range state.Diagnostics {
		fmt.Fprintf(stdout, "Diagnostic: %s: %s\n", diagnostic.Code, diagnostic.Message)
	}
	fmt.Fprintln(stdout, "configured is a local claim only; it is never equivalent to external verification.")
	return exitcode.Success
}

func renderFleetPlan(plan fleet.Plan, stdout io.Writer) {
	fmt.Fprintln(stdout, "AGX Fleet Deployment Plan")
	fmt.Fprintln(stdout, "")
	fmt.Fprintf(stdout, "Deployment: %s\n", plan.Profile.DeploymentID)
	fmt.Fprintf(stdout, "Fleet: %s\n", plan.Profile.FleetID)
	fmt.Fprintf(stdout, "Worker: %s (%s)\n", plan.Profile.Worker.ID, plan.Profile.Worker.Kind)
	fmt.Fprintf(stdout, "Transport: %s (%s)\n", plan.Profile.Transport.ID, plan.Profile.Transport.Kind)
	fmt.Fprintf(stdout, "Runtime: %s (%s)\n", plan.Profile.Runtime.ID, plan.Profile.Runtime.Kind)
	fmt.Fprintf(stdout, "Work Hub: %s (%s)\n", plan.Profile.WorkHub.ID, plan.Profile.WorkHub.Kind)
	fmt.Fprintf(stdout, "Runtime Bridge: %s (%s)\n", plan.Profile.RuntimeBridge.ID, plan.Profile.RuntimeBridge.Kind)
	if plan.Profile.EvidenceProfile != "" {
		fmt.Fprintf(stdout, "Evidence Profile: %s\n", plan.Profile.EvidenceProfile)
	}
	fmt.Fprintln(stdout, "")
	if len(plan.Diagnostics) > 0 {
		fmt.Fprintln(stdout, "Diagnostics (apply refused until every diagnostic is resolved):")
		for _, diagnostic := range plan.Diagnostics {
			fmt.Fprintf(stdout, "  - %s: %s\n", diagnostic.Code, diagnostic.Message)
		}
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "No external system is contacted and no file is written.")
		return
	}
	fmt.Fprintln(stdout, "Actions:")
	for _, action := range plan.Actions {
		fmt.Fprintf(stdout, "  - %s\n", action)
	}
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "No external system is contacted and no file is written.")
}

func validOutputMode(value string) bool {
	return value == "" || value == "human" || value == "json"
}

func writeJSON(stdout io.Writer, value any) int {
	data, err := json.Marshal(value)
	if err != nil {
		return exitcode.Software
	}
	fmt.Fprintln(stdout, string(data))
	return exitcode.Success
}

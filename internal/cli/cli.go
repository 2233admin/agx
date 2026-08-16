package cli

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/2233admin/agx/internal/contracts"
	"github.com/2233admin/agx/internal/exitcode"
)

type command struct {
	name        string
	description string
}

var lifecycleCommands = []command{
	{name: "init", description: "Initialize an Installation"},
	{name: "plan", description: "Show a side-effect-free Installation Plan"},
	{name: "apply", description: "Apply an approved Plan"},
	{name: "status", description: "Show the observed Installation state"},
	{name: "verify", description: "Verify matching GitHub and Multica evidence"},
	{name: "resume", description: "Resume an interrupted lifecycle operation"},
	{name: "diagnose", description: "Collect local diagnostics"},
	{name: "support-bundle", description: "Create a redacted support bundle"},
	{name: "upgrade", description: "Upgrade an Installation"},
	{name: "rollback", description: "Rollback an Installation"},
	{name: "uninstall", description: "Remove AGX-owned Installation resources"},
}

func Run(args []string, version string, stdout, stderr io.Writer) int {
	if len(args) == 0 || isHelp(args[0]) {
		if len(args) > 1 {
			return showCommandHelp(args[1], stdout, stderr)
		}
		printGlobalHelp(stdout)
		return exitcode.Success
	}

	commandName := args[0]
	if len(args) > 1 && isHelp(args[1]) {
		return showCommandHelp(commandName, stdout, stderr)
	}

	switch commandName {
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "agx %s\n", version)
		return exitcode.Success
	case "plan":
		return runPlan(args[1:], stdout, stderr)
	case "task", "tasks":
		fmt.Fprintln(stderr, "AGX-UNSUPPORTED-TASK: AGX does not create, assign, or schedule daily Tasks")
		return exitcode.Unsupported
	}

	if knownLifecycleCommand(commandName) {
		fmt.Fprintf(stderr, "AGX-UNSUPPORTED-COMMAND: %q is not implemented in this preview\n", commandName)
		return exitcode.Unsupported
	}

	fmt.Fprintf(stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", commandName)
	return exitcode.Software
}

type planOptions struct {
	contractPath string
	output       string
}

func runPlan(args []string, stdout, stderr io.Writer) int {
	options, err := parsePlanOptions(args)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-USAGE-PLAN: %v\n", err)
		return exitcode.Usage
	}
	data, err := os.ReadFile(options.contractPath)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-CONTRACT-READ: cannot read %q: %v\n", options.contractPath, err)
		return exitcode.Data
	}
	document, err := contracts.Decode(data)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-CONTRACT-INVALID: %v\n", err)
		return exitcode.Data
	}

	if options.output == "json" {
		encoded, err := contracts.Encode(document)
		if err != nil {
			fmt.Fprintf(stderr, "AGX-CONTRACT-INVALID: %v\n", err)
			return exitcode.Data
		}
		fmt.Fprintln(stdout, string(encoded))
		return exitcode.Success
	}

	renderPlan(document, stdout)
	return exitcode.Success
}

func parsePlanOptions(args []string) (planOptions, error) {
	options := planOptions{output: "human"}
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--contract":
			if index+1 == len(args) || options.contractPath != "" {
				return planOptions{}, fmt.Errorf("provide exactly one --contract <path>")
			}
			index++
			options.contractPath = args[index]
		case "--output":
			if index+1 == len(args) {
				return planOptions{}, fmt.Errorf("--output requires human or json")
			}
			index++
			options.output = args[index]
			if options.output != "human" && options.output != "json" {
				return planOptions{}, fmt.Errorf("--output must be human or json")
			}
		default:
			return planOptions{}, fmt.Errorf("unknown plan option %q", args[index])
		}
	}
	if options.contractPath == "" {
		return planOptions{}, fmt.Errorf("--contract <path> is required")
	}
	return options, nil
}

func renderPlan(document contracts.Document, stdout io.Writer) {
	desired := document.Contract.Desired
	plan := document.Contract.Plan

	fmt.Fprintln(stdout, "AGX Installation Plan")
	fmt.Fprintln(stdout, "")
	fmt.Fprintf(stdout, "Installation: %s\n", desired.InstallationID)
	fmt.Fprintf(stdout, "Bundle: %s\n", desired.BundleID)
	fmt.Fprintf(stdout, "Desired hash: %s\n", desired.DesiredHash)
	fmt.Fprintln(stdout, "Steps:")
	if len(plan.Steps) == 0 {
		fmt.Fprintln(stdout, "  (none)")
	}
	for _, step := range plan.Steps {
		fmt.Fprintf(stdout, "  - %s: %s (risk: %s; compensation: %s)\n", step.ID, step.Kind, step.Risk, step.Compensation)
	}
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "No external system is contacted and no contract file is changed.")
}

func printGlobalHelp(stdout io.Writer) {
	fmt.Fprintln(stdout, "AGXCLI — installation and lifecycle CLI")
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Usage:")
	fmt.Fprintln(stdout, "  agx <command>")
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Available now:")
	fmt.Fprintln(stdout, "  help       Show command help")
	fmt.Fprintln(stdout, "  version    Show the build version")
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Lifecycle commands (safe placeholders):")
	for _, command := range lifecycleCommands {
		fmt.Fprintf(stdout, "  %-15s %s\n", command.name, command.description)
	}
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "AGX does not create, assign, or schedule daily Tasks.")
}

func showCommandHelp(commandName string, stdout, stderr io.Writer) int {
	if commandName == "version" {
		fmt.Fprintln(stdout, "Usage: agx version")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "Print the build version. No external system is contacted.")
		return exitcode.Success
	}
	if command, ok := lookupLifecycleCommand(commandName); ok {
		fmt.Fprintf(stdout, "Usage: agx %s [options]\n", command.name)
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, command.description+".")
		fmt.Fprintln(stdout, "Status: unavailable in this preview. No external system is contacted.")
		return exitcode.Success
	}
	if commandName == "task" || commandName == "tasks" {
		fmt.Fprintln(stdout, "AGX does not create, assign, or schedule daily Tasks.")
		return exitcode.Success
	}
	fmt.Fprintf(stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", commandName)
	return exitcode.Software
}

func isHelp(value string) bool {
	return value == "help" || value == "--help" || value == "-h"
}

func knownLifecycleCommand(name string) bool {
	_, ok := lookupLifecycleCommand(name)
	return ok
}

func lookupLifecycleCommand(name string) (command, bool) {
	for _, command := range lifecycleCommands {
		if strings.EqualFold(command.name, name) {
			return command, true
		}
	}
	return command{}, false
}

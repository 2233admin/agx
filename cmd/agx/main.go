package main

import (
	"fmt"
	"io"
	"os"
)

const version = "0.0.0-dev"

func main() {
	if exitCode := run(os.Args[1:], os.Stdout, os.Stderr); exitCode != 0 {
		os.Exit(exitCode)
	}
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printHelp(stdout)
		return 0
	}

	switch args[0] {
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "agx %s\n", version)
		return 0
	case "mascot":
		fmt.Fprint(stdout, mascotText)
		return 0
	default:
		fmt.Fprintf(stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", args[0])
		return 70
	}
}

func printHelp(output io.Writer) {
	fmt.Fprintln(output, `AGXCLI — installation and lifecycle CLI

Usage:
  agx <command>

Available now:
  help       Show this help
  version    Show the development version
  mascot     Show the terminal-safe AGX OC identity

Planned:
  init, plan, apply, status, verify, resume, diagnose,
  support-bundle, upgrade, rollback, uninstall`)
}

const mascotText = ` /\_/\\
( o.o )  AGXCLI coordination console
 > ^ <   identity only; use command receipts for state
`

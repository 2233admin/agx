package main

import (
	"fmt"
	"os"
)

var version = "0.0.0-dev"

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printHelp()
		return
	}

	switch args[0] {
	case "version", "--version", "-v":
		fmt.Printf("agx %s\n", version)
	default:
		fmt.Fprintf(os.Stderr, "AGX-INVALID-INVOCATION: unknown command %q\n", args[0])
		os.Exit(70)
	}
}

func printHelp() {
	fmt.Println(`AGXCLI — installation and lifecycle CLI

Usage:
  agx <command>

Available now:
  help       Show this help
  version    Show the development version

Planned:
  init, plan, apply, status, verify, resume, diagnose,
  support-bundle, upgrade, rollback, uninstall`)
}

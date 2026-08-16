package main

import (
	"io"
	"os"

	"github.com/2233admin/agx/internal/cli"
)

var version = "0.0.0-dev"

func main() {
	if exitCode := run(os.Args[1:], os.Stdout, os.Stderr); exitCode != 0 {
		os.Exit(exitCode)
	}
}

func run(args []string, stdout, stderr io.Writer) int {
	return cli.Run(args, version, stdout, stderr)
}

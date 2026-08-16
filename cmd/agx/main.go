package main

import (
	"os"

	"github.com/2233admin/agx/internal/cli"
)

const version = "0.0.0-dev"

func main() {
	os.Exit(cli.Run(os.Args[1:], version, os.Stdout, os.Stderr))
}

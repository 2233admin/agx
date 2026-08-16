package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestDevelopmentVersionIsPresent(t *testing.T) {
	if version == "" {
		t.Fatal("version must not be empty")
	}
}

func TestMascotCommandIsTerminalSafeIdentity(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	if exitCode := run([]string{"mascot"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(mascot) exit code = %d, want 0", exitCode)
	}
	if stderr.Len() != 0 {
		t.Fatalf("run(mascot) stderr = %q, want empty", stderr.String())
	}
	if !strings.Contains(stdout.String(), "AGXCLI coordination console") {
		t.Fatalf("run(mascot) output = %q, want AGXCLI identity", stdout.String())
	}
	if strings.Contains(stdout.String(), "\x1b[") {
		t.Fatalf("run(mascot) output contains ANSI escape sequence: %q", stdout.String())
	}
}

func TestHelpListsMascotCommand(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	if exitCode := run([]string{"help"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help) exit code = %d, want 0", exitCode)
	}
	if !strings.Contains(stdout.String(), "mascot     Show the terminal-safe AGX OC identity") {
		t.Fatalf("run(help) output = %q, want mascot command", stdout.String())
	}
}

package configs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/2233admin/agx/internal/exitcode"
	installer "github.com/2233admin/agx/internal/install"
)

type ProcessRunner interface {
	Run(ctx context.Context, executable string, args []string, env []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int
}

type OSProcessRunner struct {
	Dir string
}

func (runner OSProcessRunner) Run(ctx context.Context, executable string, args []string, env []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	command := exec.CommandContext(ctx, executable, args...)
	command.Env = env
	command.Dir = runner.Dir
	command.Stdin = stdin
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			fmt.Fprintf(stderr, "AGX-CONFIG-RUNTIME: runtime canceled: %v\n", ctx.Err())
			return exitcode.Software
		}
		if exitError, ok := err.(*exec.ExitError); ok && exitError.ProcessState != nil && exitError.ProcessState.ExitCode() >= 0 {
			return exitError.ProcessState.ExitCode()
		}
		fmt.Fprintf(stderr, "AGX-CONFIG-RUNTIME: runtime failed to start or was terminated: %v\n", err)
		return exitcode.Software
	}
	return exitcode.Success
}

func Run(ctx context.Context, root string, receipt installer.Receipt, args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	if receipt.ConfigsRuntime == nil {
		fmt.Fprintln(stderr, "AGX-CONFIG-RUNTIME: installation has no bound configs runtime")
		return exitcode.Software
	}
	if strings.TrimSpace(root) == "" {
		fmt.Fprintln(stderr, "AGX-CONFIG-RUNTIME: --root is required")
		return exitcode.Usage
	}
	state, err := installer.Status(root)
	if err != nil || state.Phase != "configured" || state.Receipt == nil || state.Receipt.ConfigsRuntime == nil {
		fmt.Fprintf(stderr, "AGX-CONFIG-RUNTIME: installation runtime binding is not intact\n")
		return exitcode.Software
	}
	binding := state.Receipt.ConfigsRuntime
	if binding.Path != receipt.ConfigsRuntime.Path || binding.ContentSHA256 != receipt.ConfigsRuntime.ContentSHA256 {
		fmt.Fprintln(stderr, "AGX-CONFIG-RUNTIME: receipt runtime binding mismatch")
		return exitcode.Software
	}
	rootAbs, executable, err := resolveExecutable(root, binding.Path)
	if err != nil {
		fmt.Fprintf(stderr, "AGX-CONFIG-RUNTIME: %v\n", err)
		return exitcode.Software
	}
	fileInfo, err := os.Lstat(executable)
	if err != nil || !fileInfo.Mode().IsRegular() || fileInfo.Mode()&os.ModeSymlink != 0 {
		fmt.Fprintln(stderr, "AGX-CONFIG-RUNTIME: bound executable is missing or unsafe")
		return exitcode.Software
	}
	digest, err := digestFile(executable)
	if err != nil || digest != binding.ContentSHA256 || binding.AssetSHA256 != binding.ContentSHA256 {
		fmt.Fprintln(stderr, "AGX-CONFIG-RUNTIME: bound executable digest mismatch")
		return exitcode.Software
	}
	databaseDir := filepath.Join(rootAbs, ".agx", "configs")
	if err := os.MkdirAll(databaseDir, 0o700); err != nil {
		fmt.Fprintf(stderr, "AGX-CONFIG-RUNTIME: cannot prepare runtime state directory: %v\n", err)
		return exitcode.Software
	}
	databasePath := filepath.Join(databaseDir, "control-plane.sqlite3")
	env := append(os.Environ(), "CONTROL_PLANE_DB_PATH="+databasePath)
	return OSProcessRunner{Dir: rootAbs}.Run(ctx, executable, args, env, stdin, stdout, stderr)
}

func resolveExecutable(root, relative string) (string, string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", "", err
	}
	if relative == "" || filepath.IsAbs(relative) || filepath.VolumeName(relative) != "" {
		return "", "", fmt.Errorf("bound executable path is not relative")
	}
	executable := filepath.Join(rootAbs, filepath.FromSlash(relative))
	back, err := filepath.Rel(rootAbs, executable)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("bound executable path escapes installation root")
	}
	return rootAbs, executable, nil
}

func digestFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

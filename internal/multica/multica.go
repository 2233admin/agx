// Package multica reads verification evidence back from a Multica deployment.
//
// It is an optional adapter, outside the AGX 0.1 release (see AGENTS.md). It
// speaks only to the official `multica` CLI with structured JSON output; it
// never calls the Multica HTTP API directly, never reads Multica configuration
// files, and never touches credentials.
//
// Scope boundary: this package answers "does Multica independently observe the
// evidence the caller names?" It deliberately does NOT decide *what* counts as
// evidence for an Installation. That mapping is a product decision and lives
// with the caller, which passes the evidence locator in. Inventing it here
// would let AGX manufacture agreement between the two sides it is supposed to
// cross-check.
package multica

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"github.com/2233admin/agx/internal/domain"
)

// Binary is the official CLI this adapter is allowed to invoke.
const Binary = "multica"

// Runner is the injectable exec seam, mirroring provider.Runner so tests can
// supply recorded CLI output instead of touching a live deployment.
type Runner interface {
	LookPath(name string) (string, error)
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type OSRunner struct{}

func (OSRunner) LookPath(name string) (string, error) {
	return exec.LookPath(name)
}

func (OSRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.Output()
	if err != nil {
		// Deliberately does not include stderr: Multica CLI errors can echo
		// back tokens supplied through the environment, and AGENTS.md keeps
		// credentials out of logs and receipts.
		return nil, fmt.Errorf("multica command %q failed: %w", strings.Join(args, " "), err)
	}
	return output, nil
}

// ErrAbsent reports that Multica does not observe the named evidence. It is a
// verification answer, not a transport failure: the caller must map it to
// "not verified", never to "verified".
var ErrAbsent = fmt.Errorf("multica evidence absent")

// ErrAmbiguous reports that more than one Multica object matched the locator.
// Ambiguous evidence must never verify — AGX cannot tell which object the
// Installation actually produced.
var ErrAmbiguous = fmt.Errorf("multica evidence ambiguous")

// ErrNotOnline reports that the evidence exists but Multica does not currently
// observe it as live.
var ErrNotOnline = fmt.Errorf("multica evidence not online")

type runtimeEntry struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// Available reports whether the official CLI is on PATH. It performs no
// deployment I/O.
func Available(runner Runner) bool {
	_, err := runner.LookPath(Binary)
	return err == nil
}

// RuntimeReadback asks Multica whether it independently observes a runtime
// named runtimeName, and converts that observation into a domain.Readback.
//
// The runtime is the natural Multica-side artefact of an AGX installation:
// AGX activates Codex/Claude on a machine, and Multica registers the resulting
// runtimes. The caller names which runtime is the evidence for this
// Installation; this function only reports what Multica says about it.
//
// Returns ErrAbsent, ErrAmbiguous or ErrNotOnline when Multica's answer does
// not support verification. Per AGENTS.md the caller must report `configured`
// rather than `verified` in every one of those cases.
func RuntimeReadback(
	ctx context.Context,
	installationID domain.InstallationID,
	runtimeName string,
	runner Runner,
) (domain.Readback, error) {
	if installationID == "" {
		return domain.Readback{}, fmt.Errorf("installation ID is required")
	}
	if strings.TrimSpace(runtimeName) == "" {
		return domain.Readback{}, fmt.Errorf("runtime name is required")
	}
	if _, err := runner.LookPath(Binary); err != nil {
		return domain.Readback{}, fmt.Errorf("official %q CLI not found on PATH: %w", Binary, err)
	}

	output, err := runner.Run(ctx, Binary, "runtime", "list", "--output", "json")
	if err != nil {
		return domain.Readback{}, err
	}

	entries, err := parseRuntimes(output)
	if err != nil {
		return domain.Readback{}, err
	}

	matches := make([]runtimeEntry, 0, 1)
	for _, entry := range entries {
		if entry.Name == runtimeName {
			matches = append(matches, entry)
		}
	}

	switch len(matches) {
	case 0:
		return domain.Readback{}, fmt.Errorf("%w: no runtime named %q", ErrAbsent, runtimeName)
	case 1:
	default:
		return domain.Readback{}, fmt.Errorf("%w: %d runtimes named %q", ErrAmbiguous, len(matches), runtimeName)
	}

	match := matches[0]
	if match.ID == "" {
		return domain.Readback{}, fmt.Errorf("%w: runtime %q has no id", ErrAbsent, runtimeName)
	}
	if match.Status != "online" {
		return domain.Readback{}, fmt.Errorf("%w: runtime %q is %q", ErrNotOnline, runtimeName, match.Status)
	}

	return domain.Readback{
		Source:         domain.ReadbackSourceMultica,
		InstallationID: installationID,
		EvidenceID:     match.ID,
	}, nil
}

// parseRuntimes accepts both shapes the CLI emits: a bare array, or an object
// wrapping the array under "runtimes". Anything else is rejected rather than
// guessed at — a misread runtime list would fabricate verification evidence.
func parseRuntimes(data []byte) ([]runtimeEntry, error) {
	var direct []runtimeEntry
	if err := strictJSON(data, &direct); err == nil {
		// A bare `null` decodes cleanly into a nil slice. Returning it here
		// would surface an unsupported CLI shape as ErrAbsent -- "could not
		// read" masquerading as "not there", which is the one confusion this
		// package exists to prevent.
		if direct == nil {
			return nil, fmt.Errorf("unrecognised `multica runtime list --output json` shape: top-level null")
		}
		return direct, nil
	}

	var wrapped struct {
		Runtimes []runtimeEntry `json:"runtimes"`
	}
	if err := strictJSON(data, &wrapped); err != nil {
		return nil, fmt.Errorf("unrecognised `multica runtime list --output json` shape: %w", err)
	}
	if wrapped.Runtimes == nil {
		return nil, fmt.Errorf("unrecognised `multica runtime list --output json` shape: no runtimes key")
	}
	return wrapped.Runtimes, nil
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return fmt.Errorf("trailing JSON value")
	} else if err != io.EOF {
		return err
	}
	return nil
}

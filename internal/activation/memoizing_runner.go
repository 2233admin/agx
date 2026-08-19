package activation

import (
	"context"
	"strings"

	"github.com/2233admin/agx/internal/repository"
)

// memoizingRunner shares read-only command results for one status/diagnose
// operation. Commands outside the explicit read-only allowlist always reach
// the underlying runner and are never admitted to the cache.
type memoizingRunner struct {
	underlying repository.Runner
	results    map[memoizingRunnerKey]memoizingRunnerResult
}

type memoizingRunnerKey struct {
	dir  string
	name string
	args string
}

type memoizingRunnerResult struct {
	output []byte
	err    error
}

func newMemoizingRunner(runner repository.Runner) *memoizingRunner {
	if runner == nil {
		runner = repository.OSRunner{}
	}
	return &memoizingRunner{
		underlying: runner,
		results:    make(map[memoizingRunnerKey]memoizingRunnerResult),
	}
}

func (r *memoizingRunner) LookPath(name string) (string, error) {
	return r.underlying.LookPath(name)
}

func (r *memoizingRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	if !memoizingReadCommand(name, args) {
		return r.underlying.Run(ctx, dir, name, args...)
	}

	key := memoizingRunnerKey{dir: dir, name: name, args: strings.Join(args, "\x00")}
	if result, ok := r.results[key]; ok {
		return append([]byte(nil), result.output...), result.err
	}
	output, err := r.underlying.Run(ctx, dir, name, args...)
	r.results[key] = memoizingRunnerResult{output: append([]byte(nil), output...), err: err}
	return output, err
}

func memoizingReadCommand(name string, args []string) bool {
	switch name {
	case "git":
		return len(args) >= 1 && args[0] == "rev-parse"
	case "gh":
		if len(args) < 2 {
			return false
		}
		switch {
		case args[0] == "repo" && args[1] == "view":
			return true
		case args[0] == "auth" && args[1] == "status":
			return true
		case args[0] == "issue" && args[1] == "list":
			return true
		case args[0] == "pr" && args[1] == "list":
			return true
		case args[0] == "project" && (args[1] == "list" || args[1] == "item-list"):
			return true
		case args[0] == "project" && args[1] == "view":
			return true
		case args[0] == "api":
			return memoizingGitHubAPIRead(args[2:])
		}
	}
	return false
}

func memoizingGitHubAPIRead(args []string) bool {
	for i, arg := range args {
		if arg == "--input" || arg == "--field" || arg == "-f" || arg == "--raw-field" || arg == "-F" {
			return false
		}
		if (arg == "--method" || arg == "-X") && i+1 < len(args) {
			return strings.EqualFold(args[i+1], "GET")
		}
		if strings.HasPrefix(arg, "--method=") {
			return strings.EqualFold(strings.TrimPrefix(arg, "--method="), "GET")
		}
		if strings.HasPrefix(arg, "-X") && len(arg) > 2 {
			return strings.EqualFold(arg[2:], "GET")
		}
	}
	return true
}

func memoizeGitHubEvidenceCollector(collector EvidenceCollector, runner repository.Runner) EvidenceCollector {
	switch collector := collector.(type) {
	case githubEvidenceCollector:
		collector.runner = runner
		return collector
	case *githubEvidenceCollector:
		copy := *collector
		copy.runner = runner
		return &copy
	default:
		return collector
	}
}

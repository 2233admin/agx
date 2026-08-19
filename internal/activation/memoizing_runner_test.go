package activation

import (
	"context"
	"testing"
)

type countingMemoRunner struct {
	runCalls int
}

func (r *countingMemoRunner) LookPath(string) (string, error) { return "gh", nil }

func (r *countingMemoRunner) Run(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
	r.runCalls++
	return []byte("result"), nil
}

func TestMemoizingRunnerCachesOnlyKnownReadCommands(t *testing.T) {
	underlying := &countingMemoRunner{}
	runner := newMemoizingRunner(underlying)

	for i := 0; i < 2; i++ {
		if _, err := runner.Run(context.Background(), "", "gh", "repo", "view", "octo-lab/agent-control"); err != nil {
			t.Fatalf("read command error = %v", err)
		}
	}
	if _, err := runner.Run(context.Background(), "", "gh", "repo", "create", "octo-lab/new"); err != nil {
		t.Fatalf("mutating command error = %v", err)
	}
	if _, err := runner.Run(context.Background(), "", "gh", "repo", "create", "octo-lab/new"); err != nil {
		t.Fatalf("mutating command error = %v", err)
	}
	if _, err := runner.Run(context.Background(), "", "gh", "api", "repos/octo-lab/agent-control", "--method", "POST"); err != nil {
		t.Fatalf("mutating API error = %v", err)
	}

	if underlying.runCalls != 4 {
		t.Fatalf("underlying Run calls = %d, want 4 (one cached read plus three uncached mutations)", underlying.runCalls)
	}
}

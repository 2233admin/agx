package bundle_test

import (
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
)

func TestProductionPackageHasNoExternalEffects(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("Glob() error = %v", err)
	}
	banned := map[string]bool{
		"os": true, "os/exec": true, "io": true, "io/fs": true,
		"net": true, "net/http": true, "path/filepath": true,
	}
	for _, file := range files {
		if filepath.Ext(file) != ".go" || filepath.Base(file) == "purity_test.go" || filepath.Base(file) == "bundle_test.go" {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("ParseFile(%q) error = %v", file, err)
		}
		for _, spec := range parsed.Imports {
			path := spec.Path.Value[1 : len(spec.Path.Value)-1]
			if banned[path] {
				t.Errorf("%s imports effectful package %q", file, path)
			}
		}
	}
}
